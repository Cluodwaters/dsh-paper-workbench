import { connectHarness, openWorkbench } from "../harness-bridge.js";
import { api } from "../persistence-client.js";
import { normalizeLibraryQuery } from "../shared/library-query.mjs";
import { termKey } from "../shared/bibliography.mjs";
import { $, toast, downloadJSON, modal, esc } from "./dom.js";
import {
  renderRows,
  renderSelection,
  renderCounts,
  renderSaved,
  renderFilters,
} from "./views.js";
import { MetadataEditor } from "./editor.js";
import {
  saveCollection,
  manageCollection,
  batchEdit,
  manageAliases,
  importFiles,
} from "./actions.js";

const state = {
  query: normalizeLibraryQuery(),
  offset: 0,
  limit: 100,
  selectedId: null,
  checked: new Set(),
  savedId: null,
  labels: new Map(),
  rows: [],
  searches: [],
};
let info,
  editor,
  queryToken = 0,
  itemToken = 0,
  queryTimer,
  attachTarget = null;
function queueRefresh() {
  clearTimeout(queryTimer);
  queryTimer = setTimeout(() => refresh(), 180);
}
function persistQuery() {
  sessionStorage.setItem(
    "paper-workbench:query:" + info.libraryId,
    JSON.stringify({ query: state.query, savedId: state.savedId }),
  );
}
function displayQueryName() {
  const current = state.searches.find((search) => search.id === state.savedId);
  $("view-title").textContent =
    current?.name ||
    (state.query.archived
      ? "回收站"
      : state.query.favoriteOnly
        ? "收藏文献"
        : state.query.needsMetadata
          ? "待补全文献"
          : state.query.readingStatuses.length === 1 &&
              state.query.readingStatuses[0] === "unread"
            ? "未读文献"
            : "全部文献");
  $("update-query").hidden =
    !current || JSON.stringify(current.query) === JSON.stringify(state.query);
}
async function refresh() {
  const token = ++queryToken;
  $("query-status").textContent = "检索中…";
  try {
    const query = normalizeLibraryQuery(state.query);
    const result = await api("/api/library/search", {
      query,
      page: { offset: state.offset, limit: state.limit },
    });
    if (token !== queryToken) return;
    if (state.offset > 0 && state.offset >= result.total) {
      state.offset = Math.max(
        0,
        Math.floor((result.total - 1) / state.limit) * state.limit,
      );
      return refresh();
    }
    state.query = result.query;
    state.rows = result.items;
    // Batch actions apply only to visible, explicitly selected rows.
    const visible = new Set(state.rows.map((item) => item.id));
    state.checked = new Set([...state.checked].filter((id) => visible.has(id)));
    renderRows(result, state);
    renderCounts(result.counts);
    renderFilters(result, state);
    displayQueryName();
    persistQuery();
    $("query-status").textContent = "本地资料库";
    $("result-error").hidden = true;
    document
      .querySelectorAll("[data-view]")
      .forEach((button) =>
        button.classList.toggle(
          "active",
          button.dataset.view === currentView(),
        ),
      );
    $("trash-selected").textContent = state.query.archived
      ? "恢复所选"
      : "移入回收站";
  } catch (error) {
    if (token !== queryToken) return;
    $("query-status").textContent = "检索未完成";
    $("result-error").textContent = error.message;
    $("result-error").hidden = false;
  }
}
function currentView() {
  return state.savedId
    ? ""
    : state.query.archived
      ? "trash"
      : state.query.favoriteOnly
        ? "favorites"
        : state.query.needsMetadata
          ? "needs"
          : state.query.readingStatuses.length === 1 &&
              state.query.readingStatuses[0] === "unread"
            ? "unread"
            : "all";
}
function changed() {
  queryToken++;
  state.offset = 0;
  clearSelection();
  queueRefresh();
}
async function selectItem(id, { editing = false } = {}) {
  if (editor.saving) {
    toast("信息正在保存，请稍后切换");
    return;
  }
  const token = ++itemToken;
  state.selectedId = id;
  document
    .querySelectorAll("#table-body tr")
    .forEach((row) => row.classList.toggle("selected", row.dataset.id === id));
  try {
    const item = await api(`/api/library/items/${id}`);
    if (token !== itemToken) return;
    editor.show(item, { editing });
    $("details").classList.add("mobile-open");
  } catch (error) {
    toast(error.message, true);
  }
}
async function reloadSearches() {
  state.searches = await api("/api/library/searches");
  renderSaved(state.searches, state.savedId);
  displayQueryName();
}
function clearSelection() {
  state.checked.clear();
  $("table-body")
    .querySelectorAll("[data-check]:checked")
    .forEach((input) => (input.checked = false));
  renderSelection(state);
}
function selectedRows() {
  return state.rows.filter((item) => state.checked.has(item.id));
}
async function setArchived(items, archived) {
  if (!items.length) return;
  const includes = (id) => items.some((item) => item.id === id);
  if (includes(editor.item?.id) && (editor.saving || editor.isDirty())) {
    toast("请先保存或重新载入当前文献信息，再操作回收站。", true);
    return;
  }
  const action = archived ? "移入回收站" : "恢复到文献库";
  const subject =
    items.length === 1
      ? `「${esc(items[0].metadata?.title ?? items[0].title)}」`
      : `${items.length} 条文献`;
  const command = {
    requestId: crypto.randomUUID(),
    items: items.map((item) => ({
      id: item.id,
      expectedRevision: item.revision,
    })),
    changes: { archived },
  };
  const result = await modal({
    title: action,
    confirm: action,
    content: `<p>${subject}将${action}。${archived ? "PDF 和批注会保留，可随时恢复。" : ""}</p>`,
    async onSubmit(_data, dialog) {
      const closeButtons = dialog.querySelectorAll("[data-close]");
      const preventCancel = (event) => event.preventDefault();
      closeButtons.forEach((button) => (button.disabled = true));
      dialog.addEventListener("cancel", preventCancel);
      try {
        return await api("/api/library/batch", command);
      } catch (error) {
        if (error.code !== "METADATA_CONFLICT") throw error;
        await refresh();
        if (includes(state.selectedId) && !editor.isDirty())
          await selectItem(state.selectedId);
        throw new Error("文献信息已更新。请关闭对话框，核对后重试。");
      } finally {
        closeButtons.forEach((button) => (button.disabled = false));
        dialog.removeEventListener("cancel", preventCancel);
      }
    },
  });
  if (!result) return;
  for (const item of items) state.checked.delete(item.id);
  if (includes(state.selectedId) && !editor.isDirty()) {
    state.selectedId = null;
    itemToken++;
    editor.clear();
    $("details").classList.remove("mobile-open");
  }
  await refresh();
  toast(
    archived
      ? `已将 ${result.count} 条文献移入回收站`
      : `已恢复 ${result.count} 条文献`,
  );
}
async function doImport(files) {
  const target = attachTarget;
  attachTarget = null;
  await importFiles(files, {
    itemId: target,
    maxBytes: info.maxPdfBytes,
    exclusions: info.importExclusions,
    onComplete: async (first) => {
      if (first && !target) {
        state.query = normalizeLibraryQuery();
        state.savedId = null;
        state.offset = 0;
        $("search").value = "";
        renderSaved(state.searches, null);
      }
      await refresh();
      if (first) await selectItem(first);
    },
  });
}
function bind() {
  $("search-scope").addEventListener("change", (event) => {
    state.query.scope = event.target.value;
    changed();
  });
  $("cite-selected").addEventListener("click", () =>
    openWorkbench(
      "/tools.html?items=" +
        encodeURIComponent([...state.checked].join(",")) +
        "#citations",
      "_blank",
    ),
  );
  $("search").addEventListener("input", (event) => {
    state.query.text = event.target.value;
    changed();
  });
  $("search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      clearTimeout(queryTimer);
      refresh();
    }
  });
  $("sidebar").addEventListener("click", async (event) => {
    const view = event.target.closest("[data-view]"),
      saved = event.target.closest("[data-saved]"),
      menu = event.target.closest("[data-search-menu]");
    if (view) {
      event.currentTarget.classList.remove("mobile-open");
      state.savedId = null;
      state.query = normalizeLibraryQuery({
        archived: view.dataset.view === "trash",
        needsMetadata: view.dataset.view === "needs",
        favoriteOnly: view.dataset.view === "favorites",
        readingStatuses: view.dataset.view === "unread" ? ["unread"] : [],
      });
      $("search").value = "";
      renderSaved(state.searches, null);
      changed();
    }
    if (saved) {
      const item = state.searches.find((x) => x.id === saved.dataset.saved);
      state.savedId = item.id;
      state.query = structuredClone(item.query);
      $("search").value = state.query.text;
      renderSaved(state.searches, item.id);
      changed();
    }
    if (menu) {
      const item = state.searches.find((x) => x.id === menu.dataset.searchMenu);
      const result = await manageCollection(item);
      if (result) {
        if (result.deleted === state.savedId) state.savedId = null;
        await reloadSearches();
      }
    }
  });
  $("facets").addEventListener("change", (event) => {
    const element = event.target;
    if (element.dataset.dimension) {
      const key = element.dataset.dimension;
      state.query[key] = element.checked
        ? [...state.query[key], element.value]
        : state.query[key].filter((x) => x !== element.value);
    }
    if (element.dataset.year)
      state.query.year[element.dataset.year] = element.value || null;
    if (element.hasAttribute("data-undated"))
      state.query.year.undatedOnly = element.checked;
    if (element.dataset.queryField)
      state.query[element.dataset.queryField] = element.value;
    if (
      element.dataset.dimension ||
      element.dataset.year ||
      element.hasAttribute("data-undated") ||
      element.dataset.queryField
    )
      changed();
  });
  $("facets").addEventListener("input", (event) => {
    const dimension = event.target.dataset.facetSearch;
    if (dimension) {
      const q = event.target.value.toLowerCase();
      $("facets")
        .querySelectorAll(`[data-facet-options="${dimension}"] [data-label]`)
        .forEach((label) => (label.hidden = !label.dataset.label.includes(q)));
    }
  });
  $("query-chips").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-kind]");
    if (!button) return;
    const kind = button.dataset.removeKind,
      value = button.dataset.removeValue;
    if (kind === "year")
      state.query.year = { from: null, to: null, undatedOnly: false };
    else if (kind === "text") {
      state.query.text = "";
      $("search").value = "";
    } else if (Array.isArray(state.query[kind]))
      state.query[kind] = state.query[kind].filter((x) => x !== value);
    else state.query[kind] = false;
    changed();
  });
  $("clear-filters").addEventListener("click", () => {
    const archived = state.query.archived;
    state.query = normalizeLibraryQuery({ archived });
    state.savedId = null;
    $("search").value = "";
    renderSaved(state.searches, null);
    changed();
  });
  $("sort").addEventListener("change", (event) => {
    const [field, direction] = event.target.value.split(":");
    state.query.sort = { field, direction };
    changed();
  });
  $("previous-page").addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - state.limit);
    clearSelection();
    refresh();
  });
  $("next-page").addEventListener("click", () => {
    state.offset += state.limit;
    clearSelection();
    refresh();
  });
  $("table-body").addEventListener("click", (event) => {
    const check = event.target.closest("[data-check]");
    if (check) {
      check.checked
        ? state.checked.add(check.dataset.check)
        : state.checked.delete(check.dataset.check);
      renderSelection(state);
      return;
    }
    if (event.target.closest("a")) return;
    const row = event.target.closest("[data-id]");
    if (row) selectItem(row.dataset.id);
  });
  $("select-all").addEventListener("change", (event) => {
    state.checked = new Set(
      event.target.checked ? state.rows.map((x) => x.id) : [],
    );
    document
      .querySelectorAll("[data-check]")
      .forEach((x) => (x.checked = event.target.checked));
    renderSelection(state);
  });
  $("clear-selection").addEventListener("click", clearSelection);
  $("batch-edit").addEventListener("click", async () => {
    try {
      const result = await batchEdit(selectedRows());
      if (result) {
        toast(`已更新 ${result.count} 条文献`);
        await refresh();
        if (state.selectedId && !editor.isDirty())
          await selectItem(state.selectedId);
      }
    } catch (error) {
      toast(error.message, true);
    }
  });
  $("trash-selected").addEventListener("click", () => {
    const rows = selectedRows();
    if (rows.length) return setArchived(rows, !rows[0].archivedAt);
  });
  $("new-item").addEventListener("click", () => {
    if (editor.saving) return;
    state.selectedId = null;
    itemToken++;
    editor.show(null, { editing: true });
    $("details").classList.add("mobile-open");
  });
  $("save-query").addEventListener("click", async () => {
    const result = await saveCollection(state.query);
    if (result) {
      state.savedId = result.id;
      await reloadSearches();
      persistQuery();
      toast("智能集合已保存");
    }
  });
  $("update-query").addEventListener("click", async () => {
    const current = state.searches.find((x) => x.id === state.savedId);
    const result = await saveCollection(state.query, current);
    if (result) {
      await reloadSearches();
      persistQuery();
      toast("智能集合条件已更新");
    }
  });
  $("journal-aliases").addEventListener("click", async () => {
    try {
      await manageAliases(async () => {
        await refresh();
        if (state.selectedId && !editor.editing)
          await selectItem(state.selectedId);
      });
    } catch (error) {
      toast(error.message, true);
    }
  });
  $("export-selected").addEventListener("click", async () => {
    try {
      const ids = [...state.checked];
      if (!ids.length) return;
      downloadJSON(
        await api("/api/library/export-csl", { ids }),
        "references.json",
      );
      toast("已导出 CSL-JSON 文献数据");
    } catch (error) {
      toast(error.message, true);
    }
  });
  $("import-pdf").addEventListener("click", () => {
    attachTarget = null;
    $("file-input").click();
  });
  $("import-folder").addEventListener("click", () => {
    attachTarget = null;
    $("folder-input").click();
  });
  for (const id of ["file-input", "folder-input"])
    $(id).addEventListener("change", (event) => {
      const files = [...event.target.files];
      event.target.value = "";
      doImport(files);
    });
  let dragDepth = 0;
  window.addEventListener("dragenter", (event) => {
    if ([...event.dataTransfer.types].includes("Files")) {
      event.preventDefault();
      dragDepth++;
      $("drop-cover").hidden = false;
    }
  });
  window.addEventListener("dragover", (event) => {
    if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("drop-cover").hidden = true;
  });
  window.addEventListener("drop", (event) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    dragDepth = 0;
    $("drop-cover").hidden = true;
    attachTarget = null;
    if (event.dataTransfer.files.length) doImport(event.dataTransfer.files);
  });
  $("mobile-filters").addEventListener("click", () =>
    $("sidebar").classList.toggle("mobile-open"),
  );
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      $("search").focus();
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "s" &&
      editor.editing
    ) {
      event.preventDefault();
      editor.save();
    }
  });
  window.addEventListener("focus", () => {
    if (info) refresh();
  });
}
try {
  info = await api("/api/library/info");
  $("library-label").textContent = info.label;
  const previous = sessionStorage.getItem(
    "paper-workbench:query:" + info.libraryId,
  );
  if (previous) {
    try {
      const value = JSON.parse(previous);
      state.query = normalizeLibraryQuery(value.query);
      state.savedId = value.savedId;
    } catch {}
  }
  $("search").value = state.query.text;
  state.searches = info.savedSearches;
  renderSaved(state.searches, state.savedId);
  editor = new MetadataEditor({
    container: $("details"),
    libraryId: info.libraryId,
    onSaved: async (item, originId) => {
      await refresh();
      if (state.selectedId === originId) {
        state.selectedId = item.id;
        document
          .querySelectorAll("#table-body tr")
          .forEach((row) =>
            row.classList.toggle("selected", row.dataset.id === item.id),
          );
      }
    },
    onFilter: (dimension, value) => {
      const key = termKey(value);
      if (!state.query[dimension].includes(key))
        state.query[dimension].push(key);
      changed();
    },
    onAttach: (id) => {
      attachTarget = id;
      $("file-input").click();
    },
    onChangeArchive: (item) => setArchived([item], !item.archivedAt),
  });
  editor.clear();
  bind();
  await refresh();
} catch (error) {
  $("result-error").textContent = "无法打开文献库：" + error.message;
  $("result-error").hidden = false;
}

connectHarness("library", {
  async refresh() {
    if (editor?.saving || editor?.isDirty() || document.querySelector('dialog[open]')) return { deferred:true };
    await refresh(); return { refreshed:true };
  },
  flush() {
    if (editor?.saving) throw new Error("文献信息正在保存，请稍后再切换。");
    if (editor?.isDirty())
      throw new Error(
        "文献信息尚未保存。请先保存或重新载入信息，再切换页面；本地草稿仍保留。",
      );
  },
});
