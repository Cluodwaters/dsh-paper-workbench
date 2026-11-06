import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";
import { AiContextService } from "../src/application/ai-context-service.mjs";
import { PaperAgentService } from "../src/application/paper-agent-service.mjs";

function setup(
  t,
  {
    autoRead = true,
    pages = [
      "Title Alice Journal 2024. science material ".repeat(400),
      "SECRET_BODY_ONLY ending.",
    ],
  } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "paper-agent-test-")),
    db = path.join(dir, "library.sqlite");
  let store = new SqliteStore(db, { autoRead });
  const bytes = Buffer.from("%PDF-derived-" + randomUUID()),
    hash = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(path.join(dir, "files"));
  writeFileSync(path.join(dir, "files", "copy.pdf"), bytes);
  const id = store.addAttachment(
    {
      id: "fixture",
      originalName: "imported.pdf",
      sha256: hash,
      pages: pages.length,
      bytes: bytes.length,
    },
    "files/copy.pdf",
  );
  const index = store.fulltext.enqueue(id);
  store.fulltext.mark(index.id, "running");
  pages.forEach((text, pageIndex) =>
    store.fulltext.savePage(index.id, {
      pageIndex,
      nativeText: text,
      ocrText: "",
    }),
  );
  store.fulltext.finish(index.id, pages.length);
  const service = new PaperAgentService({
    store,
    context: new AiContextService({ store, dataRoot: dir }),
    indexer: {
      enqueue() {
        throw Error("unexpected indexing");
      },
    },
  });
  t.after(() => store.close());
  return { store, service, id, hash, db, dir };
}
const digest = {
  topic: "测试主题",
  scientificQuestion: "测试科学问题",
  methods: "实验比较",
  argument: "提出问题，再验证",
  findings: "示例结论",
  limitations: "仅文本，图表待检查",
  openQuestions: "待人工核验",
  evidencePages: [0],
};
async function readAll(s, j) {
  let c;
  while (!(c = await s.next(j.id, j.lease_token)).done)
    s.checkpoint(j.id, j.lease_token, {
      receipt: c.receipt,
      note: "读过本段",
      memory: "滚动工作记忆",
    });
}

test("import atomically creates one durable paper conversation and initial job, duplicate stays idempotent", (t) => {
  const { store, id } = setup(t);
  const jobs = store.agents.pending();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "initial");
  assert.match(jobs[0].instruction, /通读/);
  assert.equal(store.agents.enqueue(id).id, jobs[0].id);
  assert.equal(store.agents.bindings().length, 1);
});
test("standalone imports never start AI", (t) => {
  const { store } = setup(t, { autoRead: false });
  assert.equal(store.agents.pending().length, 0);
});
test("initial publication requires all chunks, checkpoints survive a resumed lease, source mutation is rejected", async (t) => {
  const { store, service, id, dir } = setup(t);
  let j = store.agents.claim(store.agents.pending()[0].id);
  await assert.rejects(
    () => service.publish(j.id, j.lease_token, { digest, sourceSeq: 10 }),
    (e) => e.code === "READ_INCOMPLETE",
  );
  const first = await service.next(j.id, j.lease_token);
  assert.equal(first.text.length, 12000);
  assert.equal(first.pageComplete, false);
  service.checkpoint(j.id, j.lease_token, {
    receipt: first.receipt,
    note: "首段",
    memory: "先前记忆",
  });
  store.db.prepare("UPDATE paper_jobs SET lease_until=0 WHERE id=?").run(j.id);
  store.agents.pending();
  j = store.agents.claim(j.id);
  assert.equal(j.progress.offset, 12000);
  await readAll(service, j);
  const saved = await service.publish(j.id, j.lease_token, {
    digest,
    sourceSeq: 20,
  });
  assert.equal(saved.version, 1);
  assert.equal(store.agents.digest(id).summary.coverage.readPages, 2);
  assert.equal(
    (await service.publish(j.id, j.lease_token, { digest, sourceSeq: 20 }))
      .version,
    1,
  );
  writeFileSync(path.join(dir, "files", "copy.pdf"), "changed");
  await assert.rejects(
    () => service.publish(j.id, j.lease_token, { digest, sourceSeq: 20 }),
    (e) => e.code === "SOURCE_CHANGED",
  );
});
test("metadata auto-fill preserves stable ids and never overwrites concurrent user edits", async (t) => {
  const { store, service, id } = setup(t);
  const j = store.agents.claim(store.agents.pending()[0].id);
  await service.next(j.id, j.lease_token);
  const item = store.library.get(store.attachment(id).itemId);
  store.library.update(item.id, {
    requestId: randomUUID(),
    expectedRevision: item.revision,
    metadata: { ...item.metadata, title: "用户已编辑" },
  });
  const r = service.identify(j.id, j.lease_token, {
    title: "AI title",
    authors: [{ literal: "Alice" }],
    journal: "Journal",
    year: 2024,
    evidencePages: [0],
  });
  assert.deepEqual(r.applied, []);
  assert.equal(store.library.get(item.id).metadata.title, "用户已编辑");
  assert.equal(store.attachment(id).itemId, item.id);
});
test("initial identify saves recognized bibliographic fields with provenance, leaves absent fields unknown", async (t) => {
  const { store, service, id } = setup(t);
  const j = store.agents.claim(store.agents.pending()[0].id);
  await service.next(j.id, j.lease_token);
  const r = service.identify(j.id, j.lease_token, {
    title: "Detected title",
    authors: [{ literal: "Alice" }],
    year: 2024,
    evidencePages: [0],
  });
  assert.deepEqual(r.applied, ["title", "authors", "year"]);
  const item = store.library.get(store.attachment(id).itemId);
  assert.equal(item.metadata.journal, "");
  assert.equal(item.metadata.reviewStatus, "unverified");
  assert.equal(item.year, 2024);
  assert.deepEqual(
    service.identify(j.id, j.lease_token, {
      title: "Detected title",
      authors: [{ literal: "Alice" }],
      year: 2024,
      evidencePages: [0],
    }),
    r,
  );
  assert.equal(
    store.library.get(item.id).revision,
    item.revision,
    "identical retries do not rewrite metadata",
  );
  service.identify(j.id, j.lease_token, {
    journal: "Journal recognized on a later page",
    evidencePages: [0],
  });
  assert.equal(
    store.library.get(item.id).metadata.journal,
    "Journal recognized on a later page",
  );
});

