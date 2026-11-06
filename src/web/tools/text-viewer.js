import { api } from "../persistence-client.js";
import { modal, esc, toast } from "../library/dom.js";

export async function showPageText(id, initialPage = 0) {
  const pages = await api(`/api/index/text/${id}`);
  await modal({
    title: "PDF 正文与 OCR",
    confirm: null,
    wide: true,
    content: `<div class="text-view-toolbar"><label>页码 <select id="text-page">${pages.map((p) => `<option value="${p.pageIndex}" ${p.pageIndex === initialPage ? "selected" : ""}>第 ${p.pageIndex + 1} 页</option>`).join("")}</select></label><a href="./api/index/text/${id}?download=1">导出全文 TXT</a><button type="button" id="text-ocr">识别此文件扫描页</button></div><p class="small muted" id="text-method"></p><pre class="text-viewer" id="page-text"></pre>`,
    onReady(dialog) {
      const select = dialog.querySelector("#text-page");
      function render() {
        const page = pages.find((p) => p.pageIndex === Number(select.value));
        dialog.querySelector("#text-method").textContent = page?.ocrText
          ? "包含 OCR 识别结果，请对照原页核对。"
          : "PDF 原生文字提取";
        dialog.querySelector("#page-text").textContent = page
          ? page.nativeText +
              (page.ocrText ? "\n\n[OCR]\n" + page.ocrText : "") ||
            "此页尚无文字，可尝试 OCR。"
          : "尚未建立正文索引，请在全文索引页面查看进度。";
      }
      select.onchange = render;
      render();
      dialog.querySelector("#text-ocr").onclick = async (event) => {
        event.target.disabled = true;
        try {
          await api("/api/index/queue", { ids: [id], mode: "ocr" });
          toast("已加入本地 OCR 队列，可在全文索引页面查看进度。");
        } catch (e) {
          toast(e.message, true);
        } finally {
          event.target.disabled = false;
        }
      };
    },
  });
}
