import { Worker } from "node:worker_threads";
import {
  mkdir,
  open,
  unlink,
  copyFile,
  readFile,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { AppError, requireValue } from "../domain/errors.mjs";

export class ImportService {
  constructor({ store, dataRoot, vendorRoot, maxBytes = 200 * 1024 * 1024 }) {
    this.store = store;
    this.dataRoot = dataRoot;
    this.vendorRoot = vendorRoot;
    this.maxBytes = maxBytes;
    this.tail = Promise.resolve();
  }
  async import(request, name, { itemId } = {}) {
    requireValue(
      typeof name === "string" &&
        name.length > 0 &&
        name.length <= 1000 &&
        /\.pdf$/i.test(name),
      "PDF_NAME",
      "请选择 PDF 文件。",
    );
    const originalName = path.basename(name.replaceAll("\\", "/"));
    const incoming = path.join(this.dataRoot, ".incoming");
    await mkdir(incoming, { recursive: true });
    const temporary = path.join(incoming, randomUUID() + ".tmp");
    const file = await open(temporary, "wx");
    let size = 0,
      head = Buffer.alloc(0);
    const hash = createHash("sha256");
    try {
      for await (const chunk of request) {
        size += chunk.length;
        requireValue(
          size <= this.maxBytes,
          "PDF_TOO_LARGE",
          `单个 PDF 不能超过 ${Math.round(this.maxBytes / 1048576)} MB。`,
          413,
        );
        if (head.length < 1024)
          head = Buffer.concat([head, chunk.subarray(0, 1024 - head.length)]);
        await file.writeFile(chunk);
        hash.update(chunk);
      }
      await file.sync();
    } catch (error) {
      await file.close();
      await unlink(temporary).catch(() => {});
      throw error;
    }
    await file.close();
    try {
      requireValue(
        size > 0 && head.includes(Buffer.from("%PDF-")),
        "PDF_INVALID",
        "文件不包含有效的 PDF 文件头。",
        422,
      );
      const digest = hash.digest("hex");
      const execute = () =>
        this.commit(
          temporary,
          { originalName, sha256: digest, bytes: size },
          itemId,
        );
      const task = this.tail.then(execute, execute);
      this.tail = task.catch(() => {});
      return await task;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  duplicate(hash) {
    return this.store.db
      .prepare(
        "SELECT id,item_id AS itemId FROM attachments WHERE sha256=? ORDER BY created_at LIMIT 1",
      )
      .get(hash);
  }
  async commit(temporary, info, itemId) {
    if (itemId)
      requireValue(
        !this.store.library.get(itemId).archivedAt,
        "ITEM_ARCHIVED",
        "请先从回收站恢复文献，再关联 PDF。",
        409,
      );
    const duplicate = this.duplicate(info.sha256);
    if (duplicate) {
      requireValue(
        !itemId || itemId === duplicate.itemId,
        "PDF_ALREADY_LINKED",
        "这个 PDF 已关联到另一条文献，未重复导入。",
        409,
      );
      return {
        duplicate: true,
        item: this.store.library.get(duplicate.itemId),
        attachmentId: duplicate.id,
      };
    }
    const probed = await this.probe(temporary);
    requireValue(
      Number.isInteger(probed.pages) && probed.pages > 0,
      "PDF_INVALID",
      "PDF 没有可读取的页面。",
      422,
    );
    const directory = path.join(this.dataRoot, "files");
    await mkdir(directory, { recursive: true });
    const relative = path.join("files", info.sha256 + ".pdf"),
      target = path.join(this.dataRoot, relative);
    let created = false;
    try {
      try {
        await copyFile(temporary, target, constants.COPYFILE_EXCL);
        created = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        requireValue(
          createHash("sha256")
            .update(await readFile(target))
            .digest("hex") === info.sha256,
          "SOURCE_CHANGED",
          "同名存储文件的内容不一致，导入已停止。",
          409,
        );
      }
      const synced = await open(target, "r+");
      try {
        await synced.sync();
      } finally {
        await synced.close();
      }
      const candidateTitle = probed.pdfTitle?.trim();
      const title =
        candidateTitle && candidateTitle.length <= 4000
          ? candidateTitle
          : info.originalName.replace(/\.pdf$/i, "");
      const id = this.store.addAttachment(
        {
          ...info,
          id: "import-" + info.sha256,
          pages: probed.pages,
          pdfTitle: title,
        },
        relative,
        { itemId },
      );
      return {
        duplicate: false,
        item: this.store.library.get(this.store.attachment(id).itemId),
        attachmentId: id,
      };
    } catch (error) {
      if (created && !this.duplicate(info.sha256))
        await unlink(target).catch(() => {});
      throw error;
    }
  }
  probe(inputPath) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("../adapters/zotero/pdf-probe-worker.mjs", import.meta.url),
        {
          execArgv: [],
          workerData: { vendorRoot: this.vendorRoot, inputPath },
        },
      );
      let done = false;
      const timeout = setTimeout(
        () =>
          finish(
            new AppError(
              "PDF_TIMEOUT",
              "PDF 检查超时，请单独重试此文件。",
              504,
            ),
          ),
        120000,
      );
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        worker.terminate();
        error ? reject(error) : resolve(value);
      };
      worker.once("message", (message) =>
        message.ok
          ? finish(null, message)
          : finish(
              new AppError(
                message.name === "PasswordException"
                  ? "PASSWORD_REQUIRED"
                  : "PDF_INVALID",
                message.name === "PasswordException"
                  ? "此文件需要密码，目前暂不支持导入加密 PDF。"
                  : message.error,
                422,
              ),
            ),
      );
      worker.once("error", (error) => finish(error));
      worker.once("exit", (code) => {
        if (!done)
          finish(
            new AppError("PDF_WORKER_EXIT", `PDF 检查进程退出 (${code})`, 500),
          );
      });
    });
  }
}