test("metadata and conversation summaries cannot cite pages that were not delivered", async (t) => {
  const { store, service } = setup(t);
  const j = store.agents.claim(store.agents.pending()[0].id);
  assert.throws(
    () =>
      service.identify(j.id, j.lease_token, {
        title: "Guess",
        evidencePages: [0],
      }),
    (e) => e.code === "METADATA_EVIDENCE",
  );
  assert.throws(
    () =>
      store.agents.conversationSummary({
        sessionId: j.session_id,
        sourceSeq: 10,
        expectedVersion: 0,
        digest,
      }),
    (e) => e.code === "DIGEST_EVIDENCE",
  );
  const result = await service.readPages({
    sessionId: j.session_id,
    pageIndices: [0, 1],
  });
  assert.equal(result.pages[0].truncated, true);
  assert.equal(result.pages[1].text, "");
  assert.throws(
    () =>
      store.agents.conversationSummary({
        sessionId: j.session_id,
        sourceSeq: 10,
        expectedVersion: 0,
        digest: { ...digest, evidencePages: [1] },
      }),
    (e) => e.code === "DIGEST_EVIDENCE",
  );
  assert.equal(
    store.agents.conversationSummary({
      sessionId: j.session_id,
      sourceSeq: 10,
      expectedVersion: 0,
      digest,
    }).version,
    1,
  );
  assert.equal(
    store.agents.digest(j.attachment_id).summary.coverage.readPages,
    0,
    "a truncated page is never reported as completely read",
  );
});

test("research tasks are separate, read only relevant pages, and reject stale summary replacement", async (t) => {
  const { store, service, id } = setup(t);
  const initial = store.agents.claim(store.agents.pending()[0].id);
  await readAll(service, initial);
  await service.publish(initial.id, initial.lease_token, {
    digest,
    sourceSeq: 20,
  });
  let task = store.agents.enqueue(id, {
    kind: "research",
    instruction: "检查局限",
    ownerSession: "master",
    requestKey: "task-one",
  });
  task = store.agents.claim(task.id);
  assert.notEqual(task.session_id, initial.session_id);
  assert.equal(task.baseline.ownerSession, "master");
  store.agents.taskDigest(task.id, task.lease_token);
  await assert.rejects(
    () => service.publish(task.id, task.lease_token, { digest, sourceSeq: 30 }),
    (e) => e.code === "READ_INCOMPLETE",
  );
  await service.readPages({ sessionId: task.session_id, pageIndices: [1] });
  store.agents.conversationSummary({
    sessionId: initial.session_id,
    sourceSeq: 40,
    expectedVersion: 1,
    digest: { ...digest, findings: "用户刚补充的结论" },
  });
  await assert.rejects(
    () => service.publish(task.id, task.lease_token, { digest, sourceSeq: 30 }),
    (e) => e.code === "SUMMARY_CONFLICT",
  );
  const newest = store.agents.taskDigest(task.id, task.lease_token);
  const saved = await service.publish(task.id, task.lease_token, {
    digest: { ...newest.summary, limitations: "任务补充局限" },
    sourceSeq: 50,
  });
  assert.equal(saved.version, 3);
  assert.equal(saved.digest.findings, "用户刚补充的结论");
  assert.equal(saved.digest.coverage.readPages, 2);
  assert.equal(
    store.agents.job(task.id).progress.pageIndex,
    undefined,
    "targeted research does not reread the whole paper",
  );
});

