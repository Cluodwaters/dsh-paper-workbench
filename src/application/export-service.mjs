import { Worker } from "node:worker_threads";
import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { requireValue, AppError } from "../domain/errors.mjs";

export class ExportService {
  constructor({ store, dataRoot, vendorRoot }) {
    this.store = store;
    this.dataRoot = dataRoot;
    this.vendorRoot = vendorRoot;
    this.tail = Promise.resolve();
  }
  export(id, expectedRevision) {
    const snapshot = this.store.snapshot(id);
    requireValue(
      snapshot.revision === expectedRevision,
      "REVISION_CONFLICT",
      "Save state changed before export",
      409,
    );
    const attachment = this.store.attachment(id);
    const execute = () => this.run(attachment, snapshot);
    const task = this.tail.then(execute, execute);
    this.tail = task.catch(() => {});
    return task;
  }
  async run(attachment, snapshot) {
    const inputPath = path.resolve(this.dataRoot, attachment.managedPath);
    requireValue(
      inputPath.startsWith(path.resolve(this.dataRoot) + path.sep),
      "FILE_PATH",
      "Invalid managed file path",
      500,
    );
    const original = await readFile(inputPath);
    requireValue(
      createHash("sha256").update(original).digest("hex") ===
        snapshot.sourceHash,
      "SOURCE_CHANGED",
      "Managed PDF changed; export stopped to preserve annotation positions",
      409,
    );
    const buffer = await new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("../adapters/zotero/export-worker.mjs", import.meta.url),
        {
          execArgv: [],
          workerData: {
            vendorRoot: this.vendorRoot,
            inputPath,
            annotations: snapshot.annotations,
          },
        },
      );
      let settled = false;
      const timer = setTimeout(
        () =>
          finish(
            new AppError(
              "EXPORT_TIMEOUT",
              "PDF export exceeded 120 seconds",
              504,
            ),
          ),
        120000,
      );
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        if (error) reject(error);
        else resolve(result);
      };
      worker.once("message", (message) =>
        message.ok
          ? finish(null, Buffer.from(message.buffer))
          : finish(new AppError("PDF_EXPORT", message.error.message, 422)),
      );
      worker.once("error", (error) => finish(error));
      worker.once("exit", (code) => {
        if (!settled)
          finish(
            new AppError(
              "EXPORT_WORKER_EXIT",
              `PDF worker exited (${code})`,
              500,
            ),
          );
      });
    });
    const id = randomUUID();
    const relativePath = path.join(
      "exports",
      `${attachment.sampleKey || attachment.id}-r${snapshot.revision}-${id}.pdf`,
    );
    const finalPath = path.join(this.dataRoot, relativePath);
    await mkdir(path.dirname(finalPath), { recursive: true });
    const tempPath = finalPath + ".tmp";
    const file = await open(tempPath, "wx");
    try {
      await file.writeFile(buffer);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tempPath, finalPath);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    try {
      this.store.addExport({
        id,
        attachmentId: attachment.id,
        sourceHash: snapshot.sourceHash,
        revision: snapshot.revision,
        snapshot,
        relativePath,
        sha256,
      });
    } catch (error) {
      await unlink(finalPath).catch(() => {});
      throw error;
    }
    return {
      id,
      revision: snapshot.revision,
      sha256,
      fileName: path.basename(finalPath),
      downloadUrl: `/api/exports/${id}`,
      annotationCount: snapshot.annotations.length,
    };
  }
}
