import test from "node:test";
import assert from "node:assert/strict";
import { createAgentCoordinator } from "../plugins/dsh-paper-workbench/agents.js";

function fixture({ role = "paper", abort = false, wait = false } = {}) {
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
    kind: "initial",
    state: "queued",
    lease_token: "lease",
    instruction: "请先通读全文",
    progress: {},
  };
  const messages = [],
    actions = [],
    listeners = new Map(),
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
      if (["bind", "binding-session"].includes(action)) return binding;
      if (action === "pending")
        return job.state === "queued" ? [{ ...job }] : [];
      if (action === "prepare") return { ready: true };
      if (action === "claim") {
        job.state = "running";
        return { ...job };
      }
      if (action === "job") return { ...job };
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
    async resume() {
      throw Object.assign(Error("missing"), {
        name: "SessionPersistenceNotFoundError",
      });
    },
    async create(options) {
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
    definitions,
    restrictions,
    guards,
    get agent() {
      return agent;
    },
    get flushes() {
      return flushes;
    },
  };
}
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
test("shutdown requeues active work and keeps checkpoints for restart", async () => {
  const f = fixture({ wait: true });
  f.coordinator.start();
  await until(() => f.messages.length === 1);
  await f.coordinator.stop();
  assert.equal(f.job.state, "queued");
  assert.equal(f.messages.length, 1);
});

test("saving a conversation summary does not prematurely hide the user-facing answer", async (t) => {
  const f = fixture();
  t.after(() => f.coordinator.stop());
  await f.coordinator.ensure({ role: "paper", attachmentId: "fixture-paper" });
  let concluded = false;
  await f.definitions
    .find((d) => d.name === "paper_update_summary")
    .execute(
      { digest: {}, expectedVersion: 0 },
      {
        concludeTurn() {
          concluded = true;
        },
      },
    );
  assert.equal(
    concluded,
    false,
    "the native model must still be able to produce its visible reply",
  );
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
