import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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

test("archiving blocks a queued claim and stale failures cannot overwrite cancellation", (t) => {
  const { store, id } = setup(t);
  const [job] = store.agents.pending();
  const item = store.library.get(store.attachment(id).itemId);
  store.library.batch({
    requestId: randomUUID(),
    items: [{ id: item.id, expectedRevision: item.revision }],
    changes: { archived: true },
  });
  assert.throws(() => store.agents.claim(job.id), { code: "ITEM_ARCHIVED" });
  assert.deepEqual(store.agents.pending(), []);
  assert.throws(
    () => store.agents.stop(job.id, "failed", "stale error", undefined, "queued"),
    { code: "JOB_STATE_CHANGED" },
  );
  const cancelled = store.agents.job(job.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.lease_token, null);
  assert.equal(cancelled.lease_until, null);
});

test("missing or malformed agent IDs are rejected before binding SQLite parameters", async (t) => {
  const { service } = setup(t);
  for (const action of ["bind", "topics", "topic"])
    for (const attachmentId of [undefined, null, {}, [], 3, ""])
      await assert.rejects(
        service.handle(action, { role: "paper", attachmentId }),
        (e) => e.code === "ATTACHMENT_ID" && e.status === 400,
      );
  for (const [action, field] of [
    ["job", "id"],
    ["digest", "attachmentId"],
    ["item", "itemId"],
    ["mark-turn", "sessionId"],
  ])
    for (const value of [undefined, null, {}, [], 3, ""])
      await assert.rejects(
        service.handle(action, { [field]: value }),
        (e) => e.code === "AGENT_ID" && e.status === 400,
      );
  const master = await service.handle("bind", { role: "master" });
  const topics = await service.handle("topics", { role: "master" });
  assert.equal(topics.current, master.session_id);
  assert.equal(topics.items.length, 1);
});
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

test("research sessions reuse paper history with job-scoped evidence and versioned summaries", async (t) => {
  const { store, service, id, db } = setup(t);
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
  assert.match(task.briefing, /测试主题/);
  assert.match(task.briefing, /实验比较/);
  assert.match(task.briefing, /提出问题，再验证/);
  assert.match(task.briefing, /示例结论/);
  assert.doesNotMatch(task.briefing, /SECRET_BODY_ONLY/);
  assert.equal(task.progress.expectedVersion, 1);
  await assert.rejects(
    () => service.publish(task.id, task.lease_token, { digest, sourceSeq: 30 }),
    (e) => e.code === "READ_INCOMPLETE",
  );
  await service.readPages({
    sessionId: task.session_id, pageIndices: [1], taskId: task.id,
    leaseToken: task.lease_token,
  });
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
  const resumedStore = new SqliteStore(db);
  t.after(() => resumedStore.close());
  const next = resumedStore.agents.enqueue(id, {
    kind: "research", instruction: "再核对限制", ownerSession: "master",
    requestKey: "task-two",
  });
  assert.notEqual(next.id, task.id);
  assert.equal(next.session_id, task.session_id);
  const claimed = store.agents.claim(next.id);
  assert.match(claimed.briefing, /用户刚补充的结论/);
  assert.match(claimed.briefing, /任务补充局限/);
  assert.equal(claimed.progress.expectedVersion, 3);
  await assert.rejects(
    () => service.publish(next.id, claimed.lease_token, { digest, sourceSeq: 60 }),
    { code: "READ_INCOMPLETE" },
  );
  await assert.rejects(
    () => service.readPages({
      sessionId: next.session_id, pageIndices: [1], taskId: next.id,
      leaseToken: task.lease_token,
    }),
    { code: "JOB_STOPPED" },
  );
  await service.readPages({
    sessionId: next.session_id, pageIndices: [1], taskId: next.id,
    leaseToken: claimed.lease_token,
  });
  const updated = await service.publish(next.id, claimed.lease_token, {
    digest: { ...saved.digest, openQuestions: "第二次任务补充问题", evidencePages: [0, 1] },
    sourceSeq: 60,
  });
  assert.equal(updated.version, 4);
  assert.equal(store.agents.digest(id).sessionId, task.session_id);
  assert.equal(store.agents.digest(id).summary.openQuestions, "第二次任务补充问题");
  assert.equal(store.agents.job(task.id).result.version, 3);
  const previousResult = await service.handle("task-summary", { id: task.id });
  assert.equal(previousResult.version, 3);
  assert.equal(previousResult.summary.openQuestions, digest.openQuestions);
});

