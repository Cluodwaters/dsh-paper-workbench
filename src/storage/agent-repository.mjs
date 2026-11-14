import { randomUUID } from "node:crypto";
import { requireValue } from "../domain/errors.mjs";
import {
  normalizeMetadata,
  cleanText,
  searchKey,
} from "../domain/bibliography.mjs";
import { textTokens, fulltextPhrase } from "../domain/fulltext.mjs";
import {
  INITIAL_READING,
  researchInstruction,
  validateDigest,
  catalogRecord,
} from "../domain/paper-agents.mjs";

const now = () => new Date().toISOString();
const parseJob = (row) =>
  row && {
    ...row,
    baseline: JSON.parse(row.baseline_json),
    progress: JSON.parse(row.progress_json),
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
export class AgentRepository {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }
  binding(key, role = "paper", attachmentId = null, legacyId = null) {
    const existing = this.db
      .prepare("SELECT * FROM agent_bindings WHERE binding_key=?")
      .get(key);
    if (existing) return existing;
    requireValue(
      ["paper", "master", "task", "digest"].includes(role),
      "ROLE",
      "无效会话角色。",
    );
    const attachment = attachmentId
      ? this.store.attachment(attachmentId)
      : null;
    const id = legacyId || randomUUID();
    requireValue(
      typeof id === "string" && id.length > 0 && id.length < 200,
      "SESSION_ID",
      "会话标识无效。",
    );
    this.db
      .prepare(
        "INSERT INTO agent_bindings(binding_key,session_id,role,attachment_id,source_hash,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(key, id, role, attachmentId, attachment?.sourceHash || null, now());
    return this.db
      .prepare("SELECT * FROM agent_bindings WHERE binding_key=?")
      .get(key);
  }
  bindings() {
    return this.db.prepare("SELECT * FROM agent_bindings").all();
  }
  bySession(id) {
    return typeof id === "string"
      ? this.db
          .prepare("SELECT * FROM agent_bindings WHERE session_id=?")
          .get(id)
      : null;
  }
  scope(role, attachmentId) {
    requireValue(["paper", "master"].includes(role), "ROLE", "无效会话角色。");
    if (role === "paper") {
      requireValue(
        typeof attachmentId === "string" &&
          attachmentId.length > 0 &&
          attachmentId.length <= 200,
        "ATTACHMENT_ID",
        "请先打开一篇论文，再选择论文会话。",
      );
      const a = this.store.attachment(attachmentId);
      requireValue(
        !this.store.library.get(a.itemId).archivedAt,
        "ITEM_ARCHIVED",
        "论文已移入回收站。",
        409,
      );
    }
    return role === "master" ? "master:default" : `paper:${attachmentId}`;
  }
  ensure({ role = "paper", attachmentId, legacyId }) {
    return this.store.transaction(() => {
      const key = this.scope(role, attachmentId),
        head = this.db
          .prepare("SELECT session_id FROM agent_heads WHERE scope_key=?")
          .get(key);
      if (head) return this.bySession(head.session_id);
      const b = this.binding(
        key,
        role,
        role === "paper" ? attachmentId : null,
        legacyId,
      );
      this.db
        .prepare("INSERT INTO agent_heads VALUES(?,?)")
        .run(key, b.session_id);
      return b;
    });
  }
  topics({ role = "paper", attachmentId }) {
    const key = this.scope(role, attachmentId);
    return {
      current: this.db
        .prepare("SELECT session_id FROM agent_heads WHERE scope_key=?")
        .get(key)?.session_id,
      items: this.db
        .prepare(
          "SELECT session_id,created_at,binding_key,published_seq,summary_turn_seq FROM agent_bindings WHERE role=? AND attachment_id IS ? ORDER BY created_at DESC LIMIT 50",
        )
        .all(role, role === "paper" ? attachmentId : null),
    };
  }
  topic({ role = "paper", attachmentId, sessionId, requestId }) {
    return this.store.transaction(() => {
      const key = this.scope(role, attachmentId);
      let b;
      if (sessionId) {
        b = this.bySession(sessionId);
        requireValue(
          b?.role === role &&
            b.attachment_id === (role === "paper" ? attachmentId : null),
          "SESSION_SCOPE",
          "不能切换到其他论文或角色的会话。",
          403,
        );
      } else {
        requireValue(
          typeof requestId === "string" &&
            /^[a-zA-Z0-9-]{1,100}$/.test(requestId),
          "REQUEST_ID",
          "新话题需要重试标识。",
        );
        b = this.binding(
          `${key}:topic:${requestId}`,
          role,
          role === "paper" ? attachmentId : null,
        );
      }
      this.db
        .prepare(
          "INSERT INTO agent_heads VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET session_id=excluded.session_id",
        )
        .run(key, b.session_id);
      return b;
    });
  }
  markTurn(sessionId, seq) {
    requireValue(
      Number.isSafeInteger(seq) && seq >= 0,
      "SESSION_SEQ",
      "无效会话位置。",
    );
    this.db
      .prepare(
        "UPDATE agent_bindings SET summary_turn_seq=MAX(summary_turn_seq,?) WHERE session_id=? AND role='paper'",
      )
      .run(seq, sessionId);
    return { ok: true };
  }
  recordReads(sessionId, pages) {
    const b = this.bySession(sessionId);
    requireValue(
      b?.attachment_id,
      "SESSION_SCOPE",
      "此会话不能读取正文。",
      403,
    );
    const insert = this.db.prepare(
      "INSERT INTO agent_page_reads VALUES(?,?,?,?) ON CONFLICT(session_id,source_hash,page_index) DO UPDATE SET complete=MAX(complete,excluded.complete)",
    );
    for (const p of pages)
      if (p.text === undefined || p.text.length || p.source === "empty")
        insert.run(sessionId, b.source_hash, p.pageIndex, p.truncated ? 0 : 1);
    return { ok: true };
  }
  reads(sessionId) {
    const b = this.bySession(sessionId);
    return this.db
      .prepare(
        "SELECT page_index AS pageIndex,complete FROM agent_page_reads WHERE session_id=? AND source_hash=?",
      )
      .all(sessionId, b.source_hash);
  }
  taskDigest(id, token) {
    const j = this.active(id, token),
      d = this.digest(j.attachment_id);
    this.db
      .prepare("UPDATE paper_jobs SET progress_json=? WHERE id=?")
      .run(
        JSON.stringify({ ...j.progress, expectedVersion: d.version || 0 }),
        id,
      );
    return d;
  }
  enqueue(
    attachmentId,
    {
      kind = "initial",
      instruction = INITIAL_READING,
      requestKey,
      ownerSession = null,
    } = {},
  ) {
    const a = this.store.attachment(attachmentId),
      item = this.store.library.get(a.itemId);
    requireValue(
      !item.archivedAt,
      "ITEM_ARCHIVED",
      "回收站中的论文不运行 AI。",
      409,
    );
    const key = requestKey || `initial:${a.id}:${a.sourceHash}`;
    const existing = this.db
      .prepare("SELECT * FROM paper_jobs WHERE request_key=?")
      .get(key);
    if (existing) return parseJob(existing);
    const id = randomUUID(),
      binding = this.binding(
        kind === "initial" ? `paper:${a.id}` : `task:${id}`,
        kind === "initial" ? "paper" : kind === "digest" ? "digest" : "task",
        a.id,
      );
    const baseline = {
      revision: item.revision,
      metadata: item.metadata,
      ownerSession,
    };
    this.db
      .prepare(
        "INSERT INTO paper_jobs(id,request_key,attachment_id,source_hash,session_id,kind,instruction,baseline_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        key,
        a.id,
        a.sourceHash,
        binding.session_id,
        kind,
        kind === "research"
          ? researchInstruction(instruction)
          : cleanText(instruction, 4000),
        JSON.stringify(baseline),
        now(),
        now(),
      );
    if (kind === "initial")
      this.db
        .prepare("INSERT OR IGNORE INTO agent_heads VALUES(?,?)")
        .run(`paper:${a.id}`, binding.session_id);
    return this.job(id);
  }
  job(id) {
    const j = parseJob(
      this.db.prepare("SELECT * FROM paper_jobs WHERE id=?").get(id),
    );
    requireValue(j, "NOT_FOUND", "任务不存在。", 404);
    return j;
  }
  list(limit = 50) {
    return this.db
      .prepare("SELECT * FROM paper_jobs ORDER BY created_at DESC,id LIMIT ?")
      .all(Math.min(100, Math.max(1, limit)))
      .map(parseJob);
  }
  pending() {
    this.db
      .prepare(
        "UPDATE paper_jobs SET state='queued',lease_token=NULL,lease_until=NULL,error='上次运行中断，等待继续',updated_at=? WHERE state='running' AND lease_until<?",
      )
      .run(now(), Date.now());
    this.db
      .prepare(
        "UPDATE paper_jobs SET state='cancelled',error='论文已移入回收站',lease_token=NULL,lease_until=NULL,updated_at=? WHERE state IN ('queued','running') AND attachment_id IN (SELECT a.id FROM attachments a JOIN item_metadata m ON m.item_id=a.item_id WHERE m.archived_at IS NOT NULL)",
      )
      .run(now());
    return this.db
      .prepare(
        "SELECT * FROM paper_jobs WHERE state='queued' ORDER BY CASE kind WHEN 'research' THEN 0 ELSE 1 END,created_at LIMIT 10",
      )
      .all()
      .map(parseJob);
  }
  claim(id) {
    return this.store.transaction(() => {
      const job = this.job(id);
      requireValue(
        job.state === "queued",
        "JOB_ACTIVE",
        "任务不在队列中。",
        409,
      );
      const a = this.store.attachment(job.attachment_id);
      requireValue(
        !this.store.library.get(a.itemId).archivedAt,
        "ITEM_ARCHIVED",
        "回收站中的论文不运行 AI。",
        409,
      );
      requireValue(
        a.sourceHash === job.source_hash,
        "SOURCE_CHANGED",
        "论文版本已变化。",
        409,
      );
      const token = randomUUID();
      this.db
        .prepare(
          "UPDATE paper_jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1,error=NULL,updated_at=? WHERE id=?",
        )
        .run(token, Date.now() + 90000, now(), id);
      return this.job(id);
    });
  }
  active(id, token) {
    const job = this.job(id);
    requireValue(
      job.state === "running" &&
        job.lease_token === token &&
        job.lease_until > Date.now(),
      "JOB_STOPPED",
      "任务已停止或租约失效。",
      409,
    );
    const a = this.store.attachment(job.attachment_id),
      item = this.store.library.get(a.itemId);
    requireValue(
      a.sourceHash === job.source_hash && !item.archivedAt,
      "SOURCE_CHANGED",
      "论文版本或状态已变化。",
      409,
    );
    return job;
  }
  heartbeat(id, token) {
    this.active(id, token);
    this.db
      .prepare("UPDATE paper_jobs SET lease_until=? WHERE id=?")
      .run(Date.now() + 90000, id);
    return { ok: true };
  }
  stop(id, state, error, token, expectedState) {
    requireValue(
      ["failed", "cancelled", "queued"].includes(state),
      "JOB_STATE",
      "任务状态无效。",
    );
    const job = this.job(id);
    if (token) this.active(id, token);
    if (expectedState)
      requireValue(
        job.state === expectedState,
        "JOB_STATE_CHANGED",
        "任务状态已变化。",
        409,
      );
    requireValue(
      job.state !== "completed",
      "JOB_FINISHED",
      "已完成的任务不能覆盖。",
      409,
    );
    this.db
      .prepare(
        "UPDATE paper_jobs SET state=?,error=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?",
      )
      .run(state, cleanText(error, 1000) || null, now(), id);
    return this.job(id);
  }
  checkpoint(id, token, chunk, note, memory) {
    return this.store.transaction(() => {
      const job = this.active(id, token),
        cursor = `${chunk.pageIndex}:${chunk.startOffset}`;
      const known = this.db
        .prepare("SELECT * FROM paper_checkpoints WHERE job_id=? AND cursor=?")
        .get(id, cursor);
      if (known) return job.progress;
      const progress = job.progress;
      requireValue(
        (progress.pageIndex || 0) === chunk.pageIndex &&
          (progress.offset || 0) === chunk.startOffset,
        "CHECKPOINT_CONFLICT",
        "读取位置已经更新。",
        409,
      );
      const next = {
        ...progress,
        pageIndex: chunk.pageComplete ? chunk.pageIndex + 1 : chunk.pageIndex,
        offset: chunk.pageComplete ? 0 : chunk.endOffset,
        memory: cleanText(memory, 7000),
        gaps: [
          ...(progress.gaps || []),
          ...(chunk.source === "empty" ? [chunk.pageIndex] : []),
        ],
      };
      this.db
        .prepare("INSERT INTO paper_checkpoints VALUES(?,?,?,?,?)")
        .run(
          id,
          cursor,
          chunk.pageIndex,
          chunk.endOffset,
          cleanText(note, 800),
        );
      this.db
        .prepare(
          "UPDATE paper_jobs SET progress_json=?,updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(next), now(), id);
      this.recordReads(job.session_id, [
        { pageIndex: chunk.pageIndex, truncated: !chunk.pageComplete },
      ]);
      return next;
    });
  }
  identify(id, token, input) {
    return this.store.transaction(() => {
      const job = this.active(id, token),
        a = this.store.attachment(job.attachment_id),
        current = this.store.library.get(a.itemId);
      requireValue(
        job.kind === "initial",
        "JOB_KIND",
        "只有自动初读任务可以填写书目信息。",
        403,
      );
      requireValue(
        input &&
          Array.isArray(input.evidencePages) &&
          input.evidencePages.length > 0 &&
          input.evidencePages.every(
            (p) => Number.isInteger(p) && p >= 0 && p < a.pages,
          ),
        "METADATA_EVIDENCE",
        "书目信息需要来源页码。",
      );
      if (
        job.result?.metadata &&
        JSON.stringify(job.result.metadata.candidate) === JSON.stringify(input)
      )
        return job.result.metadata;
      const prior = job.result?.metadata,
        metadata = { ...current.metadata },
        applied = [],
        skipped = [];
      const mayWrite =
        current.revision ===
          (prior?.appliedRevision ?? job.baseline.revision) &&
        current.metadata.reviewStatus !== "reviewed";
      for (const field of ["title", "authors", "journal", "year"]) {
        const value = input[field];
        if (
          value === undefined ||
          value === null ||
          value === "" ||
          (Array.isArray(value) && !value.length)
        )
          continue;
        const empty =
          field === "authors" ? !metadata.authors.length : !metadata[field];
        const importedTitle =
          field === "title" &&
          job.baseline.revision === 0 &&
          !prior?.applied.includes("title");
        if (mayWrite && (empty || importedTitle)) {
          metadata[field] = value;
          applied.push(field);
        } else skipped.push(field);
      }
      if (applied.length)
        this.store.library.write(
          a.itemId,
          normalizeMetadata(metadata),
          current.revision + 1,
          current.archivedAt,
        );
      const result = {
        ...(job.result || {}),
        metadata: {
          candidate: input,
          applied: [...new Set([...(prior?.applied || []), ...applied])],
          skipped,
          sourceHash: a.sourceHash,
          appliedRevision: applied.length
            ? current.revision + 1
            : (prior?.appliedRevision ?? job.baseline.revision),
        },
      };
      this.db
        .prepare("UPDATE paper_jobs SET result_json=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(result), now(), id);
      return result.metadata;
    });
  }
  publish(id, token, value, sourceSeq) {
    return this.store.transaction(() => {
      const previous = this.job(id);
      if (previous.state === "completed") return previous.result;
      const job = this.active(id, token),
        a = this.store.attachment(job.attachment_id);
      const previousDigest = this.digest(a.id);
      requireValue(
        (previousDigest.version || 0) === (job.progress.expectedVersion || 0),
        "SUMMARY_CONFLICT",
        "摘要已更新，请先获取最新摘要后合并。",
        409,
      );
      if (job.kind === "initial")
        requireValue(
          job.progress.pageIndex === a.pages,
          "READ_INCOMPLETE",
          "全文尚未读完，不能发布初读摘要。",
          409,
        );
      else
        requireValue(
          this.reads(job.session_id).length > 0,
          "READ_INCOMPLETE",
          "委派任务至少需要按需读取相关原文。",
          409,
        );
      requireValue(
        Number.isSafeInteger(sourceSeq) && sourceSeq > 0,
        "SESSION_UNSAVED",
        "会话尚未确认持久化。",
        409,
      );
      const validated = validateDigest(value, a.pages),
        coverage = this.coverage(a, job.session_id, previousDigest);
      requireValue(
        validated.evidencePages.every((p) => coverage.evidence.has(p)),
        "DIGEST_EVIDENCE",
        "摘要不能引用尚未读取的页面。",
        409,
      );
      const digest = {
        ...validated,
        coverage: {
          ...coverage.value,
          gaps: [
            ...new Set([
              ...(coverage.value.gaps || []),
              ...(job.progress.gaps || []),
            ]),
          ],
        },
        kind: job.kind,
      };
      const version = this.db
        .prepare(
          "SELECT COALESCE(MAX(version),0)+1 AS n FROM paper_digests WHERE attachment_id=?",
        )
        .get(a.id).n;
      const inserted = this.db
        .prepare(
          "INSERT INTO paper_digests(attachment_id,source_hash,session_id,source_seq,version,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          a.id,
          a.sourceHash,
          job.session_id,
          sourceSeq,
          version,
          JSON.stringify(digest),
          now(),
        );
      this.db
        .prepare("INSERT INTO paper_digest_fts(digest_id,tokens) VALUES(?,?)")
        .run(
          Number(inserted.lastInsertRowid),
          textTokens(
            Object.values(digest)
              .filter((v) => typeof v === "string")
              .join(" "),
          ).join(" "),
        );
      this.db
        .prepare("UPDATE agent_bindings SET published_seq=? WHERE session_id=?")
        .run(sourceSeq, job.session_id);
      const result = { ...(job.result || {}), digest, version };
      this.db
        .prepare(
          "UPDATE paper_jobs SET state='completed',result_json=?,lease_token=NULL,lease_until=NULL,error=NULL,updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(result), now(), id);
      return result;
    });
  }
  digest(attachmentId) {
    const a = this.store.attachment(attachmentId),
      item = this.store.library.get(a.itemId);
    requireValue(!item.archivedAt, "ITEM_ARCHIVED", "论文已移入回收站。", 409);
    const row = this.db
      .prepare(
        "SELECT * FROM paper_digests WHERE attachment_id=? ORDER BY version DESC LIMIT 1",
      )
      .get(attachmentId);
    return row
      ? {
          attachmentId,
          version: row.version,
          sourceHash: row.source_hash,
          sessionId: row.session_id,
          sourceSeq: row.source_seq,
          updatedAt: row.created_at,
          stale: row.source_hash !== a.sourceHash,
          summary: JSON.parse(row.payload_json),
        }
      : { attachmentId, summary: null, status: "unread" };
  }
  coverage(a, sessionId, previous) {
    const old = !previous?.stale ? previous?.summary?.coverage : null,
      reads = this.reads(sessionId);
    const known =
      old?.readPages === a.pages
        ? Array.from({ length: a.pages }, (_, i) => i)
        : old?.readPageIndices || [];
    const complete = [
      ...new Set([
        ...known,
        ...reads.filter((p) => p.complete).map((p) => p.pageIndex),
      ]),
    ].sort((x, y) => x - y);
    return {
      evidence: new Set([
        ...known,
        ...(!previous?.stale ? previous?.summary?.evidencePages || [] : []),
        ...reads.map((p) => p.pageIndex),
      ]),
      value: {
        pageCount: a.pages,
        readPages: complete.length,
        ...(complete.length < a.pages ? { readPageIndices: complete } : {}),
        gaps: old?.gaps || [],
        visuals: "text-and-ocr-only",
      },
    };
  }
  conversationSummary({ sessionId, digest, sourceSeq, expectedVersion }) {
    return this.store.transaction(() => {
      const binding = this.bySession(sessionId);
      requireValue(
        binding?.role === "paper",
        "SESSION_SCOPE",
        "只有论文阅读会话可以更新此摘要。",
        403,
      );
      const a = this.store.attachment(binding.attachment_id),
        previous = this.digest(a.id);
      requireValue(
        !previous.stale && (previous.version || 0) === expectedVersion,
        "SUMMARY_CONFLICT",
        "摘要已更新，请重新读取后合并。",
        409,
      );
      requireValue(
        Number.isSafeInteger(sourceSeq) && sourceSeq > binding.published_seq,
        "SUMMARY_STALE",
        "此轮摘要已保存或会话尚未保存。",
        409,
      );
      const validated = validateDigest(digest, a.pages),
        coverage = this.coverage(a, sessionId, previous);
      requireValue(
        validated.evidencePages.every((p) => coverage.evidence.has(p)),
        "DIGEST_EVIDENCE",
        "摘要不能引用尚未读取的页面。",
        409,
      );
      const payload = {
        ...validated,
        kind: "conversation",
        coverage: coverage.value,
      };
      const version = expectedVersion + 1;
      const insert = this.db
        .prepare(
          "INSERT INTO paper_digests(attachment_id,source_hash,session_id,source_seq,version,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          a.id,
          a.sourceHash,
          sessionId,
          sourceSeq,
          version,
          JSON.stringify(payload),
          now(),
        );
      this.db
        .prepare("INSERT INTO paper_digest_fts(digest_id,tokens) VALUES(?,?)")
        .run(
          Number(insert.lastInsertRowid),
          textTokens(
            Object.values(payload)
              .filter((v) => typeof v === "string")
              .join(" "),
          ).join(" "),
        );
      this.db
        .prepare("UPDATE agent_bindings SET published_seq=? WHERE session_id=?")
        .run(sourceSeq, sessionId);
      return { saved: true, version };
    });
  }
  search(query = "", offset = 0) {
    const text = cleanText(query, 300);
    requireValue(
      Number.isSafeInteger(offset) && offset >= 0,
      "OFFSET",
      "分页位置无效。",
    );
    const words = searchKey(text).split(/\s+/).filter(Boolean).slice(0, 12);
    const allowedText =
      "m.title || ' ' || COALESCE(m.year,'') || ' ' || m.journal_key || ' ' || m.doi || ' ' || COALESCE((SELECT group_concat(label,' ') FROM item_authors WHERE item_id=m.item_id),'') || ' ' || COALESCE((SELECT group_concat(label,' ') FROM item_tags WHERE item_id=m.item_id),'')";
    const where =
      "m.archived_at IS NULL" +
      words.map(() => ` AND instr(pw_search(${allowedText}),?)>0`).join("");
    const total = this.db
      .prepare(`SELECT count(*) AS n FROM item_metadata m WHERE ${where}`)
      .get(...words).n;
    const catalog = {
      total,
      items: this.db
        .prepare(
          `SELECT m.item_id AS id FROM item_metadata m WHERE ${where} ORDER BY m.updated_at DESC,m.item_id LIMIT 20 OFFSET ?`,
        )
        .all(...words, offset),
    };
    const phrase = fulltextPhrase(text),
      hits = phrase
        ? this.db
            .prepare(
              `SELECT DISTINCT d.attachment_id FROM paper_digest_fts f JOIN paper_digests d ON d.id=f.digest_id JOIN attachments a ON a.id=d.attachment_id JOIN item_metadata m ON m.item_id=a.item_id WHERE paper_digest_fts MATCH ? AND m.archived_at IS NULL AND d.source_hash=a.sha256 AND d.version=(SELECT MAX(x.version) FROM paper_digests x WHERE x.attachment_id=d.attachment_id) ORDER BY bm25(paper_digest_fts) LIMIT 8`,
            )
            .all(phrase)
        : [];
    const ids = [
      ...new Set([
        ...catalog.items.map((x) => x.id),
        ...hits.map((x) => this.store.attachment(x.attachment_id).itemId),
      ]),
    ].slice(0, 20);
    return {
      totalMetadataMatches: catalog.total,
      offset,
      nextOffset:
        offset + catalog.items.length < catalog.total
          ? offset + catalog.items.length
          : null,
      items: ids.map((id) => catalogRecord(this.store.library.get(id))),
      summaryMatches: hits.map((x) => ({ attachmentId: x.attachment_id })),
      note: "仅检索元数据和已保存摘要；没有检索论文正文。",
    };
  }
}
