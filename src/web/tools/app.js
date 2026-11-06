import { connectHarness } from "../harness-bridge.js";
import { api } from "../persistence-client.js";
import { $, esc, toast, modal } from "../library/dom.js";
import { showPageText } from "./text-viewer.js";
import { authorLabel } from "../shared/bibliography.mjs";
const selected = new Map();
let indexStatus,
  officeInfo,
  planId = null,
  previewGeneration = 0,
  searchToken = 0;
function invalidate() {
  previewGeneration++;
  planId = null;
  $("cite-preview").hidden = true;
  $("cite-message").textContent = "选择或格式变化后，请重新预览。";
}
function tab() {
  const cite = location.hash === "#citations";
  $("index-panel").hidden = cite;
  $("citations-panel").hidden = !cite;
  document
    .querySelectorAll(".tool-tabs a")
    .forEach((a) =>
      a.classList.toggle("active", a.hash === (cite ? "#citations" : "#index")),
    );
  if (cite && !officeInfo) loadOffice();
  if (!cite) refreshIndex();
}
window.addEventListener("hashchange", tab);
const safe = (fn) => async (event) => {
  try {
    await fn(event);
  } catch (error) {
    toast(error.message, true);
  }
};
async function refreshIndex() {
  indexStatus = await api("/api/index/status");
  const docs = indexStatus.documents;
  const stats = [
    [docs.length, "PDF 附件"],
    [docs.filter((d) => d.indexedAt).length, "已建立索引"],
    [docs.reduce((n, d) => n + (d.ocrPages || 0), 0), "OCR 识别页"],
    [docs.reduce((n, d) => n + (d.emptyPages || 0), 0), "空白或待识别页"],
  ];
  $("index-metrics").innerHTML = stats
    .map(([n, t]) => `<div class="metric"><b>${n}</b><span>${t}</span></div>`)
    .join("");
  const active = indexStatus.jobs.filter((j) =>
    ["running", "queued"].includes(j.status),
  );
  $("index-progress").textContent = indexStatus.paused
    ? "已暂停 · 进度已保存"
    : indexStatus.progress
      ? `${indexStatus.progress.status} · 第 ${indexStatus.progress.page} 页 · ${active.length} 个任务待完成`
      : active.length
        ? `${active.length} 个任务排队中`
        : "当前没有运行中的任务";
  $("index-pause").textContent = indexStatus.paused ? "继续任务" : "暂停任务";
  $("index-jobs").innerHTML = indexStatus.jobs
    .filter((j) => j.status !== "done")
    .slice(0, 10)
    .map(
      (j) =>
        `<div class="job-row"><div>${esc(j.name)}<small class="${j.error ? "error-text" : ""}">${esc(j.error || { queued: "等待处理", running: "处理中", failed: "未完成", cancelled: "已取消" }[j.status])} · ${j.completedPages} / ${j.page_count} 页已保存</small></div><button data-job-action="${["queued", "running"].includes(j.status) ? "cancel" : "retry"}" data-job="${j.id}">${["queued", "running"].includes(j.status) ? "取消" : "重试"}</button></div>`,
    )
    .join("");
  renderIndexDocuments();
}
function renderIndexDocuments() {
  const filter = $("index-filter").value.toLowerCase();
  $("index-documents").innerHTML =
    (indexStatus?.documents || [])
      .filter((d) => d.name.toLowerCase().includes(filter))
      .map(
        (d) =>
          `<div class="index-row"><div class="index-name">${esc(d.name)}<small>${d.pages} 页</small></div><div>${d.indexedAt ? "已索引" : "待索引"}<small>${d.indexedAt ? `${d.nativePages} 页原生 · ${d.ocrPages} 页 OCR${d.emptyPages ? " · " + d.emptyPages + " 页空白/待识别" : ""}` : "在后台任务中查看处理结果"}</small></div><div class="button-group"><button data-text="${d.id}">查看正文</button><button data-ocr="${d.id}">OCR</button><a href="./reader.html?id=${d.id}" target="_blank">阅读 ↗</a></div></div>`,
      )
      .join("") || "<p>没有找到文件。导入 PDF 后会自动建立索引。</p>";
}
$("index-filter").oninput = renderIndexDocuments;
$("index-all").onclick = safe(async () => {
  await api("/api/index/queue", { mode: "text" });
  await refreshIndex();
  toast("已加入索引队列");
});
$("ocr-missing").onclick = safe(async () => {
  const ids = indexStatus.documents
    .filter((d) => !d.indexedAt || d.emptyPages)
    .map((d) => d.id);
  await api("/api/index/queue", { ids, mode: "ocr" });
  await refreshIndex();
  toast(ids.length ? "已加入 OCR 队列" : "没有待识别页面");
});
$("index-pause").onclick = safe(async () => {
  await api("/api/index/pause", { paused: !indexStatus.paused });
  await refreshIndex();
});
$("index-jobs").onclick = safe(async (event) => {
  const b = event.target.closest("[data-job]");
  if (b) {
    await api("/api/index/" + b.dataset.jobAction, { id: b.dataset.job });
    await refreshIndex();
  }
});
$("index-documents").onclick = safe(async (event) => {
  const ocr = event.target.closest("[data-ocr]"),
    text = event.target.closest("[data-text]");
  if (ocr) {
    await modal({
      title: "识别 PDF 文字",
      confirm: "加入识别队列",
      content:
        '<p>中英文识别在本机完成，结果独立保存。</p><label class="check-line"><input type="radio" name="mode" value="ocr" checked> 仅识别没有原生文字的页面</label><label class="check-line"><input type="radio" name="mode" value="force-ocr"> 重新识别所有页面（适合原有文字层乱码）</label>',
      onSubmit: async (data) => {
        await api("/api/index/queue", {
          ids: [ocr.dataset.ocr],
          mode: data.get("mode"),
        });
        await refreshIndex();
        toast("已加入 OCR 队列");
        return true;
      },
    });
  }
  if (text) await showPageText(text.dataset.text);
});
async function loadOffice() {
  try {
    officeInfo = await api("/api/citations/info", undefined, {
      timeoutMs: 65000,
    });
    $("cite-style").innerHTML =
      '<option value="">沿用文档格式 · 新文档使用国标 2015</option>' +
      officeInfo.styles
        .map((s) => `<option value="${s.id}">${esc(s.label)}</option>`)
        .join("");
    officeStatus();
  } catch (e) {
    $("office-status").textContent = e.message;
  }
}
function officeStatus() {
  const app = officeInfo?.applications.find(
    (a) => a.id === $("cite-app").value,
  );
  $("office-status").textContent = app?.installed
    ? app.active
      ? "已检测到打开的文档。预览时将读取当前文档与光标位置。"
      : "软件已安装。请打开 .docx 文档并放好光标后预览。"
    : "未检测到该软件的桌面自动化接口。";
  invalidate();
}
$("cite-app").onchange = officeStatus;
$("cite-style").onchange = invalidate;
async function searchCitations() {
  const token = ++searchToken;
  const result = await api("/api/library/search", {
    query: { text: $("cite-search").value },
    page: { limit: 30 },
  });
  if (token !== searchToken) return;
  $("cite-results").innerHTML = result.items
    .map(
      (item) =>
        `<div class="cite-result"><div><strong>${esc(item.title)}</strong><small>${esc(item.authors.map(authorLabel).slice(0, 3).join("；"))} · ${item.year || "年份待补全"}</small></div><button data-cite-id="${item.id}" ${selected.has(item.id) ? "disabled" : ""}>${selected.has(item.id) ? "已选" : "加入"}</button></div>`,
    )
    .join("");
}
let searchTimer;
$("cite-search").oninput = () => {
  searchToken++;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(
    () => searchCitations().catch((e) => toast(e.message, true)),
    180,
  );
};
async function addItem(id) {
  const item = await api("/api/library/items/" + id);
  selected.set(id, {
    id,
    title: item.metadata.title,
    locator: "",
    prefix: "",
    suffix: "",
  });
  renderSelected();
  invalidate();
}
$("cite-results").onclick = safe(async (event) => {
  const b = event.target.closest("[data-cite-id]");
  if (b) {
    await addItem(b.dataset.citeId);
    b.disabled = true;
    b.textContent = "已选";
  }
});
function renderSelected() {
  $("cite-count").textContent = selected.size;
  $("cite-selected").innerHTML =
    [...selected.values()]
      .map(
        (item) =>
          `<div class="chosen-cite" data-selected-id="${item.id}"><div class="cite-row"><strong>${esc(item.title)}</strong><button data-remove="${item.id}" aria-label="移除引用">×</button></div><div class="locators"><label>引用页码<input data-cite-field="locator" placeholder="如 12–15" value="${esc(item.locator)}"></label><label>前缀<input data-cite-field="prefix" value="${esc(item.prefix)}"></label><label>后缀<input data-cite-field="suffix" value="${esc(item.suffix)}"></label></div></div>`,
      )
      .join("") ||
    '<p class="small muted">选择左侧文献，或从文献库勾选后点击“插入写作引用”。</p>';
}
$("cite-selected").onclick = safe(async (event) => {
  const b = event.target.closest("[data-remove]");
  if (b) {
    selected.delete(b.dataset.remove);
    renderSelected();
    invalidate();
    await searchCitations();
  }
});
$("cite-selected").oninput = (event) => {
  const key = event.target.dataset.citeField,
    id = event.target.closest("[data-selected-id]")?.dataset.selectedId;
  if (key && id) {
    selected.get(id)[key] = event.target.value;
    invalidate();
  }
};
async function prepare(action) {
  invalidate();
  const generation = previewGeneration;
  $("cite-message").textContent = "正在读取当前文档并生成预览…";
  const result = await api(
    "/api/citations/prepare",
    {
      application: $("cite-app").value,
      style: $("cite-style").value,
      action,
      items: [...selected.values()],
    },
    { timeoutMs: 65000 },
  );
  if (generation !== previewGeneration) return;
  planId = result.planId;
  $("cite-target").textContent =
    `目标：${result.target.name} · ${result.citationCount} 处引用 · ${result.bibliographyCount} 篇文献`;
  $("cite-target").title = result.target.fullName;
  $("cite-output").textContent = result.citation || "刷新现有引用及参考文献表";
  $("bib-output").textContent = result.bibliography || "当前文档尚无引用。";
  $("cite-warnings").innerHTML = result.warnings.length
    ? `<div class="warning-box">${result.warnings.map(esc).join("<br>")}</div>`
    : "";
  $("cite-preview").hidden = false;
  $("cite-message").textContent =
    "确认预览后写入。预览期间请保持 Word 中的文档与光标位置不变。";
}
for (const [id, action] of [
  ["cite-insert", "insert"],
  ["cite-bibliography", "bibliography"],
  ["cite-refresh", "refresh"],
])
  $(id).onclick = safe(async (event) => {
    event.target.disabled = true;
    try {
      await prepare(action);
    } finally {
      event.target.disabled = false;
    }
  });
$("cite-apply").onclick = safe(async (event) => {
  if (!planId) return;
  event.target.disabled = true;
  try {
    const result = await api(
      "/api/citations/apply",
      { planId },
      { timeoutMs: 65000 },
    );
    invalidate();
    $("cite-message").textContent = result.message;
    toast("引用已写入，请在 Word/WPS 中保存文档。");
  } finally {
    event.target.disabled = false;
  }
});
renderSelected();
tab();
await searchCitations();
for (const id of (new URLSearchParams(location.search).get("items") || "")
  .split(",")
  .filter(Boolean))
  try {
    await addItem(id);
  } catch (e) {
    toast(e.message, true);
  }
await searchCitations();
setInterval(() => {
  if (!document.hidden && !$("index-panel").hidden)
    refreshIndex().catch((e) => {
      $("index-progress").textContent = e.message;
    });
}, 2500);

connectHarness("tools");
