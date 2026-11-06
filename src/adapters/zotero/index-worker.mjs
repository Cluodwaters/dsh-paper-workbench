import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createCanvas, DOMMatrix, Path2D, ImageData } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";

// PDF parsing/OCR is isolated from the HTTP process. No document JavaScript,
// network URLs, attachment contents or passwords are executed/fetched.
globalThis.DOMMatrix ??= DOMMatrix;
globalThis.Path2D ??= Path2D;
globalThis.ImageData ??= ImageData;
class CanvasFactory {
  create(width, height) {
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(target, width, height) {
    target.canvas.width = Math.ceil(width);
    target.canvas.height = Math.ceil(height);
  }
  destroy(target) {
    target.canvas.width = 1;
    target.canvas.height = 1;
    target.canvas = null;
    target.context = null;
  }
}
process.once("message", async (input) => {
  let doc, ocr;
  try {
    const { job, attachment, projectRoot, dataRoot } = input;
    const bytes = await readFile(path.join(dataRoot, attachment.managedPath));
    if (createHash("sha256").update(bytes).digest("hex") !== job.source_hash)
      throw new Error("PDF 副本校验失败，未更改原索引。");
    const pdfRoot = path.join(
      projectRoot,
      "third_party/zotero-reader/build/web/pdf",
    );
    const pdfjs = await import(
      pathToFileURL(path.join(pdfRoot, "build/pdf.mjs"))
    );
    const resource = (folder) =>
      path.join(pdfRoot, "web", folder).replaceAll("\\", "/") + "/";
    doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      CanvasFactory,
      cMapUrl: resource("cmaps"),
      cMapPacked: true,
      standardFontDataUrl: resource("standard_fonts"),
      wasmUrl: resource("wasm"),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;
    const completed = new Set(input.completed),
      previous = new Map(input.previous.map((p) => [p.pageIndex, p]));
    for (let i = 0; i < doc.numPages; i++) {
      if (completed.has(i)) continue;
      process.send({
        type: "progress",
        progress: { page: i + 1, total: doc.numPages, status: "提取正文" },
      });
      const page = await doc.getPage(i + 1),
        content = await page.getTextContent();
      const nativeText = content.items
        .filter((x) => "str" in x)
        .map((x) => x.str + (x.hasEOL ? "\n" : " "))
        .join("")
        .trim();
      if (nativeText.length > 2000000)
        throw new Error("单页文本超出处理上限，请单独检查该 PDF。");
      let ocrText = previous.get(i)?.ocrText || "",
        confidence = previous.get(i)?.confidence ?? null;
      if (
        job.mode === "force-ocr" ||
        (job.mode === "ocr" &&
          nativeText.replace(/\s/g, "").length < 30 &&
          !ocrText)
      ) {
        process.send({
          type: "progress",
          progress: {
            page: i + 1,
            total: doc.numPages,
            status: "本地 OCR · 中英双语",
          },
        });
        ocr ??= await createWorker(["chi_sim", "eng"], 1, {
          langPath: path.join(projectRoot, "resources/ocr"),
          gzip: false,
          cacheMethod: "none",
          errorHandler: (error) => {
            throw error;
          },
        });
        const base = page.getViewport({ scale: 1 }),
          scale = Math.min(3, Math.sqrt(10000000 / (base.width * base.height))),
          viewport = page.getViewport({ scale });
        const canvas = createCanvas(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        await page.render({ canvasContext: canvas.getContext("2d"), viewport })
          .promise;
        const result = await ocr.recognize(canvas.toBuffer("image/png"));
        ocrText = result.data.text.trim();
        confidence = result.data.confidence;
        canvas.width = 1;
        canvas.height = 1;
      }
      await new Promise((resolve) => {
        process.once("message", resolve);
        process.send({
          type: "page",
          page: { pageIndex: i, nativeText, ocrText, confidence },
        });
      });
      page.cleanup();
    }
    // Verify again before committing all pages. The immutable attachment hash is
    // also checked by the repository transaction.
    if (
      createHash("sha256")
        .update(await readFile(path.join(dataRoot, attachment.managedPath)))
        .digest("hex") !== job.source_hash
    )
      throw new Error("处理期间 PDF 副本发生变化，旧索引已保留。");
    process.send({ type: "done", pages: doc.numPages });
  } catch (error) {
    process.send({
      type: "error",
      message:
        error.name === "PasswordException"
          ? "此 PDF 需要密码，未建立索引。"
          : error.message,
    });
  } finally {
    await ocr?.terminate();
    await doc?.destroy();
    process.disconnect();
  }
});
