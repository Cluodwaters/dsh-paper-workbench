import { appUrl } from "../url.js";
import { api } from "../persistence-client.js";
import { normalizeLibraryQuery } from "../shared/library-query.mjs";
import { selectPdfImports } from "../shared/import-selection.mjs";
import { esc, modal, KEEP_OPEN, toast, readingLabels } from "./dom.js";

export async function saveCollection(query, current) {
  return modal({
    title: current ? "更新智能集合" : "保存为智能集合",
    content: `<p class="dialog-hint">保存当前检索条件。以后新导入或补全的匹配文献会自动出现在这里。</p><label class="field"><span>集合名称</span><input name="name" maxlength="100" required value="${esc(current?.name || "")}" placeholder="例如：近五年的热物性论文" autofocus></label>`,
    onSubmit: (data) =>
      api("/api/library/searches", {
        requestId: crypto.randomUUID(),
        ...(current
          ? { id: current.id, expectedRevision: current.revision }
          : {}),
        name: data.get("name"),
        query,
      }),
  });
}
export async function manageCollection(current) {
  return modal({
    title: "管理智能集合",
    content: `<label class="field"><span>名称</span><input name="name" maxlength="100" value="${esc(current.name)}"></label><label class="check-line"><input name="remove" type="checkbox">删除这个智能集合（仅移除检索条件）</label>`,
    onSubmit: async (data) => {
      if (data.get("remove")) {
        await api("/api/library/searches/delete", {
          requestId: crypto.randomUUID(),
          id: current.id,
          expectedRevision: current.revision,
        });
        return { deleted: current.id };
      }
      return api("/api/library/searches", {
        requestId: crypto.randomUUID(),
        id: current.id,
        expectedRevision: current.revision,
        name: data.get("name"),
        query: current.query,
      });
    },
  });
}
export async function batchEdit(items) {
  return modal({
    title: `批量整理 ${items.length} 条文献`,
    content: `<p class="dialog-hint">留空或选择“保持不变”的字段不会修改。整批操作统一保存。</p><div class="field-pair"><label class="field"><span>阅读状态</span><select name="readingStatus"><option value="">保持不变</option>${Object.entries(
      readingLabels,
    )
      .map(([key, label]) => `<option value="${key}">${label}</option>`)
      .join(
        "",
      )}</select></label><label class="field"><span>核对状态</span><select name="reviewStatus"><option value="">保持不变</option><option value="unverified">待核对</option><option value="reviewed">已核对</option></select></label></div><div class="field-pair"><label class="field"><span>统一期刊 / 会议</span><input name="journal" placeholder="留空则不改"></label><label class="field"><span>统一年份</span><input name="year" type="number" min="1" max="9999" placeholder="留空则不改"></label></div><label class="field"><span>添加标签</span><input name="addTags" placeholder="用分号或逗号分隔"></label><label class="field"><span>移除标签</span><input name="removeTags" placeholder="用分号或逗号分隔"></label>`,
    confirm: "应用到所选文献",
    onSubmit: (data) => {
      const changes = {};
      for (const key of ["readingStatus", "reviewStatus", "journal", "year"])
        if (data.get(key)?.trim()) changes[key] = data.get(key).trim();
      for (const key of ["addTags", "removeTags"]) {
        const tags = (data.get(key) || "")
          .split(/[,，;；\n]/)
          .map((x) => x.trim())
          .filter(Boolean);
        if (tags.length) changes[key] = tags;
      }
      if (!Object.keys(changes).length)
        throw new Error("请至少选择一个要修改的字段。");
      return api("/api/library/batch", {
        requestId: crypto.randomUUID(),
        items: items.map((item) => ({
          id: item.id,
          expectedRevision: item.revision,
        })),
        changes,
      });
    },
  });
}
export async function manageAliases(onChange) {
  let catalog = await api("/api/library/journal-aliases");
  const rows = () =>
    catalog.aliases.length
      ? catalog.aliases
          .map(
            (row) =>
              `<div class="alias-row"><div><strong>${esc(row.alias)}</strong><span>→</span><strong>${esc(row.canonical)}</strong></div><button type="button" class="text-button" data-delete-alias="${esc(row.alias)}">移除</button></div>`,
          )
          .join("")
      : '<p class="muted small">还没有期刊别名。可将缩写、旧称或不同拼写归入一个标准名称。</p>';
  return modal({
    title: "期刊别名管理",
    wide: true,
    confirm: "添加归一规则",
    content: `<p class="dialog-hint">归一规则影响分类与检索，文献中原始填写的期刊名称仍会保留。不会按相似度自动合并期刊。</p><div id="alias-list">${rows()}</div><div class="field-pair"><label class="field"><span>原名称 / 缩写</span><input name="alias" placeholder="例如：Phys. Rev. B"></label><label class="field"><span>归入标准名称</span><input name="canonical" placeholder="例如：Physical Review B"></label></div>`,
    onReady: (dialog) => {
      dialog.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-delete-alias]");
        if (!button) return;
        button.disabled = true;
        try {
          catalog = await api("/api/library/journal-aliases", {
            requestId: crypto.randomUUID(),
            expectedRevision: catalog.revision,
            alias: button.dataset.deleteAlias,
            remove: true,
          });
          dialog.querySelector("#alias-list").innerHTML = rows();
          await onChange();
        } catch (error) {
          const el = dialog.querySelector(".form-error");
          el.textContent = error.message;
          el.hidden = false;
          button.disabled = false;
        }
      });
    },
    onSubmit: async (data, dialog) => {
      catalog = await api("/api/library/journal-aliases", {
        requestId: crypto.randomUUID(),
        expectedRevision: catalog.revision,
        alias: data.get("alias"),
        canonical: data.get("canonical"),
      });
      dialog.querySelector("#alias-list").innerHTML = rows();
      dialog.querySelector("[name=alias]").value = "";
      dialog.querySelector("[name=canonical]").value = "";
      await onChange();
      toast("期刊归一规则已保存");
      return KEEP_OPEN;
    },
  });
}
export async function importFiles(
  files,
  { itemId, onComplete, maxBytes, exclusions },
) {
  const { selected: pdfs, ignored } = selectPdfImports(files, exclusions);
  if (!pdfs.length) {
    toast(
      ignored.length
        ? "所选目录中仅有程序自身生成的 PDF，已忽略。"
        : "没有选择 PDF 文件",
      true,
    );
    return;
  }
  let cancelled = false;
  await modal({
    title: `导入 ${pdfs.length} 份 PDF`,
    confirm: null,
    wide: true,
    content: `<p class="dialog-hint">文件将复制到本地文献库，原文件保持不变；相同文件不会重复导入。</p><div class="import-progress"><progress id="import-progress" value="0" max="${pdfs.length}"></progress><span id="import-status">正在准备…</span></div><div id="import-results" class="import-results"></div><button type="button" id="stop-import" class="text-button">停止后续文件</button>`,
    onReady: (dialog) => {
      const doneButton = dialog.querySelector(".dialog-actions .primary");
      doneButton.disabled = true;
      if (ignored.length) {
        const message = document.createElement("p");
        message.className = "hint";
        message.textContent = `已忽略 ${ignored.length} 份程序自身资料库、导出或测试目录中的 PDF。`;
        dialog.querySelector(".dialog-content").prepend(message);
      }
      dialog.querySelector("#stop-import").addEventListener("click", () => {
        cancelled = true;
        dialog.querySelector("#stop-import").disabled = true;
      });
      dialog.addEventListener("close", () => (cancelled = true), {
        once: true,
      });
      (async () => {
        let completed = 0,
          success = 0,
          duplicates = 0,
          firstItem = null;
        for (const file of pdfs) {
          if (cancelled) break;
          dialog.querySelector("#import-status").textContent =
            `正在处理 ${completed + 1}/${pdfs.length}：${file.name}`;
          let message;
          try {
            if (file.size > maxBytes)
              throw new Error(
                `超过单文件上限 ${Math.round(maxBytes / 1048576)} MB`,
              );
            const response = await fetch(appUrl("/api/library/import-pdf"), {
              method: "POST",
              headers: {
                "Content-Type": "application/pdf",
                "X-Paper-Workbench": "1",
                "X-File-Name": encodeURIComponent(file.name),
                ...(itemId ? { "X-Item-ID": itemId } : {}),
              },
              body: file,
              signal: AbortSignal.timeout(150000),
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error.message);
            if (body.duplicate) {
              duplicates++;
              message = "已存在，未重复导入";
            } else {
              success++;
              message = "已导入 · 书目信息待核对";
            }
            firstItem ??= body.item.id;
          } catch (error) {
            message = "未导入：" + error.message;
          }
          if (!dialog.isConnected) break;
          const row = document.createElement("p");
          row.innerHTML = `<strong>${esc(file.webkitRelativePath || file.name)}</strong><span>${esc(message)}</span>`;
          dialog.querySelector("#import-results").append(row);
          completed++;
          dialog.querySelector("#import-progress").value = completed;
        }
        if (dialog.isConnected) {
          dialog.querySelector("#import-status").textContent =
            `处理完成：新增 ${success}，已存在 ${duplicates}，处理 ${completed}/${pdfs.length}`;
          dialog.querySelector("#stop-import").hidden = true;
          doneButton.disabled = false;
        }
        await onComplete(firstItem);
      })().catch((error) => toast(error.message, true));
    },
  });
}