test("queued jobs on a busy paper leave scheduling slots for other papers", async (t) => {
  const { store, service, id } = setup(t, { autoRead: false });
  const other = store.addAttachment({
    id: "second", originalName: "second.pdf", sha256: "b".repeat(64), pages: 1, bytes: 40,
  }, "files/second.pdf");
  const dispatch = (attachmentId, requestKey, instruction = "核对方法") =>
    service.handle("enqueue", { attachmentId, requestKey, instruction, ownerSession: "master" });
  const current = await dispatch(id, "first");
  assert.match(store.agents.claim(current.id).briefing, /暂无可用的共享摘要/);
  const queued = [];
  for (let i = 0; i < 12; i++) queued.push(await dispatch(id, `same-${i}`));
  const independent = await dispatch(other, "different");
  assert.equal((await dispatch(id, "same-0")).id, queued[0].id);
  await assert.rejects(dispatch(id, "same-0", "改用其他方法"), { code: "JOB_REQUEST_CONFLICT" });
  assert.notEqual(independent.session_id, current.session_id);
  assert.ok(queued.every((job) => job.session_id === current.session_id));
  assert.throws(() => store.agents.claim(queued[0].id), { code: "JOB_ACTIVE" });
  assert.deepEqual((await service.handle("pending")).map((j) => j.id), [independent.id]);
  store.agents.stop(current.id, "cancelled", "test");
  assert.deepEqual(
    new Set((await service.handle("pending")).map((j) => j.id)),
    new Set([queued[0].id, independent.id]),
  );
  assert.deepEqual(
    (await service.handle("pending", { busyAttachments: [id] })).map((j) => j.id),
    [independent.id],
  );
});

