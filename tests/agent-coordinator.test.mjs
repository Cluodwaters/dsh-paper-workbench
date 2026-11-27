import test from "node:test";
import assert from "node:assert/strict";
import { createAgentCoordinator } from "../plugins/dsh-paper-workbench/agents.js";

function fixture({ role = "paper", kind = "initial", abort = false, wait = false, onIdle, onRequest } = {}) {
  const binding = {
    session_id: "fixture-session",
    role,
    attachment_id: role === "master" ? null : "fixture-paper",
    source_hash: "fixture-hash",
  };
  const job = {
    id: "fixture-job",
    session_id: binding.session_id,
    attachment_id: "fixture-paper",
    kind,
    state: "queued",
    lease_token: "lease",
    instruction: "请先通读全文",
    progress: {},
    baseline: { ownerSession: binding.session_id },
  };
  const messages = [],
    actions = [],
    listeners = new Map(),
    agentOptions = [],
    definitions = [],
    restrictions = [],
    guards = [];
  let agent, releaseIdle;
  const idle = wait
    ? new Promise((resolve) => {
        releaseIdle = resolve;
      })
    : null;
  const backend = {
    async request(url, { body }) {
      const action = url.split("/").pop();
      actions.push({ action, body });
      const override = await onRequest?.(action, body);
      if (override !== undefined) return override;
      if (["bind", "binding-session"].includes(action)) return binding;
      if (action === "pending")
        return job.state === "queued" ? [{ ...job }] : [];
      if (action === "prepare") return { ready: true };
      if (action === "claim") {
        job.state = "running";
        return { ...job, briefing: kind === "research" ? "已知的主题、方法及主要发现" : undefined };
      }
      if (action === "job") return { ...job };
      if (action === "publish") {
        job.state = "completed";
        return { version: 1 };
      }
      if (action === "stop") {
        job.state = body.state;
        return { ...job };
      }
      return { ok: true };
    },
  };
  const agentRegistry = {
    get() {
      return agent;
    },
    async resume(options) {
      agentOptions.push(options.agentOptions);
      throw Object.assign(Error("missing"), {
        name: "SessionPersistenceNotFoundError",
      });
    },
    async create(options) {
      agentOptions.push(options.agentOptions);
      agent = {
        id: binding.session_id,
        status: "idle",
        session: { id: binding.session_id, seq: 10, header: options.meta },
        ctx: {
          get() {},
          on(name, listener) {
            listeners.set(name, listener);
          },
          tools: {
            restrict: (f) => restrictions.push(f),
            guard: (f) => guards.push(f),
            register: (d) => definitions.push(d),
          },
          systemPrompt: { section() {}, suppressRuntimeContext() {} },
        },
        followup(message) {
          messages.push(message);
          agent.status = "running";
        },
        async whenIdle() {
          if (wait) await idle;
          else if (onIdle) await onIdle({ job, agent, listeners });
          else if (abort)
            listeners.get("session/event")(agent.session, {
              type: "turn/end",
              data: { reason: { kind: "aborted", reason: { kind: "user" } } },
            });
          else job.state = "completed";
          agent.status = "idle";
        },
        cancel() {
          releaseIdle?.();
          agent.status = "idle";
        },
      };
      await options.setup(agent.ctx, agent);
      return {
        agent,
        async dispose() {
          agent.cancel();
        },
      };
    },
  };
  let flushes = 0;
  const services = {
    agents: agentRegistry,
    sessions: {
      async flush() {
        flushes++;
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: "fixture", model: "fixture-model" }),
    },
  };
  const coordinator = createAgentCoordinator(
    { get: (name) => services[name], logger: { warn() {} } },
    { backend, conversationsRoot: "D:/fixture-conversations", config: {} },
  );
  return {
    coordinator,
    job,
    actions,
    messages,
    listeners,
    agentOptions,
    definitions,
    restrictions,
    guards,
    services,
    releaseIdle: () => releaseIdle?.(),
    get agent() {
      return agent;
    },
    get flushes() {
      return flushes;
    },
  };
}

