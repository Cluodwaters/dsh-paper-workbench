import { Worker } from "node:worker_threads";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { AppError, requireValue } from "../domain/errors.mjs";

/** Reads immutable source markup separately from editable application annotations. */
export class PdfSourceService {
  constructor({ dataRoot, vendorRoot }) {
    this.dataRoot = dataRoot;
    this.vendorRoot = vendorRoot;
    this.cache = new Map();
  }
  async inspect(attachment) {
    const inputPath = path.resolve(this.dataRoot, attachment.managedPath);
    requireValue(
      inputPath.startsWith(path.resolve(this.dataRoot) + path.sep),
      "FILE_PATH",
      "Invalid managed PDF path",
      500,
    );
    const info = await stat(inputPath);
    const token = `${attachment.sourceHash}:${info.size}:${info.mtimeMs}`;
    const cached = this.cache.get(attachment.id);
    if (cached?.token === token) return cached.annotations;
    const bytes = await readFile(inputPath);
    requireValue(
      createHash("sha256").update(bytes).digest("hex") ===
        attachment.sourceHash,
      "SOURCE_CHANGED",
      "PDF 副本内容已变化，已停止打开以保护标注位置。",
      409,
    );
    const annotations = await new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("../adapters/zotero/export-worker.mjs", import.meta.url),
        {
          execArgv: [],
          workerData: {
            vendorRoot: this.vendorRoot,
            inputPath,
            operation: "inspect",
          },
        },
      );
      let settled = false;
      const timer = setTimeout(
        () => finish(new AppError("PDF_TIMEOUT", "PDF 信息读取超时。", 504)),
        60000,
      );
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        error ? reject(error) : resolve(value);
      };
      worker.once("message", (message) => {
        if (message.ok) return finish(null, message.annotations);
        const password = message.error.name === "PasswordException";
        finish(
          new AppError(
            password ? "PASSWORD_REQUIRED" : "PDF_INVALID",
            password
              ? "此 PDF 需要密码。第一阶段尚未接入密码解锁与加密导出流程。"
              : message.error.message,
            422,
          ),
        );
      });
      worker.once("error", (error) => finish(error));
      worker.once("exit", (code) => {
        if (!settled)
          finish(
            new AppError("PDF_WORKER_EXIT", `PDF worker exited (${code})`, 500),
          );
      });
    });
    if (this.cache.size >= 100)
      this.cache.delete(this.cache.keys().next().value);
    this.cache.set(attachment.id, { token, annotations });
    return annotations;
  }
}