test("new topics are durable, retry-safe, isolated by role and preserve the initial conversation", (t) => {
  const { store, id } = setup(t);
  const initial = store.agents.ensure({ role: "paper", attachmentId: id });
  const next = store.agents.topic({
    role: "paper",
    attachmentId: id,
    requestId: "new-topic",
  });
  assert.notEqual(initial.session_id, next.session_id);
  assert.equal(
    store.agents.ensure({ role: "paper", attachmentId: id }).session_id,
    next.session_id,
  );
  assert.equal(
    store.agents.topic({
      role: "paper",
      attachmentId: id,
      requestId: "new-topic",
    }).session_id,
    next.session_id,
  );
  assert.equal(
    store.agents.topics({ role: "paper", attachmentId: id }).items.length,
    2,
  );
  const master = store.agents.ensure({ role: "master" });
  assert.throws(
    () =>
      store.agents.topic({
        role: "paper",
        attachmentId: id,
        sessionId: master.session_id,
      }),
    (e) => e.code === "SESSION_SCOPE",
  );
  store.agents.topic({
    role: "paper",
    attachmentId: id,
    sessionId: initial.session_id,
  });
  assert.equal(
    store.agents.ensure({ role: "paper", attachmentId: id }).session_id,
    initial.session_id,
  );
  store.agents.markTurn(initial.session_id, 10);
  assert.equal(store.agents.bySession(initial.session_id).summary_turn_seq, 10);
});
test("master catalog search cannot access body or bibliographic abstract and retrieves only saved summaries", async (t) => {
  const { store, service, id } = setup(t);
  assert.equal(store.agents.search("SECRET_BODY_ONLY").items.length, 0);
  const item = store.library.get(store.attachment(id).itemId);
  store.library.update(item.id, {
    requestId: randomUUID(),
    expectedRevision: item.revision,
    metadata: { ...item.metadata, abstract: "SECRET_ABSTRACT" },
  });
  assert.equal(store.agents.search("SECRET_ABSTRACT").items.length, 0);
  const j = store.agents.claim(store.agents.pending()[0].id);
  await readAll(service, j);
  await service.publish(j.id, j.lease_token, { digest, sourceSeq: 20 });
  const r = store.agents.search("测试主题");
  assert.equal(r.summaryMatches.length, 1);
  assert.ok(!JSON.stringify(r).includes("SECRET_BODY_ONLY"));
  assert.ok(!Object.hasOwn(r.items[0], "abstract"));
});
test("cancelled job rejects late checkpoints and publishing; retries keep same session and progress", async (t) => {
  const { store, service } = setup(t);
  let j = store.agents.claim(store.agents.pending()[0].id);
  const chunk = await service.next(j.id, j.lease_token);
  store.agents.stop(j.id, "cancelled", "用户取消");
  assert.throws(
    () =>
      service.checkpoint(j.id, j.lease_token, {
        receipt: chunk.receipt,
        note: "late",
        memory: "",
      }),
    (e) => e.code === "JOB_STOPPED",
  );
  store.agents.stop(j.id, "queued", "");
  const next = store.agents.claim(j.id);
  assert.equal(next.session_id, j.session_id);
  assert.notEqual(next.lease_token, j.lease_token);
});
test("later conversation summaries enforce optimistic versions, record incomplete coverage and exclude archived items", async (t) => {
  const { store, service, id } = setup(t);
  const j = store.agents.claim(store.agents.pending()[0].id);
  await readAll(service, j);
  await service.publish(j.id, j.lease_token, { digest, sourceSeq: 20 });
  assert.equal(
    store.agents.conversationSummary({
      sessionId: j.session_id,
      sourceSeq: 30,
      expectedVersion: 1,
      digest,
    }).version,
    2,
  );
  assert.throws(
    () =>
      store.agents.conversationSummary({
        sessionId: j.session_id,
        sourceSeq: 40,
        expectedVersion: 1,
        digest,
      }),
    (e) => e.code === "SUMMARY_CONFLICT",
  );
  const item = store.library.get(store.attachment(id).itemId);
  store.library.batch({
    requestId: randomUUID(),
    items: [{ id: item.id, expectedRevision: item.revision }],
    changes: { archived: true },
  });
  assert.equal(store.agents.search("测试主题").items.length, 0);
  assert.throws(
    () => store.agents.digest(id),
    (e) => e.code === "ITEM_ARCHIVED",
  );
});
