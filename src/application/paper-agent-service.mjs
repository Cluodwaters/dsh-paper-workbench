import { randomUUID } from "node:crypto";
import { requireValue } from "../domain/errors.mjs";
import { catalogRecord } from "../domain/paper-agents.mjs";

export class PaperAgentService {
  constructor({ store, context, indexer }) {
    Object.assign(this, { store, context, indexer });
    this.repository = store.agents;
    this.reads = new Map();
  }
  status() {
    return {
      autoRead: this.store.autoRead,
      jobs: this.repository
        .list()
        .map((j) => ({
          id: j.id,
          attachmentId: j.attachment_id,
          sessionId: j.session_id,
          kind: j.kind,
          state: j.state,
          pageIndex: j.progress.pageIndex || 0,
          pageCount: this.store.attachment(j.attachment_id).pages,
          title: this.store.library.get(
            this.store.attachment(j.attachment_id).itemId,
          ).metadata.title,
          error: j.error,
          updatedAt: j.updated_at,
          summaryVersion: j.result?.version || null,
        })),
    };
  }
  prepare(id) {
    const job = this.repository.job(id),
      a = this.store.attachment(job.attachment_id);
    const pages = this.store.fulltext.currentPages(a.id, a.sourceHash);
    const last = this.store.db
      .prepare(
        "SELECT * FROM text_jobs WHERE attachment_id=? AND source_hash=? ORDER BY created_at DESC,id DESC LIMIT 1",
      )
      .get(a.id, a.sourceHash);
    if (last && ["failed", "cancelled"].includes(last.status))
      return {
        ready: false,
        error: `全文索引${last.status === "failed" ? "失败" : "已取消"}：${last.error || "请在工具页重试"}`,
      };
    if (last && ["queued", "running"].includes(last.status))
      return { ready: false, waiting: "正在提取全文与 OCR" };
    const thin = pages.some(
      (p) => (p.nativeText.trim() + p.ocrText.trim()).length < 30,
    );
    if (pages.length !== a.pages || (thin && (!last || last.mode === "text"))) {
      this.indexer.enqueue([a.id], "ocr");
      return { ready: false, waiting: "正在提取全文与 OCR" };
    }
    return { ready: true, pageCount: a.pages };
  }
  async next(id, token) {
    const job = this.repository.active(id, token),
      a = await this.context.source(job.attachment_id, job.source_hash);
    const pageIndex = job.progress.pageIndex || 0,
      startOffset = job.progress.offset || 0;
    if (pageIndex >= a.pages)
      return { done: true, progress: job.progress, pageCount: a.pages };
    const page = this.store.fulltext
      .currentPages(a.id, a.sourceHash)
      .find((p) => p.pageIndex === pageIndex);
    requireValue(page, "INDEX_INCOMPLETE", "全文索引尚未就绪。", 409);
    const full = [page.nativeText.trim(), page.ocrText.trim()]
      .filter(Boolean)
      .join("\n\n");
    const text = full.slice(startOffset, startOffset + 12000),
      endOffset = startOffset + text.length;
    const receipt = randomUUID(),
      chunk = {
        pageIndex,
        startOffset,
        endOffset,
        pageComplete: endOffset >= full.length,
        source: page.nativeText.trim()
          ? page.ocrText.trim()
            ? "mixed"
            : "native"
          : page.ocrText.trim()
            ? "ocr"
            : "empty",
      };
    this.reads.set(id, { token, receipt, chunk });
    return {
      receipt,
      ...chunk,
      text,
      pageCount: a.pages,
      sourceHash: a.sourceHash,
      memory: job.progress.memory || "",
      note: "阅读后提交此 receipt 和简短笔记。空白或无法识别页面必须列入局限，图表视觉内容不在文本读取范围内。",
    };
  }
  checkpoint(id, token, input) {
    const read = this.reads.get(id);
    requireValue(
      read && read.token === token && read.receipt === input.receipt,
      "READ_RECEIPT",
      "读取凭据不存在或已失效，请重新读取当前段。",
      409,
    );
    return this.repository.checkpoint(
      id,
      token,
      read.chunk,
      input.note,
      input.memory,
    );
  }
  identify(id, token, input) {
    const read = this.reads.get(id),
      job = this.repository.active(id, token);
    const reached = Math.max(
      (job.progress.pageIndex || 0) - 1,
      read?.token === token ? read.chunk.pageIndex : -1,
    );
    requireValue(
      input.evidencePages?.every((p) => p <= reached),
      "METADATA_EVIDENCE",
      "不能引用尚未读取的页面。",
    );
    return this.repository.identify(id, token, input);
  }
  async publish(id, token, input) {
    const job = this.repository.job(id);
    await this.context.source(job.attachment_id, job.source_hash);
    const result = this.repository.publish(
      id,
      token,
      input.digest,
      input.sourceSeq,
    );
    this.reads.delete(id);
    return result;
  }
  async readPages(input) {
    const b = this.repository.bySession(input.sessionId);
    requireValue(
      b?.attachment_id,
      "SESSION_SCOPE",
      "此会话不能读取正文。",
      403,
    );
    requireValue(
      Array.isArray(input.pageIndices) &&
        input.pageIndices.length > 0 &&
        input.pageIndices.length <= 4,
      "PAGES",
      "每次读取 1 至 4 页。",
    );
    const result = await this.context.context({
      attachmentId: b.attachment_id,
      sourceHash: b.source_hash,
      pageIndices: input.pageIndices,
      maxChars: 12000,
    });
    this.store.transaction(() =>
      this.repository.recordReads(b.session_id, result.pages),
    );
    return result;
  }
  async handle(action, input = {}) {
    const r = this.repository;
    switch (action) {
      case "bindings":
        return r.bindings();
      case "binding-session":
        return r.bySession(input.sessionId) || null;
      case "bind":
        return r.ensure(input);
      case "topics":
        return r.topics(input);
      case "topic":
        return r.topic(input);
      case "mark-turn":
        return r.markTurn(input.sessionId, input.seq);
      case "read-pages":
        return this.readPages(input);
      case "task-digest":
        return r.taskDigest(input.id, input.token);
      case "attachment":
        return this.store.attachment(input.attachmentId);
      case "pending":
        return r.pending();
      case "job":
        return r.job(input.id);
      case "prepare":
        return this.prepare(input.id);
      case "claim":
        return r.claim(input.id);
      case "heartbeat":
        return r.heartbeat(input.id, input.token);
      case "stop":
        return r.stop(input.id, input.state, input.error, input.token);
      case "next":
        return this.next(input.id, input.token);
      case "checkpoint":
        return this.checkpoint(input.id, input.token, input);
      case "identify":
        return this.identify(input.id, input.token, input.metadata);
      case "publish":
        return this.publish(input.id, input.token, input);
      case "search":
        return r.search(input.query, input.offset || 0);
      case "digest":
        return r.digest(input.attachmentId);
      case "conversation-summary": {
        const b = r.bySession(input.sessionId);
        requireValue(
          b?.attachment_id,
          "SESSION_SCOPE",
          "会话无论文绑定。",
          403,
        );
        await this.context.source(b.attachment_id, b.source_hash);
        return r.conversationSummary(input);
      }
      case "item":
        return catalogRecord(this.store.library.get(input.itemId));
      case "enqueue":
        return r.enqueue(input.attachmentId, {
          kind: "research",
          instruction: input.instruction,
          requestKey: input.requestKey,
          ownerSession: input.ownerSession,
        });
      case "organize": {
        requireValue(
          input.command &&
            Object.keys(input.command.changes || {}).every((k) =>
              ["addTags", "removeTags", "favorite", "readingStatus"].includes(
                k,
              ),
            ),
          "FIELDS",
          "助手只能修改标签、收藏和阅读状态。",
        );
        return this.store.library.batch(input.command);
      }
      default:
        requireValue(false, "NOT_FOUND", "未知 Agent 操作。", 404);
    }
  }
}
