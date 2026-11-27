import { randomUUID } from "node:crypto";
import { requireValue } from "../domain/errors.mjs";
import {
  normalizeMetadata,
  cleanText,
  searchKey,
} from "../domain/bibliography.mjs";
import { textTokens, fulltextPhrase, searchPieces } from "../domain/fulltext.mjs";
import {
  INITIAL_READING,
  researchBriefing,
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
function mergePageRead(previous, page) {
  const start = page.startOffset || 0;
  const read = { pageIndex: page.pageIndex, complete: 1 };
  if (previous?.complete || (!start && !page.truncated)) return read;
  const intervals = [...(previous?.spans || [])];
  if (page.endOffset > start) intervals.push([start, page.endOffset]);
  intervals.sort((a, b) => a[0] - b[0]);
  const spans = [];
  for (const [from, to] of intervals) {
    const last = spans.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else spans.push([from, to]);
  }
  if (spans.length === 1 && spans[0][0] === 0 && spans[0][1] === page.totalChars) return read;
  return { pageIndex: page.pageIndex, complete: 0, spans };
}
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
  recordReads(sessionId, pages, task) {
    const b = this.bySession(sessionId);
    requireValue(
      b?.attachment_id,
      "SESSION_SCOPE",
      "此会话不能读取正文。",
      403,
    );
    const delivered = pages.filter(page => page.source !== "empty" &&
      (page.text === undefined || page.text.length > 0));
    if (task) {
      const job = this.active(task.id, task.token);
      requireValue(job.session_id === sessionId && job.attachment_id === b.attachment_id &&
        job.source_hash === b.source_hash && job.kind !== "initial",
        "SESSION_SCOPE", "读取凭据不属于当前论文任务。", 403);
      const byPage = new Map(this.taskReads(job).map(read => [read.pageIndex, read]));
      for (const page of delivered) byPage.set(page.pageIndex, mergePageRead(byPage.get(page.pageIndex), page));
      this.db.prepare("UPDATE paper_jobs SET progress_json=?,updated_at=? WHERE id=?")
        .run(JSON.stringify({ ...job.progress, reads: [...byPage.values()] }), now(), job.id);
      return { ok: true };
    }
    const find = this.db.prepare("SELECT complete,spans FROM agent_page_reads WHERE session_id=? AND source_hash=? AND page_index=?");
    const save = this.db.prepare("INSERT OR REPLACE INTO agent_page_reads(session_id,source_hash,page_index,complete,spans) VALUES(?,?,?,?,?)");
    for (const page of delivered) {
      const key = [sessionId, b.source_hash, page.pageIndex];
      const previous = find.get(...key);
      const read = mergePageRead(previous && { complete: previous.complete, spans: JSON.parse(previous.spans) }, page);
      save.run(...key, read.complete, JSON.stringify(read.spans || []));
    }
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
  taskReads(job) {
    if (job.progress.reads) return job.progress.reads;
    // In earlier releases this binding belonged to just this job.
    if (this.bySession(job.session_id)?.binding_key === `task:${job.id}`)
      return this.reads(job.session_id);
    return [];
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
  researchBinding(attachment) {
    const scope = `research:${attachment.id}:${attachment.sourceHash}`;
    const head = this.db
      .prepare("SELECT session_id FROM agent_heads WHERE scope_key=?")
      .get(scope);
    if (head) return this.bySession(head.session_id);
    const previous = this.db.prepare(
      `SELECT agent_bindings.* FROM paper_jobs
       JOIN agent_bindings USING (session_id)
       WHERE paper_jobs.kind='research' AND paper_jobs.state='completed'
         AND paper_jobs.attachment_id=? AND paper_jobs.source_hash=?
         AND agent_bindings.binding_key='task:' || paper_jobs.id
       ORDER BY paper_jobs.updated_at DESC,paper_jobs.rowid DESC LIMIT 1`,
    ).get(attachment.id, attachment.sourceHash);
    const binding = previous || this.binding(scope, "task", attachment.id);
    this.db
      .prepare("INSERT INTO agent_heads(scope_key,session_id) VALUES(?,?)")
      .run(scope, binding.session_id);
    return binding;
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
    const key = requestKey || (kind === "initial"
      ? `initial:${a.id}:${a.sourceHash}`
      : randomUUID());
    const existing = this.db
      .prepare("SELECT * FROM paper_jobs WHERE request_key=?")
      .get(key);
    if (existing) {
      const job = parseJob(existing);
      requireValue(
        job.attachment_id === a.id && job.source_hash === a.sourceHash &&
          job.kind === kind && job.baseline.ownerSession === ownerSession &&
          (job.baseline.requestInstruction === undefined ||
            job.baseline.requestInstruction === cleanText(instruction, 4000)),
        "JOB_REQUEST_CONFLICT",
        "任务请求已用于其他论文或指令。",
        409,
      );
      return job;
    }
    const id = randomUUID(),
      binding = kind === "research"
        ? this.researchBinding(a)
        : this.binding(kind === "initial" ? `paper:${a.id}` : `task:${id}`,
          kind === "initial" ? "paper" : "digest", a.id);
    const baseline = {
      revision: item.revision,
      metadata: item.metadata,
      ownerSession,
      ...(kind === "research" ? { requestInstruction: cleanText(instruction, 4000) } : {}),
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
  statusJobs() {
    return this.db.prepare(`
      SELECT j.id,j.attachment_id AS attachmentId,j.session_id AS sessionId,j.kind,j.state,
        COALESCE(json_extract(j.progress_json,'$.pageIndex'),0) AS pageIndex,a.page_count AS pageCount,
        m.title,j.error,j.updated_at AS updatedAt,json_extract(j.result_json,'$.version') AS summaryVersion
      FROM paper_jobs j JOIN attachments a ON a.id=j.attachment_id JOIN item_metadata m ON m.item_id=a.item_id
      WHERE j.state IN ('queued','running') OR j.id IN
        (SELECT id FROM paper_jobs WHERE state NOT IN ('queued','running') ORDER BY updated_at DESC,id LIMIT 50)
      ORDER BY CASE j.state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
        CASE WHEN j.state='queued' THEN j.created_at END,j.updated_at DESC,j.id
    `).all();
  }
  list(limit = 50) {
    return this.db
      .prepare("SELECT * FROM paper_jobs ORDER BY created_at DESC,id LIMIT ?")
      .all(Math.min(100, Math.max(1, limit)))
      .map(parseJob);
  }
  pending({ busyAttachments = [], allowInitial = true } = {}) {
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
        `SELECT * FROM (
          SELECT job.*, row_number() OVER (
            PARTITION BY attachment_id ORDER BY CASE kind WHEN 'research' THEN 0 ELSE 1 END,created_at,rowid
          ) AS position_in_paper
          FROM paper_jobs AS job
          WHERE state='queued' AND (? OR kind!='initial')
            AND attachment_id NOT IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (
              SELECT 1 FROM paper_jobs AS active
              WHERE active.attachment_id=job.attachment_id AND active.state='running'
            )
        ) WHERE position_in_paper=1
        ORDER BY CASE kind WHEN 'research' THEN 0 ELSE 1 END,created_at,id LIMIT 10`,
      )
      .all(Number(allowInitial), JSON.stringify(busyAttachments))
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
      const a = this.store.attachment(job.attachment_id),
        item = this.store.library.get(a.itemId);
      requireValue(
        !item.archivedAt,
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
      requireValue(
        !this.db.prepare(
          "SELECT 1 FROM paper_jobs WHERE attachment_id=? AND state='running' AND lease_until>?",
        ).get(a.id, Date.now()),
        "JOB_ACTIVE",
        "此论文已有任务正在运行。",
        409,
      );
      const digest = job.kind === "research" ? this.digest(a.id) : null;
      const progress = digest
        ? { ...job.progress, expectedVersion: digest.version || 0 }
        : job.progress;
      const token = randomUUID();
      this.db
        .prepare(
          "UPDATE paper_jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1,error=NULL,updated_at=?,progress_json=? WHERE id=?",
        )
        .run(token, Date.now() + 90000, now(), JSON.stringify(progress), id);
      const claimed = this.job(id);
      return digest ? { ...claimed, briefing: researchBriefing(item, a, digest) } : claimed;
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
        { ...chunk, truncated: !chunk.pageComplete },
      ], job.kind === "initial" ? undefined : { id, token });
      return job.kind === "initial" ? next : this.job(id).progress;
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
      const reads = job.kind === "initial" ? this.reads(job.session_id) : this.taskReads(job);
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
          reads.length > 0,
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
        coverage = this.coverage(a, job.session_id, previousDigest, reads);
      const blankSet = new Set(coverage.value.gaps || []);
      const invalidPages = validated.evidencePages.filter((p) => !coverage.evidence.has(p));
      requireValue(
        invalidPages.length === 0,
        "DIGEST_EVIDENCE",
        invalidPages.some((p) => blankSet.has(p))
          ? "摘要不能引用空白或未识别出文字的页面，请将其记录在局限或待核查项中。"
          : "摘要不能引用尚未读取的页面。",
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
    if (!row) return { attachmentId, title: item.metadata.title, summary: null, status: "unread" };
    const { replyMessageId, ...summary } = JSON.parse(row.payload_json);
    return {
      attachmentId,
      title: item.metadata.title,
      version: row.version,
      sourceHash: row.source_hash,
      sessionId: row.session_id,
      sourceSeq: row.source_seq,
      updatedAt: row.created_at,
      stale: row.source_hash !== a.sourceHash,
      summary: row.source_hash === a.sourceHash ? this.checkedSummary(a, summary) : summary,
    };
  }
  coverage(a, sessionId, previous, reads = this.reads(sessionId)) {
    const old = !previous?.stale ? previous?.summary?.coverage : null;
    const known =
      old?.readPages === a.pages
        ? Array.from({ length: a.pages }, (_, i) => i)
        : old?.readPageIndices || [];
    const blank = new Set(this.store.fulltext.emptyPageIndices(a.id, a.sourceHash));
    const gaps = new Set([...blank, ...(old?.gaps || []).filter(i => !reads.some(r => r.pageIndex === i))]);
    const complete = [...new Set([...known, ...reads.filter(p => p.complete).map(p => p.pageIndex)])]
      .filter(i => !gaps.has(i)).sort((x, y) => x - y);
    const evidence = new Set([...known, ...(!previous?.stale ? previous?.summary?.evidencePages || [] : []),
      ...reads.map(p => p.pageIndex)].filter(i => !gaps.has(i)));
    return {
      evidence,
      value: {
        pageCount: a.pages, readPages: complete.length,
        ...(complete.length < a.pages ? { readPageIndices: complete } : {}),
        gaps: [...gaps].sort((x, y) => x - y), visuals: "text-and-ocr-only",
      },
    };
  }
  checkedSummary(attachment, summary) {
    // Older versions counted empty indexed pages as evidence. Keep the historical
    // snapshot immutable and correct its coverage wherever it is presented.
    const previous = { summary };
    const { evidence, value } = this.coverage(attachment, null, previous, []);
    return { ...summary, evidencePages: summary.evidencePages.filter(i => evidence.has(i)), coverage: value };
  }
  conversationSummaryContext(sessionId) {
    const binding = this.bySession(sessionId);
    requireValue(binding?.role === "paper", "SESSION_SCOPE", "这不是论文阅读会话。", 403);
    const attachment = this.store.attachment(binding.attachment_id);
    const previous = this.digest(attachment.id);
    return {
      summary: previous.stale ? null : previous.summary,
      version: previous.version || 0,
      evidencePages: [...this.coverage(attachment, sessionId, previous).evidence].sort((a, b) => a - b),
    };
  }
  conversationSummaryState(sessionId, after = 0) {
    requireValue(Number.isSafeInteger(after) && after >= 0, "SESSION_SEQ", "无效会话位置。");
    const binding = this.bySession(sessionId);
    if (binding?.role !== "paper") return { pending: false, updates: [] };
    const updates = this.db.prepare(`
      SELECT source_seq AS seq, json_extract(payload_json,'$.replyMessageId') AS messageId
      FROM paper_digests
      WHERE attachment_id=? AND session_id=? AND source_seq>? AND messageId IS NOT NULL
      ORDER BY source_seq
    `).all(binding.attachment_id, sessionId, after).map(({ seq, messageId }) => ({ seq, messageId }));
    return { pending: binding.summary_turn_seq > binding.published_seq, updates };
  }
  conversationSummary({ sessionId, digest, sourceSeq, expectedVersion, replyMessageId }) {
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
      requireValue(
        replyMessageId === undefined ||
          (typeof replyMessageId === "string" && replyMessageId.trim() && replyMessageId.length <= 200),
        "AGENT_ID",
        "无效回复标识。",
      );
      const validated = validateDigest(digest, a.pages),
        coverage = this.coverage(a, sessionId, previous);
      const blankSet = new Set(coverage.value.gaps || []);
      const invalidPages = validated.evidencePages.filter((p) => !coverage.evidence.has(p));
      requireValue(
        invalidPages.length === 0,
        "DIGEST_EVIDENCE",
        invalidPages.some((p) => blankSet.has(p))
          ? "摘要不能引用空白或未识别出文字的页面，请将其记录在局限或待核查项中。"
          : "摘要不能引用尚未读取的页面。",
        409,
      );
      const payload = {
        ...validated,
        kind: "conversation",
        coverage: coverage.value,
      };
      const version = expectedVersion + 1;
      const storedPayload = replyMessageId ? { ...payload, replyMessageId } : payload;
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
          JSON.stringify(storedPayload),
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
    const fromSql =
      "FROM item_metadata m LEFT JOIN journal_aliases ja ON ja.alias_key=m.journal_key LEFT JOIN journal_terms jt ON jt.term_key=COALESCE(ja.canonical_key,m.journal_key)";
    const allowedText =
      "m.title || ' ' || COALESCE(m.year,'') || ' ' || m.journal_key || ' ' || COALESCE(jt.label,'') || ' ' || m.doi || ' ' || COALESCE((SELECT group_concat(label,' ') FROM item_authors WHERE item_id=m.item_id),'') || ' ' || COALESCE((SELECT group_concat(label,' ') FROM item_tags WHERE item_id=m.item_id),'')";
    const where =
      "m.archived_at IS NULL" +
      words.map(() => ` AND instr(pw_search(${allowedText}),?)>0`).join("");
    const total = this.db
      .prepare(`SELECT count(*) AS n ${fromSql} WHERE ${where}`)
      .get(...words).n;
    const catalog = {
      total,
      items: this.db
        .prepare(
          `SELECT m.item_id AS id ${fromSql} WHERE ${where} ORDER BY m.updated_at DESC,m.item_id LIMIT 20 OFFSET ?`,
        )
        .all(...words, offset),
    };
    const ftsQuery = searchPieces(text)
      .slice(0, 12)
      .map(fulltextPhrase)
      .filter(Boolean)
      .join(" AND ");
    const hits = ftsQuery
      ? this.db
          .prepare(
            `SELECT DISTINCT d.attachment_id FROM paper_digest_fts f JOIN paper_digests d ON d.id=f.digest_id JOIN attachments a ON a.id=d.attachment_id JOIN item_metadata m ON m.item_id=a.item_id WHERE paper_digest_fts MATCH ? AND m.archived_at IS NULL AND d.source_hash=a.sha256 AND d.version=(SELECT MAX(x.version) FROM paper_digests x WHERE x.attachment_id=d.attachment_id) ORDER BY bm25(paper_digest_fts) LIMIT 8`,
          )
          .all(ftsQuery)
      : [];
    const ids = [
      ...new Set([
        ...catalog.items.map((x) => x.id),
        ...hits.map((x) => this.store.attachment(x.attachment_id).itemId),
      ]),
    ];
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
