import { api } from "../persistence-client.js";
import {
  authorLabel,
  normalizeMetadata,
  effectiveYear,
  normalizeDoi,
} from "../shared/bibliography.mjs";
import {
  candidateFields,
  applyMetadataCandidate,
} from "../shared/metadata-candidates.mjs";
import {
  $,
  esc,
  typeLabels,
  readingLabels,
  fieldLabels,
  downloadJSON,
  modal,
  toast,
} from "./dom.js";

export class MetadataEditor {
  constructor({ container, libraryId, onSaved, onFilter, onAttach }) {
    Object.assign(this, { container, libraryId, onSaved, onFilter, onAttach });
    this.item = null;
    this.editing = false;
    this.draft = null;
    this.pendingRequest = null;
    const reloading =
      performance.getEntriesByType("navigation")[0]?.type === "reload";
    this.draftOwner =
      (reloading
        ? sessionStorage.getItem("paper-workbench:draft-owner")
        : null) || crypto.randomUUID();
    sessionStorage.setItem("paper-workbench:draft-owner", this.draftOwner);
    container.addEventListener("click", (event) =>
      this.click(event).catch((error) => this.error(error.message)),
    );
    container.addEventListener("input", (event) => this.input(event));
    container.addEventListener("change", (event) => this.input(event));
    container.addEventListener("submit", (event) => {
      event.preventDefault();
      this.save();
    });
  }
  key(id = this.item?.id) {
    return `paper-workbench:${this.libraryId}:metadata:${this.draftOwner}:${id || "new"}`;
  }
  recoverableDrafts() {
    const prefix = `paper-workbench:${this.libraryId}:metadata:`,
      suffix = ":" + (this.item?.id || "new"),
      rows = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (
        key === this.key() ||
        !key.startsWith(prefix) ||
        !key.endsWith(suffix)
      )
        continue;
      try {
        const value = JSON.parse(localStorage.getItem(key));
        if (value.metadata && Array.isArray(value.metadata.authors))
          rows.push({ key, ...value });
      } catch {}
    }
    return rows;
  }
  isDirty() {
    return Boolean(this.draft && this.dirty);
  }
  show(item, { editing = false } = {}) {
    this.item = item;
    this.pendingRequest = null;
    this.dirty = false;
    const saved = localStorage.getItem(this.key());
    this.draft = structuredClone(
      item?.metadata || {
        title: "",
        type: "article-journal",
        authors: [],
        year: null,
        journal: "",
        doi: "",
        volume: "",
        issue: "",
        pages: "",
        publisher: "",
        abstract: "",
        url: "",
        printDate: "",
        onlineDate: "",
        tags: [],
        readingStatus: "unread",
        reviewStatus: "unverified",
        favorite: false,
        extra: {},
      },
    );
    this.baseRevision = item?.revision ?? 0;
    this.conflict = false;
    if (saved) {
      try {
        const draft = JSON.parse(saved);
        this.draft = draft.metadata;
        this.baseRevision = draft.revision;
        this.dirty = true;
        this.conflict = Boolean(item && item.revision !== draft.revision);
      } catch {
        toast("未能读取这条文献的本地草稿。", true);
      }
    }
    this.otherDrafts = this.recoverableDrafts();
    this.editing = editing || !item || this.dirty;
    this.render();
  }
  clear() {
    this.item = null;
    this.draft = null;
    this.container.innerHTML =
      '<div class="detail-empty"><div class="empty-book">▤</div><h3>选择一篇文献</h3><p>在这里查看书目信息、整理标签，或打开 PDF 阅读。</p></div>';
  }
  render() {
    const item = this.item;
    if (!this.draft) {
      this.clear();
      return;
    }
    this.container.innerHTML = `<div class="detail-heading"><div><span class="eyebrow">${item ? "文献信息" : "新建文献"}</span><strong>${this.editing ? "编辑书目信息" : "文献详情"}</strong></div><button type="button" class="icon-button" data-action="close" aria-label="收起详情">×</button></div>
      <div class="detail-tabs"><button type="button" data-action="overview" class="${!this.editing ? "active" : ""}" ${!item ? "disabled" : ""}>概览</button><button type="button" data-action="edit" class="${this.editing ? "active" : ""}" ${item?.archivedAt ? "disabled" : ""}>编辑</button></div>
      ${this.otherDrafts?.length ? `<div class="hint"><span>本机还保留了 ${this.otherDrafts.length} 份其他页签草稿。</span> <button type="button" class="text-button" data-action="recover-draft">查看与恢复</button></div>` : ""}
      ${this.editing ? this.form() : this.overview()}`;
  }
  overview() {
    const item = this.item,
      m = item.metadata;
    return `<div class="detail-scroll"><div class="detail-badges"><span class="badge ${m.reviewStatus === "reviewed" ? "green" : ""}">${m.reviewStatus === "reviewed" ? "已核对" : "待核对"}</span><span class="badge">${esc(readingLabels[m.readingStatus])}</span>${item.archivedAt ? '<span class="badge amber">回收站</span>' : ""}</div><h2 class="detail-title">${esc(m.title)}</h2>
      <p class="type-line">${esc(typeLabels[m.type])}${m.favorite ? " · ★ 已收藏" : ""}</p>
      <dl class="metadata-list"><dt>作者</dt><dd>${m.authors.length ? m.authors.map((a) => `<button class="text-link" data-author="${esc(authorLabel(a))}" title="筛选此作者姓名">${esc(authorLabel(a))}</button>`).join('<span class="separator">；</span>') : '<span class="missing">尚未填写</span>'}</dd>
      <dt>发表年份</dt><dd>${item.year ?? '<span class="missing">尚未填写</span>'}${item.yearSource === "print" ? " <small>来自卷期日期</small>" : item.yearSource === "online" ? " <small>来自网络首发</small>" : ""}</dd>
      <dt>期刊 / 会议</dt><dd>${item.journalDisplay ? `<button class="text-link" data-journal="${esc(item.journalKey)}">${esc(item.journalDisplay)}</button>` : '<span class="missing">尚未填写</span>'}${item.journalDisplay && item.journalDisplay !== m.journal ? `<small class="block">原始字段：${esc(m.journal)}</small>` : ""}</dd>
      <dt>卷 / 期 / 页</dt><dd>${esc([m.volume, m.issue ? `(${m.issue})` : "", m.pages].filter(Boolean).join(" ") || "—")}</dd>
      <dt>DOI</dt><dd>${m.doi ? `<a href="https://doi.org/${esc(encodeURIComponent(m.doi))}" target="_blank" rel="noopener noreferrer">${esc(m.doi)} ↗</a>` : "—"}</dd></dl>
      ${item.missingFields.length ? `<div class="hint amber">待补全：${item.missingFields.map((key) => esc(fieldLabels[key])).join("、")}</div>` : ""}
      <h3 class="detail-section-title">标签</h3><div class="tag-list">${m.tags.length ? m.tags.map((tag) => `<button class="tag" data-tag="${esc(tag)}">${esc(tag)}</button>`).join("") : '<span class="muted small">还没有标签</span>'}</div>
      <h3 class="detail-section-title">PDF 附件 <span>${item.attachments.length}</span></h3><div class="attachment-list">${item.attachments.map((file) => `<a class="attachment" href="./reader.html?id=${file.id}" target="_blank" rel="noopener"><span class="pdf-icon">PDF</span><span><strong>${esc(file.originalName)}</strong><small>${file.pages} 页 · ${file.annotationCount} 条标注</small></span><span>↗</span></a>`).join("") || '<p class="muted small">尚未关联 PDF，可在保留这条书目信息的同时添加文件。</p>'}</div>
      ${!item.archivedAt ? '<button type="button" class="full secondary" data-action="attach">＋ 关联 PDF</button>' : ""}
      ${m.abstract ? `<details class="abstract" open><summary>摘要</summary><p>${esc(m.abstract)}</p></details>` : ""}
      ${m.printDate || m.onlineDate ? `<p class="small muted">卷期日期：${esc(m.printDate || "—")}<br>网络首发：${esc(m.onlineDate || "—")}</p>` : ""}
      ${m.extra?.metadataLookup ? `<p class="provenance">候选信息来源：${esc(m.extra.metadataLookup.provider)}<br>获取于 ${esc(m.extra.metadataLookup.fetchedAt?.slice(0, 10))}，核对状态由你确认。</p>` : ""}
      <button type="button" class="full" data-action="export-item">导出这条文献的数据</button></div>`;
  }
  form() {
    const d = this.draft;
    const input = (name, label, extra = "") =>
      `<label class="field"><span>${label}</span><input data-field="${name}" name="${name}" value="${esc(d[name] ?? "")}" ${extra}></label>`;
    return `<form class="metadata-form" novalidate><fieldset class="editor-fields"><div class="detail-scroll">
      ${this.conflict ? '<div class="hint danger">文献已在其他窗口更新。你的草稿已保留，请重新载入最新信息后核对。</div>' : ""}
      <label class="field"><span>题名 <b>*</b></span><textarea data-field="title" name="title" rows="3" maxlength="4000" required>${esc(d.title)}</textarea></label>
      <label class="field"><span>文献类型</span><select data-field="type" name="type">${Object.entries(
        typeLabels,
      )
        .map(
          ([key, label]) =>
            `<option value="${key}" ${key === d.type ? "selected" : ""}>${label}</option>`,
        )
        .join("")}</select></label>
      <div class="field"><span>作者 <small>按论文署名顺序</small></span><div id="author-rows">${this.authorRows()}</div><button type="button" class="text-button" data-action="add-author">＋ 添加作者</button><small>完整姓名与“姓 / 名”分开填写二选一，不自动合并同名作者。</small></div>
      <div class="field-pair">${input("year", "发表年份", 'type="number" min="1" max="9999" placeholder="可留空"')}${input("journal", "期刊 / 会议")}</div>
      <div class="field"><span>DOI</span><div class="inline-field"><input data-field="doi" name="doi" value="${esc(d.doi || "")}" placeholder="10.xxxx/… 或 doi.org 链接"><button type="button" data-action="lookup-doi" title="仅查询 DOI，不上传 PDF">联网补全</button></div><small>查询 Crossref 后可逐项选择应用；不会自动覆盖已有信息。</small></div>
      <div class="field-pair"><label class="field"><span>阅读状态</span><select data-field="readingStatus">${Object.entries(
        readingLabels,
      )
        .map(
          ([key, label]) =>
            `<option value="${key}" ${key === d.readingStatus ? "selected" : ""}>${label}</option>`,
        )
        .join(
          "",
        )}</select></label><label class="field"><span>核对状态</span><select data-field="reviewStatus"><option value="unverified" ${d.reviewStatus !== "reviewed" ? "selected" : ""}>待核对</option><option value="reviewed" ${d.reviewStatus === "reviewed" ? "selected" : ""}>已核对</option></select></label></div>
      <label class="field"><span>标签</span><input data-field="tags" value="${esc((d.tags || []).join("；"))}" placeholder="用分号或逗号分隔"><small>标签中的空格会保留，例如 machine learning。</small></label>
      <label class="check-line"><input type="checkbox" data-field="favorite" ${d.favorite ? "checked" : ""}>收藏这篇文献</label>
      <details class="more-fields"><summary>出版日期、卷期、摘要等</summary><div class="field-pair">${input("printDate", "卷期出版日期", 'placeholder="YYYY-MM-DD"')}${input("onlineDate", "网络首发日期", 'placeholder="YYYY-MM-DD"')}</div><p class="small muted">未指定发表年份时，按卷期日期 → 网络首发日期确定检索年份。</p><div class="field-pair">${input("volume", "卷")}${input("issue", "期")}</div>${input("pages", "页码 / 文章编号")}${input("publisher", "出版者")}${input("url", "文献链接", 'type="url"')}<label class="field"><span>摘要</span><textarea data-field="abstract" rows="6">${esc(d.abstract || "")}</textarea></label></details>
      <p id="editor-error" class="form-error" role="alert" hidden></p></div></fieldset><div class="editor-footer"><span id="draft-status" class="small">${this.dirty ? "草稿已在本机保留" : "修改后点击保存"}</span><div><button type="button" data-action="reset-draft">重新载入</button><button type="submit" class="primary">保存信息</button></div></div></form>`;
  }
  authorRows() {
    return (
      (this.draft.authors || [])
        .map(
          (a, index) =>
            `<div class="author-row" data-author-index="${index}"><div class="author-head"><span>${index + 1}</span><select data-author-field="mode" aria-label="作者 ${index + 1} 填写方式"><option value="literal" ${a.literal !== undefined ? "selected" : ""}>完整姓名 / 团体</option><option value="person" ${a.literal === undefined ? "selected" : ""}>姓和名分开</option></select><button type="button" class="icon-button" data-action="author-up" data-index="${index}" aria-label="上移作者 ${index + 1}" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" class="icon-button" data-action="author-down" data-index="${index}" aria-label="下移作者 ${index + 1}" ${index === this.draft.authors.length - 1 ? "disabled" : ""}>↓</button><button type="button" class="icon-button" data-action="remove-author" data-index="${index}" aria-label="移除作者 ${index + 1}">×</button></div>${a.literal !== undefined ? `<input data-author-field="literal" value="${esc(a.literal)}" placeholder="完整姓名或团体名称" aria-label="作者 ${index + 1} 姓名">` : `<div class="field-pair"><input data-author-field="family" value="${esc(a.family || "")}" placeholder="姓 / Family" aria-label="作者 ${index + 1} 姓"><input data-author-field="given" value="${esc(a.given || "")}" placeholder="名 / Given" aria-label="作者 ${index + 1} 名"></div>`}<details class="orcid"><summary>ORCID（可选）</summary><input data-author-field="orcid" value="${esc(a.orcid || "")}" placeholder="0000-0000-0000-0000" aria-label="作者 ${index + 1} ORCID"></details></div>`,
        )
        .join("") || '<p class="small muted">尚未填写作者。</p>'
    );
  }
  input(event) {
    if (!this.editing || !this.draft) return;
    const field = event.target.dataset.field,
      authorField = event.target.dataset.authorField;
    if (field) {
      this.draft[field] =
        field === "favorite"
          ? event.target.checked
          : field === "tags"
            ? event.target.value
                .split(/[,，;；\n]/)
                .map((x) => x.trim())
                .filter(Boolean)
            : event.target.value;
      this.markDirty();
    }
    if (authorField) {
      const index = Number(
        event.target.closest("[data-author-index]").dataset.authorIndex,
      );
      if (authorField === "mode") {
        if (event.type !== "change") return;
        const old = this.draft.authors[index];
        this.draft.authors[index] =
          event.target.value === "literal"
            ? { literal: authorLabel(old), orcid: old.orcid || "" }
            : { family: old.literal || "", given: "", orcid: old.orcid || "" };
        this.container.querySelector("#author-rows").innerHTML =
          this.authorRows();
      } else this.draft.authors[index][authorField] = event.target.value;
      this.markDirty();
    }
  }
  markDirty() {
    this.dirty = true;
    this.pendingRequest = null;
    try {
      localStorage.setItem(
        this.key(),
        JSON.stringify({
          revision: this.baseRevision,
          updatedAt: new Date().toISOString(),
          metadata: this.draft,
        }),
      );
      const text = this.container.querySelector("#draft-status");
      if (text) text.textContent = "草稿已在本机保留，尚未写入文献库";
    } catch (error) {
      this.error("无法保留草稿：" + error.message);
    }
  }
  error(message) {
    const element = this.container.querySelector("#editor-error");
    if (element) {
      element.textContent = message;
      element.hidden = false;
    } else toast(message, true);
  }
  async save() {
    if (!this.editing || !this.draft || this.saving) return;
    try {
      const metadata = normalizeMetadata({
        ...this.draft,
        authors: this.draft.authors.filter(
          (a) =>
            a.literal?.trim() ||
            a.family?.trim() ||
            a.given?.trim() ||
            a.orcid?.trim(),
        ),
      });
      const command = this.pendingRequest || {
        requestId: crypto.randomUUID(),
        ...(this.item ? { expectedRevision: this.baseRevision } : {}),
        metadata,
      };
      this.pendingRequest = command;
      const originId = this.item?.id || null,
        key = this.key();
      this.saving = true;
      this.container.querySelector(".editor-fields").disabled = true;
      this.container.querySelector("[type=submit]").disabled = true;
      const result = await api(
        originId ? `/api/library/items/${originId}` : "/api/library/items",
        command,
      );
      localStorage.removeItem(key);
      this.dirty = false;
      this.pendingRequest = null;
      if ((this.item?.id || null) === originId) this.show(result);
      await this.onSaved(result, originId);
      toast("文献信息已保存");
    } catch (error) {
      this.error(error.message);
      if (error.code === "METADATA_CONFLICT") this.conflict = true;
    } finally {
      this.saving = false;
      const fields = this.container.querySelector(".editor-fields");
      if (fields) fields.disabled = false;
      const button = this.container.querySelector("[type=submit]");
      if (button) button.disabled = false;
    }
  }
  async click(event) {
    const button = event.target.closest("button");
    if (!button) return;
    if (this.saving) {
      toast("信息正在保存，请稍候");
      return;
    }
    if (button.dataset.author) {
      this.onFilter("authors", button.dataset.author);
      return;
    }
    if (button.dataset.journal) {
      this.onFilter("journals", button.dataset.journal);
      return;
    }
    if (button.dataset.tag) {
      this.onFilter("tags", button.dataset.tag);
      return;
    }
    const action = button.dataset.action,
      index = Number(button.dataset.index);
    if (action === "close") {
      this.container.classList.remove("mobile-open");
      return;
    }
    if (action === "edit") {
      this.editing = true;
      this.render();
    }
    if (action === "overview" && this.item) {
      this.editing = false;
      this.render();
    }
    if (action === "add-author") {
      this.draft.authors.push({ literal: "" });
      this.container.querySelector("#author-rows").innerHTML =
        this.authorRows();
      this.markDirty();
    }
    if (action === "remove-author") {
      this.draft.authors.splice(index, 1);
      this.container.querySelector("#author-rows").innerHTML =
        this.authorRows();
      this.markDirty();
    }
    if (action === "author-up" || action === "author-down") {
      const next = index + (action === "author-up" ? -1 : 1);
      [this.draft.authors[index], this.draft.authors[next]] = [
        this.draft.authors[next],
        this.draft.authors[index],
      ];
      this.container.querySelector("#author-rows").innerHTML =
        this.authorRows();
      this.markDirty();
    }
    if (action === "reset-draft") {
      if (this.dirty) {
        const confirmed = await modal({
          title: "重新载入文献信息",
          content:
            "<p>丢弃当前页签中这条文献的未保存草稿，载入已保存的最新信息。</p>",
          confirm: "丢弃草稿并载入",
          onSubmit: () => true,
        });
        if (!confirmed) return;
      }
      const id = this.item?.id || null;
      localStorage.removeItem(this.key());
      const latest = id ? await api(`/api/library/items/${id}`) : null;
      if ((this.item?.id || null) === id) this.show(latest, { editing: true });
    }
    if (action === "recover-draft") {
      const rows = this.recoverableDrafts();
      const chosen = await modal({
        title: "恢复本机草稿",
        content:
          '<p class="dialog-hint">草稿会复制到当前页签。其他页签的草稿仍保留，保存时会检查文献版本。</p>' +
          rows
            .map(
              (row, index) =>
                `<label class="check-line"><input type="radio" name="draft" value="${index}" ${index === 0 ? "checked" : ""}><span>${esc(row.metadata.title || "未填写题名")}<small class="block">${esc(row.updatedAt || "旧版草稿")}</small></span></label>`,
            )
            .join(""),
        confirm: "载入为当前草稿",
        onSubmit: (data) => rows[Number(data.get("draft"))],
      });
      if (chosen) {
        this.draft = structuredClone(chosen.metadata);
        this.baseRevision = chosen.revision;
        this.conflict = Boolean(
          this.item && this.item.revision !== chosen.revision,
        );
        this.editing = true;
        this.markDirty();
        this.render();
      }
    }
    if (action === "attach") this.onAttach(this.item.id);
    if (action === "export-item")
      downloadJSON([this.item.csl], "reference.json");
    if (action === "lookup-doi") await this.lookupDoi(button);
  }
  async lookupDoi(button) {
    const targetDraft = this.draft;
    button.disabled = true;
    try {
      const candidate = await api("/api/library/metadata/doi", {
        doi: this.draft.doi,
      });
      if (this.draft !== targetDraft) return;
      if (normalizeDoi(this.draft.doi) !== candidate.doi) {
        toast("DOI 已更改，请重新查询当前 DOI。");
        return;
      }
      const groups = candidateFields(this.draft, candidate.metadata);
      const display = (key, record) => {
        if (key === "authors")
          return (record.authors || []).map(authorLabel).join("；") || "—";
        if (key === "type")
          return typeLabels[record.type] || record.type || "—";
        if (key === "year")
          return (
            [
              record.year ? "指定：" + record.year : "",
              record.printDate ? "卷期：" + record.printDate : "",
              record.onlineDate ? "网络：" + record.onlineDate : "",
            ]
              .filter(Boolean)
              .join("；") || "—"
          );
        return String(record[key] || "—");
      };
      const rows = groups
        .map(
          (group) =>
            '<tr><td><input type="checkbox" name="fields" value="' +
            group.key +
            '" ' +
            (group.defaultChecked ? "checked" : "") +
            ' aria-label="采用' +
            esc(fieldLabels[group.key]) +
            '"></td><th>' +
            esc(fieldLabels[group.key]) +
            "</th><td>" +
            esc(display(group.key, this.draft)) +
            "</td><td>" +
            esc(display(group.key, candidate.metadata)) +
            "</td></tr>",
        )
        .join("");
      const chosen = await modal({
        title: "选择要应用的候选信息",
        wide: true,
        confirm: "应用到草稿",
        content:
          '<p class="dialog-hint">来源：Crossref · DOI ' +
          esc(candidate.doi) +
          '。仅查询 DOI，未上传 PDF。默认勾选缺失字段；应用后仍需保存文献。</p><label class="check-line"><input type="checkbox" id="candidate-all">选择全部候选字段</label><div class="candidate-table"><table><thead><tr><th>采用</th><th>字段</th><th>当前</th><th>候选</th></tr></thead><tbody>' +
          rows +
          "</tbody></table></div>",
        onReady: (dialog) =>
          dialog
            .querySelector("#candidate-all")
            .addEventListener("change", (event) =>
              dialog
                .querySelectorAll("[name=fields]")
                .forEach((input) => (input.checked = event.target.checked)),
            ),
        onSubmit: (data) => data.getAll("fields"),
      });
      if (chosen?.length) {
        this.draft = applyMetadataCandidate(this.draft, candidate, chosen);
        this.markDirty();
        this.render();
        toast("候选信息已应用到草稿，请核对后保存");
      }
    } catch (error) {
      this.error(error.message);
    } finally {
      button.disabled = false;
    }
  }
}
