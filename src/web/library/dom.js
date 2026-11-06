export const $ = (id) => document.getElementById(id);
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const readingLabels = { unread: "未读", reading: "在读", read: "已读" };
export const typeLabels = {
  "article-journal": "期刊论文",
  "paper-conference": "会议论文",
  thesis: "学位论文",
  book: "书籍",
  chapter: "书籍章节",
  report: "报告",
  article: "其他 / 未分类",
};
export const fieldLabels = {
  title: "题名",
  authors: "作者",
  type: "文献类型",
  year: "年份与出版日期",
  journal: "期刊 / 会议",
  doi: "DOI",
  volume: "卷",
  issue: "期",
  pages: "页码",
  publisher: "出版者",
  url: "文献链接",
};
export function downloadJSON(value, name) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], {
      type: "application/json;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
let toastTimer;
export function toast(text, error = false) {
  const node = $("toast");
  node.textContent = text;
  node.className = "toast" + (error ? " error" : "");
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), error ? 8000 : 4500);
}
export const KEEP_OPEN = Symbol("keep-open");
export function modal({
  title,
  content,
  confirm = "保存",
  wide = false,
  onSubmit,
  onReady,
}) {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog" + (wide ? " wide" : "");
  dialog.innerHTML = `<form novalidate><div class="dialog-head"><h2>${esc(title)}</h2><button type="button" class="icon-button" data-close aria-label="关闭对话框">×</button></div><div class="dialog-content">${content}</div><p class="form-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" data-close>取消</button>${confirm ? `<button type="submit" class="primary">${esc(confirm)}</button>` : '<button type="button" class="primary" data-close>完成</button>'}</div></form>`;
  document.body.append(dialog);
  const promise = new Promise((resolve) => {
    let value;
    dialog.addEventListener(
      "close",
      () => {
        dialog.remove();
        resolve(value);
      },
      { once: true },
    );
    dialog
      .querySelectorAll("[data-close]")
      .forEach((button) =>
        button.addEventListener("click", () => dialog.close()),
      );
    dialog.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const error = dialog.querySelector(".form-error");
      error.hidden = true;
      const submit = dialog.querySelector("[type=submit]");
      if (submit) submit.disabled = true;
      try {
        const result = await onSubmit?.(new FormData(event.target), dialog);
        if (result !== KEEP_OPEN) {
          value = result;
          dialog.close();
        }
      } catch (exception) {
        error.textContent = exception.message;
        error.hidden = false;
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  });
  dialog.showModal();
  onReady?.(dialog);
  return promise;
}
export const dateLabel = (value) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