test("a completed legacy delegation keeps its native conversation and job evidence", async (t) => {
  const { store, service, id, hash } = setup(t, { autoRead: false });
  const legacyId = randomUUID();
  const legacy = store.agents.binding(`task:${legacyId}`, "task", id);
  const timestamp = new Date().toISOString();
  store.db.prepare(
    `INSERT INTO paper_jobs(id,request_key,attachment_id,source_hash,session_id,
       kind,state,instruction,baseline_json,created_at,updated_at)
     VALUES(?,?,?,?,?,'research','completed','legacy prompt','{}',?,?)`,
  ).run(legacyId, "legacy-req", id, hash, legacy.session_id, timestamp, timestamp);
  store.agents.recordReads(legacy.session_id, [{ pageIndex: 0 }]);
  const next = await service.handle("enqueue", {
    attachmentId: id, instruction: "核对新任务", requestKey: "new-task",
  });
  assert.equal(next.session_id, legacy.session_id);
  assert.equal(store.agents.job(legacyId).session_id, legacy.session_id);
  const claimed = store.agents.claim(next.id);
  assert.deepEqual(store.agents.taskReads(claimed), []);
  assert.deepEqual(store.agents.reads(legacy.session_id).map((page) => page.pageIndex), [0]);
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
  const summaryState = (after) => service.handle("summary-state", { sessionId: j.session_id, after });
  assert.deepEqual((await summaryState()).updates, []);
  const context = await service.handle("conversation-summary-context", { sessionId: j.session_id });
  assert.equal(context.version, 1);
  assert.deepEqual(context.evidencePages, [0, 1]);
  assert.equal(
    store.agents.conversationSummary({
      sessionId: j.session_id,
      sourceSeq: 30,
      expectedVersion: 1,
      replyMessageId: "saved-answer",
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
        replyMessageId: "stale-answer",
        digest,
      }),
    (e) => e.code === "SUMMARY_CONFLICT",
  );
  assert.deepEqual((await summaryState()).updates, [{ seq: 30, messageId: "saved-answer" }]);
  assert.deepEqual((await summaryState(30)).updates, []);
  assert.ok(!Object.hasOwn(store.agents.digest(id).summary, "replyMessageId"));
  const otherTopic = store.agents.topic({ role: "paper", attachmentId: id, requestId: randomUUID() });
  assert.deepEqual(store.agents.conversationSummaryState(otherTopic.session_id).updates, []);
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

test("delegation abbreviates valid long metadata and digests without changing the originals", (t) => {
  const { store, id } = setup(t, {autoRead: false});
  const item = store.library.get(store.attachment(id).itemId);
  const abstract = "A".repeat(800);
  store.library.update(item.id, { requestId: randomUUID(), expectedRevision: item.revision, metadata: { ...item.metadata, abstract } });
  const claim = () => store.agents.claim(store.agents.enqueue(id, { kind: "research", instruction: "inspect" }).id);
  const first = claim();
  assert.ok(first.briefing.includes("A".repeat(560)));
  assert.ok(!first.briefing.includes("A".repeat(561)));
  store.agents.stop(first.id, "cancelled", "", first.lease_token);
  const binding = store.agents.ensure({role: "paper", attachmentId: id});
  store.agents.recordReads(binding.session_id, [{pageIndex: 0}]);
  store.agents.conversationSummary({sessionId: binding.session_id, expectedVersion: 0, sourceSeq: 1,
    digest: {...digest, methods: "方".repeat(700)}});
  const second = claim();
  assert.ok(second.briefing.includes("方".repeat(210)));
  assert.ok(!second.briefing.includes("方".repeat(211)));
  assert.equal(store.agents.digest(id).summary.methods.length, 700);
});

test("page continuations cover only delivered ranges and empty pages cannot support summaries", async (t) => {
  const {store, service, id} = setup(t, {autoRead: false, pages: ["a".repeat(24000) + "tail", ""]});
  const binding = store.agents.ensure({role: "paper", attachmentId: id});
  const read = (pageIndex, startOffset=0) => service.readPages({sessionId: binding.session_id, pageIndices: [pageIndex], startOffset});
  const save = (pages, seq, version) => store.agents.conversationSummary({ sessionId: binding.session_id, expectedVersion: version, sourceSeq: seq, digest: {...digest, evidencePages: pages} });
  await read(1);
  assert.deepEqual(store.agents.conversationSummaryContext(binding.session_id).evidencePages, []);
  assert.throws(() => save([1], 1, 0), {code: "DIGEST_EVIDENCE"});
  assert.equal((await read(0, 24000)).pages[0].text, "tail");
  const first = (await read(0)).pages[0];
  assert.equal(first.nextOffset, 12000);
  save([0], 2, 0);
  assert.equal(store.agents.digest(id).summary.coverage.readPages, 0);
  const next = (await read(0, first.nextOffset)).pages[0];
  assert.equal(next.nextOffset, 24000);
  save([0], 3, 1);
  assert.deepEqual(store.agents.digest(id).summary.coverage.gaps, [1]);
  assert.equal(store.agents.digest(id).summary.coverage.readPages, 1);
  const job = store.agents.claim(store.agents.enqueue(id, {kind:"research", instruction:"inspect"}).id);
  const task = {sessionId:job.session_id, taskId:job.id, leaseToken:job.lease_token};
  await service.readPages({...task, pageIndices:[1]});
  assert.throws(() => store.agents.publish(job.id, job.lease_token, digest, 4), {code: "READ_INCOMPLETE"});
  assert.equal((await service.readPages({...task,pageIndices:[0],startOffset:24000})).pages[0].text, "tail");
});

test("status returns every active job and prioritizes an older running paper", (t) => {
  const { store, service, id } = setup(t);
  const running = store.agents.claim(store.agents.pending()[0].id);
  for (let i=0; i<59; i++) store.agents.enqueue(id, {kind:"research", instruction:"follow up"});
  const {jobs} = service.status();
  assert.equal(jobs.length, 60);
  assert.equal(jobs[0].id, running.id);
  assert.equal(jobs[0].state, "running");
});

test("upgrading a v5 library excludes old empty-page evidence and preserves the historical snapshot and backup", (t) => {
  const {store, dir, id, hash} = setup(t, {autoRead: false, pages:["readable evidence", ""]});
  const session = store.agents.ensure({role:"paper", attachmentId:id}).session_id;
  const legacyFile = path.join(dir, "old-library.sqlite");
  store.db.prepare("VACUUM INTO ?").run(legacyFile);
  const legacy = new DatabaseSync(legacyFile);
  legacy.exec("ALTER TABLE agent_page_reads DROP COLUMN spans; PRAGMA user_version=5");
  legacy.prepare("INSERT INTO agent_page_reads VALUES(?,?,?,?)").run(session,hash,1,1);
  const payload = JSON.stringify({...digest,evidencePages:[1],coverage:{pageCount:2,readPages:2,gaps:[]}});
  legacy.prepare("INSERT INTO paper_digests(attachment_id,source_hash,session_id,source_seq,version,payload_json,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, hash, session, 1, 1, payload, "2026-01-01");
  legacy.close();
  const upgraded = new SqliteStore(legacyFile);
  try {
    assert.equal(upgraded.migration.from,5);
    const backup = new DatabaseSync(upgraded.migration.backupPath, {readOnly:true});
    assert.equal(backup.prepare("PRAGMA user_version").get().user_version,5);
    assert.equal(backup.prepare("SELECT count(*) AS n FROM agent_page_reads").get().n,1);
    backup.close();
    const result = upgraded.agents.digest(id);
    assert.deepEqual(result.summary.evidencePages,[]);
    assert.deepEqual(result.summary.coverage.gaps,[1]);
    assert.equal(result.summary.coverage.readPages,1);
    assert.equal(upgraded.agents.reads(session).length,0);
    assert.equal(upgraded.db.prepare("SELECT payload_json FROM paper_digests").get().payload_json,payload);
  } finally { upgraded.close(); }
});

test("master catalog search matches non-adjacent multi-word digest terms, journal aliases and keeps summary hits", async (t) => {
  const { store, service, id } = setup(t);
  const item = store.library.get(store.attachment(id).itemId);
  store.library.update(item.id, {
    requestId: randomUUID(),
    expectedRevision: item.revision,
    metadata: { ...item.metadata, title: "Alpha Study", journal: "Phys. Rev. B" },
  });
  const aliases = store.library.aliases();
  store.library.setAlias({
    requestId: randomUUID(),
    expectedRevision: aliases.revision,
    alias: "Phys. Rev. B",
    canonical: "Physical Review B",
  });
  const j = store.agents.claim(store.agents.pending()[0].id);
  await readAll(service, j);
  await service.publish(j.id, j.lease_token, {
    digest: {
      ...digest,
      topic: "基于热导率测量的界面传热分析",
      methods: "采用机器学习势函数进行分子动力学模拟",
    },
    sourceSeq: 20,
  });
  const multiWord = store.agents.search("热导率 机器学习");
  assert.equal(multiWord.summaryMatches.length, 1);
  assert.ok(multiWord.items.some((entry) => entry.itemId === item.id));
  const byAlias = store.agents.search("Physical Review B");
  assert.ok(byAlias.items.some((entry) => entry.itemId === item.id));
  for (let i = 0; i < 22; i++) {
    store.library.create({
      requestId: randomUUID(),
      metadata: { title: `热导率 机器学习 论文 ${i}` },
    });
  }
  const crowded = store.agents.search("热导率 机器学习");
  assert.equal(crowded.summaryMatches.length, 1);
  assert.ok(
    crowded.items.some((entry) => entry.itemId === item.id),
    "summaryMatches entries must not be sliced off when metadata hits fill 20 slots",
  );
});

test("prepare rejects all-blank PDFs cleanly, tolerates cancelled force-ocr on indexed PDFs, and notes paused indexing", (t) => {
  const blank = setup(t, { pages: ["", "   "] });
  const ocrJob = blank.store.fulltext.enqueue(blank.id, "ocr");
  blank.store.fulltext.mark(ocrJob.id, "running");
  blank.store.fulltext.savePage(ocrJob.id, { pageIndex: 0, nativeText: "", ocrText: "" });
  blank.store.fulltext.savePage(ocrJob.id, { pageIndex: 1, nativeText: "", ocrText: "" });
  blank.store.fulltext.finish(ocrJob.id, 2);
  const [blankJob] = blank.store.agents.pending();
  const blankPrep = blank.service.prepare(blankJob.id);
  assert.equal(blankPrep.ready, false);
  assert.match(blankPrep.error, /未提取出可读文字/);

  const normal = setup(t, { pages: ["Sufficient native text for indexing page one. ".repeat(5)] });
  const [normalJob] = normal.store.agents.pending();
  const forceOcr = normal.store.fulltext.enqueue(normal.id, "force-ocr");
  normal.store.fulltext.mark(forceOcr.id, "cancelled");
  assert.equal(normal.service.prepare(normalJob.id).ready, true);

  normal.service.indexer = { paused: true, enqueue() {} };
  const queued = normal.store.fulltext.enqueue(normal.id, "ocr");
  assert.equal(queued.status, "queued");
  const pausedPrep = normal.service.prepare(normalJob.id);
  assert.equal(pausedPrep.ready, false);
  assert.match(pausedPrep.waiting, /已暂停/);
});