test("master task status serializes pending, failed and completed receipts", async (t) => {
  const f = fixture({ role: "master" });
  t.after(() => f.coordinator.stop());
  await f.coordinator.ensure({ role: "master" });
  const tool = f.definitions.find((tool) => tool.name === "paper_task_status");
  const call = () => tool.execute({ taskId: f.job.id }, { signal: new AbortController().signal });
  for (const state of ["queued", "running", "failed", "cancelled"]) {
    f.job.state = state;
    const reply = await call();
    assert.deepEqual(reply, {
      taskId: f.job.id, state, error: null, summary: null, version: null,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(reply)), reply);
  }
  f.job.state = "completed";
  f.job.result = { digest: { findings: "任务结论" }, version: 3 };
  assert.deepEqual(await call(), {
    taskId: f.job.id, state: "completed", error: null,
    summary: f.job.result.digest, version: 3,
  });
});

test("research continuation uses the first briefing once and recognizes targeted reading progress", async (t) => {
  let turns = 0;
  const f = fixture({
    role: "task", kind: "research",
    onIdle({ job }) {
      if (++turns === 1) job.progress.reads = [{ pageIndex: 1, complete: 1 }];
      else job.state = "completed";
    },
  });
  t.after(() => f.coordinator.stop());
  f.coordinator.start();
  await until(() => f.job.state === "completed");
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[0].content[0].text, /已知的主题、方法及主要发现/);
  assert.match(f.messages[1].content[0].text, /继续刚才的委派任务/);
  assert.doesNotMatch(f.messages[1].content[0].text, /已知的主题/);
  assert.ok(!f.definitions.some((tool) => tool.name === "paper_identify"));
  assert.ok(f.definitions.some((tool) => tool.name === "paper_publish_digest"));
});
async function until(predicate) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("coordinator did not settle");
}

test("automatic reading creates a native user message and flushes its session", async (t) => {
  const f = fixture();
  t.after(() => f.coordinator.stop());
  f.coordinator.start();
  await until(() => f.job.state === "completed");
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].role, "user");
  assert.ok(f.messages[0].id);
  assert.match(f.messages[0].content[0].text, /通读全文/);
  assert.ok(f.flushes >= 2);
});
test("native Stop cancels an automatic job without submitting another instruction", async (t) => {
  const f = fixture({ abort: true });
  t.after(() => f.coordinator.stop());
  f.coordinator.start();
  await until(() => f.job.state === "cancelled");
  assert.equal(f.messages.length, 1);
  assert.match(
    f.actions.find((a) => a.action === "stop").body.error,
    /用户停止/,
  );
});

test("checkpoints and publication preserve the native turn until the final answer finishes", async (t) => {
  const f = fixture({ wait: true });
  t.after(() => f.coordinator.stop());
  f.coordinator.start();
  await until(() => f.messages.length === 1);
  const exec = {
    concludeTurn() {
      assert.fail("tool must not interrupt the native answer");
    },
  };
  const checkpoint = f.definitions.find((d) => d.name === "paper_checkpoint");
  await checkpoint.execute(
    { receipt: "page-1", note: "one", memory: "one" },
    exec,
  );
  await checkpoint.execute(
    { receipt: "page-2", note: "two", memory: "one and two" },
    exec,
  );
  await f.definitions
    .find((d) => d.name === "paper_publish_digest")
    .execute({ digest: {} }, exec);
  assert.equal(f.agent.status, "running");
  assert.equal(f.messages.length, 1);
  f.job.state = "completed";
  f.releaseIdle();
  await until(() => f.agent.status === "idle");
  assert.equal(f.messages.length, 1);
});

test("native failure stops the task immediately, without automated followups", async (t) => {
  const f = fixture({
    onIdle({ listeners }) {
      listeners.get("agent/error")({ error: Error("provider unavailable") });
    },
  });
  t.after(() => f.coordinator.stop());
  f.coordinator.start();
  await until(() => f.job.state === "failed");
  assert.equal(f.messages.length, 1);
  assert.match(
    f.actions.find((a) => a.action === "stop").body.error,
    /provider unavailable/,
  );
});

