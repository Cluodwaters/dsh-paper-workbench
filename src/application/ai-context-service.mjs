import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { requireValue } from "../domain/errors.mjs";
import { annotationExcerpts } from "../adapters/zotero/ai-context.mjs";

/** Read-only, explicit context selection. No model, indexing, or document mutation. */
export class AiContextService {
  constructor({ store, dataRoot }) {
    this.store = store;
    this.dataRoot = path.resolve(dataRoot);
  }
  async source(id, expectedHash) {
    const attachment = this.store.attachment(id);
    requireValue(
      expectedHash === attachment.sourceHash,
      "SOURCE_CHANGED",
      "论文版本已变化，请重新打开论文。",
      409,
    );
    const filename = path.resolve(this.dataRoot, attachment.managedPath);
    requireValue(
      filename.startsWith(this.dataRoot + path.sep),
      "FILE_PATH",
      "Invalid managed PDF path",
      500,
    );
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(filename)) hash.update(bytes);
    requireValue(
      hash.digest("hex") === expectedHash,
      "SOURCE_CHANGED",
      "PDF 副本内容已变化，无法提供可靠的页码引用。",
      409,
    );
    return attachment;
  }
  async context(input) {
    requireValue(
      input &&
        typeof input.attachmentId === "string" &&
        typeof input.sourceHash === "string",
      "CONTEXT_INPUT",
      "缺少附件和来源版本。",
    );
    const attachment = await this.source(input.attachmentId, input.sourceHash);
    const limit = input.maxChars ?? 24000;
    requireValue(
      Number.isInteger(limit) && limit >= 256 && limit <= 40000,
      "CONTEXT_LIMIT",
      "正文长度必须在 256 至 40000 字符之间。",
    );
    const indices =
      input.pageIndices ??
      Array.from({ length: Math.min(8, attachment.pages) }, (_, i) => i);
    requireValue(
      Array.isArray(indices) &&
        indices.length > 0 &&
        indices.length <= 12 &&
        indices.every(
          (i) => Number.isInteger(i) && i >= 0 && i < attachment.pages,
        ),
      "CONTEXT_PAGES",
      "每次可提供 1 至 12 个有效页码。",
    );
    const pages = this.store.fulltext.currentPages(
      attachment.id,
      attachment.sourceHash,
    );
    requireValue(
      pages.length > 0,
      "INDEX_REQUIRED",
      "此论文尚未完成全文索引。请先在全文索引中提取正文；扫描页需要 OCR。",
      409,
    );
    const requested = [...new Set(indices)].sort((a, b) => a - b);
    let remaining = limit;
    const selected = requested.map((pageIndex) => {
      const page = pages.find((p) => p.pageIndex === pageIndex);
      requireValue(
        page,
        "INDEX_INCOMPLETE",
        "所选页的正文不可用，请重新建立索引。",
        409,
      );
      const native = page.nativeText.trim(),
        ocr = page.ocrText.trim();
      const full = [native, ocr].filter(Boolean).join("\n\n");
      const text = full.slice(0, remaining);
      remaining -= text.length;
      return {
        pageIndex,
        pageLabel: String(pageIndex + 1),
        text,
        source:
          native && ocr ? "mixed" : ocr ? "ocr" : native ? "native" : "empty",
        truncated: text.length < full.length,
      };
    });
    const item = this.store.library.get(attachment.itemId);
    return {
      version: 1,
      attachmentId: attachment.id,
      itemId: attachment.itemId,
      sourceHash: attachment.sourceHash,
      title: item.metadata.title || attachment.originalName,
      pageCount: attachment.pages,
      pages: selected,
      truncated:
        selected.some((p) => p.truncated) ||
        (input.pageIndices === undefined &&
          requested.length < attachment.pages),
    };
  }
  async annotations(id, sourceHash) {
    const attachment = await this.source(id, sourceHash);
    const snapshot = this.store.snapshot(id);
    return {
      version: 1,
      attachmentId: id,
      itemId: attachment.itemId,
      sourceHash,
      revision: snapshot.revision,
      annotations: annotationExcerpts(snapshot.annotations, attachment.pages),
      truncated: snapshot.annotations.length > 100,
    };
  }
}
