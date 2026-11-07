import { api } from "./persistence-client.js";
import { ZoteroReaderAdapter } from "./zotero-reader-adapter.js";
import { appUrl } from "./url.js";
import { connectHarness, requestAi, embedded } from "./harness-bridge.js";
import { compactReaderToolbar } from "./reader-toolbar.js";
const $ = (id) => document.getElementById(id);
if (embedded) compactReaderToolbar();
let documents = [],
  adapter = null,
  opening = false;
function status(state, text) {
  $("save-status").dataset.state = state;
  $("save-status").title = text;
  $("save-status").setAttribute("aria-label", text);
  $("save-status").textContent =
    embedded && state === "saved" && text.startsWith("已落盘")
      ? "已保存"
      : text;
  $("retry").hidden = !["failed", "conflict"].includes(state);
}
function notice(message) {
  $("notice").textContent = message;
  $("notice").hidden = false;
}
function renderList() {
  const query = $("search").value.trim().toLocaleLowerCase();
  $("document-list").replaceChildren(
    ...documents
      .filter((doc) => doc.originalName.toLocaleLowerCase().includes(query))
      .map((doc) => {
        const button = document.createElement("button");
        button.className =
          "document" +
          (adapter?.document?.attachment.id === doc.id ? " active" : "");
        button.dataset.id = doc.id;
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = doc.originalName;
        button.title = doc.originalName;
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = `${doc.sampleKey} · ${doc.pages} 页 · ${(doc.bytes / 1048576).toFixed(1)} MB`;
        button.append(name, meta);
        button.addEventListener("click", () => openDocument(doc.id));
        return button;
      }),
  );
}
async function openDocument(id) {
  if (opening) return;
  opening = true;
  $("notice").hidden = true;
  status("saving", "正在打开 PDF…");
  for (const key of ["save", "export-json", "export-pdf"])
    $(key).disabled = true;
  try {
    if (adapter) await adapter.close();
    const doc = await api(`/api/documents/${id}`);
    adapter = new ZoteroReaderAdapter($("reader-frame"), status, notice);
    // Exposes the instance only for phase-1 inspection; production UI depends on the adapter contract.
    window.workbench = { adapter, openDocument, documents };
    $("placeholder").hidden = true;
    $("document-title").textContent =
      doc.attachment.title || doc.attachment.originalName;
    $("document-title").title = $("document-title").textContent;
    document.title =
      (doc.attachment.title || doc.attachment.originalName) + " · 阅读器";
    $("document-info").textContent =
      `${doc.attachment.pages} 页 · 标注独立保存，导出生成新 PDF`;
    renderList();
    await adapter.open(doc);
    for (const key of ["save", "export-json", "export-pdf", "page-text-button"])
      $(key).disabled = false;
    renderList();
  } catch (error) {
    status("failed", error.message);
    notice(error.message);
  } finally {
    opening = false;
  }
}
$("search").addEventListener("input", renderList);
$("page-text-button").addEventListener("click", async () => {
  try {
    const { showPageText } = await import("./tools/text-viewer.js");
    await showPageText(adapter.document.attachment.id, adapter.currentPage());
  } catch (error) {
    notice(error.message);
  }
});
$("save").addEventListener("click", async () => {
  try {
    await adapter.flush();
    status("saved", `已落盘 · 修订 ${adapter.persistence.revision}`);
  } catch (error) {
    notice(error.message);
  }
});
$("retry").addEventListener("click", async () => {
  try {
    await adapter.retry();
    await adapter.flush();
    $("notice").hidden = true;
  } catch (error) {
    notice(error.message);
  }
});
$("export-json").addEventListener("click", async () => {
  try {
    // JSON is also a recovery copy when the database is unavailable.
    const snapshot = adapter.snapshot();
    snapshot.saveState = adapter.getSaveState();
    downloadBlob(
      new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      }),
      adapter.document.attachment.sampleKey + "-annotations.json",
    );
    if (snapshot.saveState !== "saved")
      notice(
        "已导出当前标注备份，其中包含未保存的修改；数据库保存状态未改变。",
      );
  } catch (error) {
    notice(error.message);
  }
});
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
$("export-pdf").addEventListener("click", async () => {
  $("export-pdf").disabled = true;
  try {
    await adapter.flush();
    notice("正在从原始副本生成带标注的新 PDF…");
    const result = await api(
      `/api/export/${adapter.document.attachment.id}`,
      { expectedRevision: adapter.persistence.revision },
      { timeoutMs: 130000 },
    );
    const link = document.createElement("a");
    link.href = appUrl(result.downloadUrl);
    link.textContent = "下载带标注 PDF";
    link.download = result.fileName;
    $("notice").replaceChildren(
      document.createTextNode(
        `已导出修订 ${result.revision}，原始副本保持不变。 `,
      ),
      link,
    );
    link.click();
  } catch (error) {
    notice("导出未完成：" + error.message);
  } finally {
    $("export-pdf").disabled = false;
  }
});
window.paperWorkbenchReader = Object.freeze({
  async prepareClose(action) {
    try {
      if (!adapter) return { ok: true };
      if (action === "save") {
        await adapter.retry();
        await adapter.flush();
      } else if (action === "discard") {
        adapter.discardAndClose();
      } else throw new Error("未知的关闭操作");
      return { ok: true };
    } catch (error) {
      notice(error.message);
      return { ok: false, error: error.message };
    }
  },
});
window.addEventListener("beforeunload", (event) => {
  if (adapter && adapter.getSaveState() !== "saved") {
    event.preventDefault();
    event.returnValue = "";
  }
});
documents = await api("/api/documents");
$("document-count").textContent = documents.length + " 份";
renderList();
status("saved", "请选择一篇测试副本");
window.workbench = { openDocument, documents };
const initialId = new URLSearchParams(location.search).get("id");
if (initialId) {
  document.body.classList.add("direct-reader");
  if (documents.some((doc) => doc.id === initialId)) {
    await openDocument(initialId);
    const page = new URLSearchParams(location.search).get("page");
    if (page !== null && adapter?.pdfApplication)
      await adapter.goToPage(Number(page));
  } else notice("没有找到这个 PDF 附件，请返回文献库重新打开。");
}
for (const button of document.querySelectorAll("[data-ai-action]")) {
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    if (!adapter?.pdfApplication || opening) return notice("请先打开论文。");
    requestAi(button.dataset.aiAction, adapter.context());
  });
}
connectHarness("reader", {
  async flush() {
    if (opening) throw new Error("论文仍在打开，请稍后再切换。");
    await adapter?.flush();
  },
  context() {
    return adapter?.pdfApplication ? adapter.context() : null;
  },
  async navigate(payload) {
    const page = payload?.pageIndex;
    if (
      !adapter?.pdfApplication ||
      !Number.isInteger(page) ||
      page < 0 ||
      page >= adapter.document.attachment.pages
    )
      throw new Error("页码无效或论文尚未打开。");
    await adapter.goToPage(page);
    return adapter.context();
  },
  theme(theme) {
    adapter?.setTheme(theme);
  },
});