test("incomplete turns get bounded recovery only after the previous native turn is idle", async (t) => {
  let completedTurns = 0;
  const f = fixture({
    onIdle({ job, agent }) {
      assert.equal(agent.status, "running");
      job.progress = { pageIndex: ++completedTurns };
    },
  });
  t.after(() => f.coordinator.stop());
  f.coordinator.start();
  await until(() => f.job.state === "failed");
  assert.equal(f.messages.length, 3);
  assert.equal(completedTurns, 3);
  assert.match(f.actions.find((a) => a.action === "stop").body.error, /预算/);
});

test("paper preset is persisted and isolated native compaction is resolved through the registry", async (t) => {
  const f = fixture();
  t.after(() => f.coordinator.stop());
  let mounted,
    tokens = 49000,
    compacted = 0;
  f.services.agentPresets = {
    async mount(scope, id) {
      mounted = { scope, id };
    },
    presetForSession(session) {
      return session.header.agentPreset;
    },
    serviceFor(agent, name) {
      assert.equal(agent.ctx, mounted.scope);
      if (name === "tokenMeter")
        return { measure: () => ({ totalTokens: tokens }) };
      if (name === "compaction")
        return {
          async compactIfNeeded() {
            compacted++;
            tokens = 8000;
          },
        };
    },
  };
  await f.coordinator.ensure({ role: "paper", attachmentId: "fixture-paper" });
  assert.equal(mounted.id, "paper-workbench");
  assert.equal(f.agent.session.header.agentPreset, "paper-workbench");
  assert.equal(
    f.agent.ctx.get("compaction"),
    undefined,
    "DSH hides services inside preset groups",
  );
  await f.coordinator.beforeStep(f.agent, 2, new AbortController().signal, {
    kind: "enter",
  });
  assert.equal(compacted, 1);
});
test("shutdown requeues active work and keeps checkpoints for restart", async () => {
  const f = fixture({ wait: true });
  f.coordinator.start();
  await until(() => f.messages.length === 1);
  await f.coordinator.stop();
  assert.equal(f.job.state, "queued");
  assert.equal(f.messages.length, 1);
});

