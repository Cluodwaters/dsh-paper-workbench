import { authorLabel, termKey } from "../shared/bibliography.mjs";
import { $, esc, readingLabels, typeLabels, dateLabel } from "./dom.js";

export function renderRows(result, state) {
  $("result-total").textContent = result.total;
  $("result-caption").textContent = result.total
    ? `第 ${result.offset + 1}—${Math.min(result.offset + result.limit, result.total)} 条 · ${state.query.archived ? "回收站" : "本地文献库"}`
    : "没有符合条件的文献";
  $("table-body").innerHTML = result.items
    .map(
      (
        item,
      ) => `<tr data-id="${item.id}" class="${state.selectedId === item.id ? "selected" : ""}">
    <td class="check-cell"><input type="checkbox" data-check="${item.id}" ${state.checked.has(item.id) ? "checked" : ""} aria-label="选择 ${esc(item.title)}"></td>
    <td class="title-cell"><button class="paper-title" data-select="${item.id}">${item.favorite ? '<span class="star">★</span> ' : ""}${esc(item.title)}</button><div class="paper-authors">${item.authors.length ? esc(item.authors.slice(0, 3).map(authorLabel).join("；")) + (item.authors.length > 3 ? ` 等 ${item.authors.length} 位` : "") : '<span class="missing">作者待补全</span>'}</div><div class="row-tags">${item.tags
      .slice(0, 3)
      .map((tag) => `<span>${esc(tag)}</span>`)
      .join(
        "",
      )}${item.needsMetadata ? '<span class="needs-tag">待补全</span>' : ""}${item.reviewStatus === "reviewed" ? '<span class="reviewed-tag">已核对</span>' : ""}</div>${(item.textHits || []).map((hit) => `<a class="text-hit" href="./reader.html?id=${hit.attachmentId}&page=${hit.pageIndex}" target="_blank" rel="noopener"><b>第 ${hit.pageIndex + 1} 页${hit.ocr ? " · 含 OCR" : ""}</b><span>${esc(hit.snippet)}</span></a>`).join("")}</td>
    <td class="year-cell">${item.year ?? '<span class="missing">—</span>'}</td><td class="journal-cell" title="${esc(item.journalRaw)}">${esc(item.journal || "—")}<small>${esc(typeLabels[item.type])}</small></td>
    <td><span class="reading-state ${item.readingStatus}">${esc(readingLabels[item.readingStatus])}</span></td>
    <td class="open-cell">${item.attachments.length ? `<a class="read-link" href="./reader.html?id=${item.attachments[0].id}" target="_blank" rel="noopener" title="在独立页面阅读 PDF">PDF ↗</a><small>${item.annotationCount ? item.annotationCount + " 条标注" : ""}</small>` : '<span class="missing small">无附件</span>'}</td></tr>`,
    )
    .join("");
  const empty = $("empty-state");
  empty.hidden = result.items.length > 0;
  if (!empty.hidden) {
    const trashEmpty = state.query.archived && !result.counts.archived;
    empty.querySelector("h2").textContent = trashEmpty
      ? "回收站为空"
      : "没有找到符合条件的文献";
    empty.querySelector("p").textContent = trashEmpty
      ? "移入回收站的文献会显示在这里，可以恢复到文献库。"
      : `试着减少筛选条件，或清空搜索词。${state.query.archived ? "" : "也可以导入新的 PDF。"}`;
  }
  $("previous-page").disabled = result.offset === 0;
  $("next-page").disabled = result.offset + result.limit >= result.total;
  $("select-all").checked =
    result.items.length > 0 &&
    result.items.every((item) => state.checked.has(item.id));
  $("select-all").indeterminate =
    result.items.some((item) => state.checked.has(item.id)) &&
    !$("select-all").checked;
  renderSelection(state);
}
export function renderSelection(state) {
  $("selection-bar").hidden = state.checked.size === 0;
  $("selected-count").textContent = state.checked.size;
}
export function renderCounts(counts) {
  for (const [key, value] of Object.entries({
    all: counts.active,
    needs: counts.needsMetadata,
    unread: counts.unread,
    favorites: counts.favorites,
    trash: counts.archived,
  })) {
    $(`count-${key}`).textContent = value || 0;
  }
}
export function renderSaved(searches, selected) {
  $("saved-list").innerHTML =
    searches
      .map(
        (search) =>
          `<div class="saved-entry"><button class="saved-link ${search.id === selected ? "active" : ""}" data-saved="${search.id}"><span>⌕</span>${esc(search.name)}</button><button class="icon-button" data-search-menu="${search.id}" aria-label="管理智能集合 ${esc(search.name)}">⋯</button></div>`,
      )
      .join("") ||
    '<p class="sidebar-hint">保存常用条件，新论文会自动出现在相应集合中。</p>';
}
export function renderFilters(result, state) {
  const query = state.query;
  $("search-scope").value = query.scope || "metadata";
  $("search").placeholder =
    query.scope === "fulltext"
      ? "搜索整库 PDF 正文，支持中文与英文短语…"
      : query.scope === "all"
        ? "搜索文献信息与 PDF 正文…"
        : "搜索题名、作者、期刊、DOI 或文件名…";
  function options(dimension, label, empty) {
    const list = [...result.facets[dimension]];
    for (const key of query[dimension])
      if (!list.some((item) => item.key === key))
        list.unshift({
          key,
          label: state.labels.get(dimension + ":" + key) || key,
          count: 0,
        });
    list.forEach((item) =>
      state.labels.set(dimension + ":" + item.key, item.label),
    );
    return `<details class="facet" ${query[dimension].length ? "open" : ""}><summary>${label}<span>${query[dimension].length ? query[dimension].length + " 项" : "全部"}</span></summary><input class="facet-search" data-facet-search="${dimension}" placeholder="查找${label}…" aria-label="查找${label}选项"><div class="facet-options" data-facet-options="${dimension}">${list.length ? list.map((item) => `<label data-label="${esc(item.label.toLowerCase())}"><input type="checkbox" data-dimension="${dimension}" value="${esc(item.key)}" ${query[dimension].includes(item.key) ? "checked" : ""}><span>${esc(item.label)}</span><small>${item.count}</small></label>`).join("") : `<p class="sidebar-hint">${empty}</p>`}</div>${dimension === "authors" ? `<label class="small-select">匹配<select data-query-field="authorMatch"><option value="any" ${query.authorMatch === "any" ? "selected" : ""}>任一作者</option><option value="all" ${query.authorMatch === "all" ? "selected" : ""}>同时包含全部</option></select></label>` : dimension === "tags" ? `<label class="small-select">匹配<select data-query-field="tagMatch"><option value="any" ${query.tagMatch === "any" ? "selected" : ""}>任一标签</option><option value="all" ${query.tagMatch === "all" ? "selected" : ""}>全部标签</option></select></label>` : ""}</details>`;
  }
  const open = [...$("facets").querySelectorAll("details[open]")].map(
    (el) => el.querySelector("summary")?.textContent?.split("全部")[0],
  );
  $("facets").innerHTML =
    options("authors", "作者", "填写作者信息后，即可按姓名筛选。") +
    options("journals", "期刊", "填写期刊或会议名称后，即可按来源筛选。") +
    `<details class="facet" ${query.year.from || query.year.to || query.year.undatedOnly ? "open" : ""}><summary>发表年份<span>${query.year.undatedOnly ? "未填写" : query.year.from || query.year.to ? "已筛选" : "全部"}</span></summary><div class="year-range"><input type="number" min="1" max="9999" data-year="from" value="${query.year.from ?? ""}" placeholder="起始" aria-label="起始年份" ${query.year.undatedOnly ? "disabled" : ""}><span>—</span><input type="number" min="1" max="9999" data-year="to" value="${query.year.to ?? ""}" placeholder="结束" aria-label="结束年份" ${query.year.undatedOnly ? "disabled" : ""}></div><label class="check-line small"><input type="checkbox" data-undated ${query.year.undatedOnly ? "checked" : ""}>仅看缺少年份的文献</label></details>` +
    options("tags", "标签", "为文献添加标签后，可以按研究主题检索。") +
    `<details class="facet" ${query.readingStatuses.length || query.reviewStatuses.length ? "open" : ""}><summary>状态<span>${query.readingStatuses.length + query.reviewStatuses.length ? "已筛选" : "全部"}</span></summary><div class="facet-options">${Object.entries(
      readingLabels,
    )
      .map(
        ([key, label]) =>
          `<label><input type="checkbox" data-dimension="readingStatuses" value="${key}" ${query.readingStatuses.includes(key) ? "checked" : ""}><span>${label}</span></label>`,
      )
      .join("")}<hr>${[
      ["unverified", "待核对"],
      ["reviewed", "已核对"],
    ]
      .map(
        ([key, label]) =>
          `<label><input type="checkbox" data-dimension="reviewStatuses" value="${key}" ${query.reviewStatuses.includes(key) ? "checked" : ""}><span>${label}</span></label>`,
      )
      .join("")}</div></details>`;
  // Keep a user's expanded facet open when results refresh.
  $("facets")
    .querySelectorAll("details")
    .forEach((el) => {
      if (
        open.some((label) =>
          el
            .querySelector("summary")
            .textContent.startsWith(label?.replace(/\d+ 项$/, "").trim()),
        )
      )
        el.open = true;
    });
  const chips = [];
  if (query.text) chips.push({ kind: "text", label: "搜索：" + query.text });
  for (const dimension of ["authors", "journals", "tags"])
    for (const key of query[dimension])
      chips.push({
        kind: dimension,
        value: key,
        label:
          (dimension === "authors"
            ? "作者："
            : dimension === "journals"
              ? "期刊："
              : "标签：") + (state.labels.get(dimension + ":" + key) || key),
      });
  if (query.year.undatedOnly) chips.push({ kind: "year", label: "缺少年份" });
  else if (query.year.from || query.year.to)
    chips.push({
      kind: "year",
      label: `年份：${query.year.from || "不限"}—${query.year.to || "不限"}`,
    });
  for (const key of query.readingStatuses)
    chips.push({
      kind: "readingStatuses",
      value: key,
      label: readingLabels[key],
    });
  for (const key of query.reviewStatuses)
    chips.push({
      kind: "reviewStatuses",
      value: key,
      label: key === "reviewed" ? "已核对" : "待核对",
    });
  if (query.needsMetadata)
    chips.push({ kind: "needsMetadata", label: "待补全" });
  if (query.favoriteOnly) chips.push({ kind: "favoriteOnly", label: "已收藏" });
  $("query-chips").innerHTML =
    chips
      .map(
        (chip) =>
          `<button class="query-chip" data-remove-kind="${chip.kind}" data-remove-value="${esc(chip.value || "")}">${esc(chip.label)} <span>×</span></button>`,
      )
      .join("") ||
    '<span class="query-help">选择左侧维度进行组合检索 · 不同维度同时满足</span>';
  $("clear-filters").hidden = !chips.length;
  $("sort").value = query.sort.field + ":" + query.sort.direction;
}