test("publishing a digest without identified metadata returns lossless JSON", async (t) => {
  const f = fixture({ wait: true });
  t.after(() => f.coordinator.stop());
  f.coordinator.start();
  await until(() => f.messages.length === 1);
  const tool = f.definitions.find((d) => d.name === "paper_publish_digest");
  const result = await tool.execute({ digest: {} });
  assert.deepEqual(result, { saved: true, version: 1, metadata: null });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("answered paper turns update the digest off-transcript without an output cap", async (t) => {
  const requests = [];
  let version = 1;
  const f = fixture({
    onRequest(action) {
      if (action === "conversation-summary-context")
        return { version, summary: { topic: "Existing topic", findings: `Version ${version}` }, evidencePages: [0] };
      if (action === "conversation-summary" && version === 1) {
        version++;
        throw Object.assign(Error("Concurrent digest update"), { code: "SUMMARY_CONFLICT" });
      }
    },
  });
  t.after(() => f.coordinator.stop());
  f.services.llm = {
    async *stream(options) {
      requests.push(options);
      yield { type: "text-delta", index: 0, text: '{"topic":"A paper"}' };
      yield { type: "block-end", index: 0, block: { type: "text", text: '{"topic":"A paper"}' } };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
  await f.coordinator.ensure({ role: "paper", attachmentId: "fixture-paper" });
  assert.equal(f.agentOptions.length, 2);
  assert.ok(f.agentOptions.every(options => !Object.hasOwn(options, "maxTokens")));
  assert.ok(!f.definitions.some(tool => tool.name === "paper_update_summary"));
  assert.equal(f.listeners.has("agent/turn-stopping"), false);

  const emit = (type, data, extra) => f.listeners.get("session/event")(f.agent.session, { type, data, ...extra });
  const start = (turn) => {
    emit("turn/start", { turn });
    emit("user/message", { source: { kind: "user" }, content: [{ type: "text", text: "How does the method work?" }] }, { surfaceOp: "append" });
    emit("assistant/message", { turn, message: {
      id: `reply-${turn}`,
      source: { provider: "reply-provider", model: "reply-model" },
      content: [{ type: "text", text: "The method uses a control." }],
    } });
  };
  start(1);
  emit("turn/end", { turn: 1, reason: { kind: "max-tokens" } }, { seq: 15 });
  start(2);
  assert.equal(requests.length, 0);
  emit("turn/end", { turn: 2, reason: { kind: "completed" } }, { seq: 21 });
  await until(() => f.actions.filter(a => a.action === "conversation-summary").length === 2);
  const saves = f.actions.filter(a => a.action === "conversation-summary").map(a => a.body);
  assert.deepEqual(saves.map(save => save.expectedVersion), [1, 2]);
  assert.ok(saves.every(save => save.replyMessageId === "reply-2" && save.sourceSeq === 21));
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.model === "reply-model" && !Object.hasOwn(request, "maxTokens")));
  assert.deepEqual(JSON.parse(requests[1].messages[0].content[0].text), {
    previousSummary: { topic: "Existing topic", findings: "Version 2" },
    evidencePages: [0],
    questions: ["How does the method work?"],
    answer: "The method uses a control.",
  });
  assert.deepEqual(f.messages, []);
});
test("master runtime exposes catalog tools only and invokes native compaction at its budget", async (t) => {
  const f = fixture({ role: "master" });
  t.after(() => f.coordinator.stop());
  await f.coordinator.ensure({ role: "master" });
  assert.ok(f.definitions.some((t) => t.name === "paper_delegate"));
  for (const tool of f.definitions) {
    assert.equal(tool.parameters.type, "object");
    assert.ok(Array.isArray(tool.parameters.required));
    assert.ok(
      !Object.values(tool.parameters.properties).some(
        (p) => typeof p.required === "boolean",
      ),
    );
  }
  assert.ok(
    !f.definitions.some((t) =>
      /read_pages|read_next|get_item|annotations|update_summary/.test(t.name),
    ),
  );
  assert.deepEqual(f.restrictions, [{ allow: [] }]);
  assert.ok(f.guards[0]({ name: "shell" }));
  assert.equal(f.guards[0]({ name: "paper_search_catalog" }), undefined);
  let tokens = 25000,
    compactions = 0;
  f.agent.ctx.get = (name) =>
    name === "tokenMeter"
      ? { measure: () => ({ totalTokens: tokens }) }
      : name === "compaction"
        ? {
            async compactIfNeeded(agent, trigger) {
              assert.equal(trigger, "context-overflow");
              compactions++;
              tokens = 6000;
            },
          }
        : null;
  const decision = { kind: "enter", startsRequestSeries: true };
  assert.equal(
    await f.coordinator.beforeStep(
      f.agent,
      1,
      new AbortController().signal,
      decision,
    ),
    decision,
  );
  assert.equal(compactions, 1);
});

test("migrated paper sessions remain tool-scoped on attach and bindings survive handle disposal", async (t) => {
  const f = fixture({ role: "paper" });
  t.after(() => f.coordinator.stop());
  const migratedTools = [];
  const migratedRestrictions = [];
  const migratedAgent = {
    id: "fixture-session",
    status: "idle",
    session: { id: "fixture-session", seq: 1, header: { cwd: "E:/old-data-root/harness-conversations" } },
    ctx: {
      get() {},
      on() {},
      tools: {
        restrict: (rule) => migratedRestrictions.push(rule),
        guard() {},
        register: (def) => migratedTools.push(def),
      },
      systemPrompt: { section() {}, suppressRuntimeContext() {} },
    },
  };
  await f.coordinator.attach(migratedAgent);
  assert.deepEqual(migratedRestrictions, [{ allow: [] }]);
  assert.ok(migratedTools.some((tool) => tool.name === "paper_read_pages"));
  assert.equal(f.coordinator.binding("fixture-session")?.role, "paper");
  assert.equal((await f.coordinator.resolveBinding("fixture-session"))?.attachment_id, "fixture-paper");
});

test("delegated research budget error identifies the task kind accurately", async (t) => {
  let turns = 0;
  const f = fixture({
    role: "task",
    kind: "research",
    onIdle({ job }) {
      job.progress.reads = [{ pageIndex: turns++, complete: 1 }];
    },
  });
  t.after(() => f.coordinator.stop());
  f.coordinator.start();
  await until(() => f.job.state === "failed");
  assert.match(f.actions.find((a) => a.action === "stop").body.error, /委派任务/);
});
