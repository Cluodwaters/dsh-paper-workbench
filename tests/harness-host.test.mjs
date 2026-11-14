import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { apply } from "../plugins/dsh-paper-workbench/index.js";
import { projectRoot } from "../src/config.mjs";

test(
  "plugin Host owns an authenticated backend, proxies real imports, rejects cross-site writes and scopes paper tools",
  { timeout: 60000 },
  async (t) => {
    const root = path.join(projectRoot, "output/harness-host-tests");
    mkdirSync(root, { recursive: true });
    const dataRoot = mkdtempSync(path.join(root, "run-"));
    let handler, agentCreated, agentPreStep, backendPid;
    let connectionReady = true;
    const disposers = [];
    const server = http.createServer((request, response) =>
      handler
        ? handler(request, response)
        : (response.writeHead(503), response.end()),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const liveAgents=new Map();
    const agentRegistry={
      get:id=>liveAgents.get(id),
      async resume(){throw Object.assign(new Error('not found'),{name:'SessionPersistenceNotFoundError'})},
      async create(options){
        const definitions=[], restrictions=[];
        const agent={id:options.sessionId,session:{header:options.meta,seq:1},ctx:{get(){},on(){},tools:{register:d=>definitions.push(d),restrict:f=>restrictions.push(f),guard(){}}},definitions,restrictions};
        await options.setup(agent.ctx,agent);liveAgents.set(agent.id,agent);
        return {agent,async dispose(){liveAgents.delete(agent.id)}};
      },
    };
    const ctx = {
      get(name) {
        if(name==='agents')return agentRegistry;
        if(name==='sessions')return {async flush(){}};
        return name === "connection" && connectionReady
          ? {
              requestRejection({ headers }) {
                return headers.cookie === "harness-test=1" ? null : 401;
              },
            }
          : undefined;
      },
      effect(setup) {
        const dispose = setup();
        if (typeof dispose === "function") disposers.push(dispose);
      },
      on(name, listener) {
        if (name === "agent/created") agentCreated = listener;
        if (name === "agent/pre-step") agentPreStep = listener;
        return () => {};
      },
      webServer: {
        getOrigin: () => origin,
        register(route) {
          handler = route.handler;
          return () => {
            handler = null;
          };
        },
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    };
    t.after(async () => {
      for (const dispose of [...disposers].reverse()) await dispose();
      if (backendPid) assert.throws(() => process.kill(backendPid, 0), { code: 'ESRCH' }, 'disposal resolves only after the backend has exited');
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    apply(ctx, {
      backendRoot: projectRoot,
      nodeExecutable: process.execPath,
      dataRoot,
      autoIndex: false,
      autoRead: false,
      startupTimeoutMs: 20000,
    });
    const get = (route) =>
      fetch(origin + "/paper-workbench" + route, {
        headers: { cookie: "harness-test=1" },
        signal: AbortSignal.timeout(25000),
      });
    const post = (route, data, requestOrigin = origin) =>
      fetch(origin + "/paper-workbench" + route, {
        method: "POST",
        headers: {
          cookie: "harness-test=1",
          "content-type": "application/json",
          origin: requestOrigin,
        },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(25000),
      });
    let status;
    for (let i = 0; i < 150; i++) {
      status = await (await get("/__workbench/status")).json();
      if (status.ready) break;
      if (status.phase === "failed") assert.fail(status.error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status.ready, true, JSON.stringify(status));
    backendPid = status.pid;
    connectionReady = false;
    assert.equal((await get("/__workbench/status")).status, 503);
    connectionReady = true;
    assert.equal(
      (await fetch(origin + "/paper-workbench/api/health")).status,
      401,
    );
    const session = JSON.parse(
      readFileSync(path.join(dataRoot, "server-session.json"), "utf8"),
    );
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${session.port}/paper-workbench/api/health`,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await post(
          "/api/library/search",
          { query: {} },
          "https://cross-site.invalid",
        )
      ).status,
      403,
    );
    const health = await get("/api/health");
    assert.equal(health.status, 200);
    const healthData = await health.json();
    assert.equal(healthData.integration.authenticated, true);
    assert.ok(!JSON.stringify(status).includes("Bearer "));
    const search = await post("/api/library/search", { query: {} });
    assert.equal(search.status, 200, await search.text());
    const uploaded = await fetch(
      origin + "/paper-workbench/api/library/import-pdf",
      {
        method: "POST",
        headers: {
          cookie: "harness-test=1",
          origin,
          "content-type": "application/pdf",
          "x-file-name": encodeURIComponent("Host验证.pdf"),
        },
        body: readFileSync(
          path.join(
            projectRoot,
            "data/validation/fixtures/fixture-existing.pdf",
          ),
        ),
        signal: AbortSignal.timeout(25000),
      },
    );
    assert.equal(uploaded.status, 200, await uploaded.text());
    const documents = await (await get("/api/documents")).json();
    assert.equal(documents.length, 1);
    assert.equal(documents[0].originalName, "Host验证.pdf");
    const detail = await (await get(`/api/documents/${documents[0].id}`)).json();
    assert.deepEqual(detail.attachment, documents[0]);
    assert.equal((await get(`/api/documents/${randomUUID()}`)).status, 404);
    const shutdown = await post("/api/shutdown", { expectedPid: backendPid });
    assert.equal(shutdown.status, 403);
    assert.equal((await shutdown.json()).error.code, "HOST_ONLY");
    assert.equal((await get("/api/health")).status, 200);
    const tools = [];
    await agentCreated({
      agent: {
        session: { header: { cwd: projectRoot } },
        ctx: {
          tools: {
            register(definition) {
              tools.push(definition);
            },
          },
        },
      },
    });
    assert.equal(
      tools.length,
      0,
      "ordinary sessions must not inherit paper tools",
    );
    let deniedUnknown=false;
    await agentCreated({
      agent: {
        session: { header: { cwd: status.conversationsRoot } },
        ctx: {
          tools: {
            restrict(){deniedUnknown=true},
            register(definition) {
              tools.push(definition);
            },
          },
        },
      },
    });
    assert.equal(deniedUnknown,true);
    assert.deepEqual(tools,[], 'unbound sessions fail closed even with matching cwd');
    const bindingResponse=await post('/__workbench/agents/ensure',{role:'paper',attachmentId:documents[0].id});
    assert.equal(bindingResponse.status,200);
    const binding=await bindingResponse.json();
    const definitions=liveAgents.get(binding.session_id).definitions;
    assert.ok(!definitions.some(d=>d.name==='paper_search_library'));
    assert.equal((await post('/api/agents/internal/bind',{role:'master'})).status,403);
    const item = await definitions
      .find((tool) => tool.name === "paper_get_item")
      .execute(
        { itemId: documents[0].itemId },
        { signal: new AbortController().signal },
      );
    assert.equal(item.attachments[0].attachmentId, documents[0].id);
    assert.equal(item.sourceHash, documents[0].sourceHash);
    await assert.rejects(()=>definitions.find(d=>d.name==='paper_read_pages').execute({attachmentId:'unrelated',pageIndices:[0]}),/SESSION_SCOPE/);

    // Native composer requests and quick actions share this host context path.
    // Test the actual HTTP route and the registered pre-step hook together.
    const paperSessionId = binding.session_id;
    const paperContext = {
      attachmentId: documents[0].id,
      itemId: documents[0].itemId,
      sourceHash: documents[0].sourceHash,
      pageIndex: 1,
      selectionText: "A synthetic selected paragraph for context validation.",
    };
    assert.equal(
      (
        await post(
          "/__workbench/paper-context",
          { sessionId: paperSessionId, context: paperContext },
          "https://cross-site.invalid",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post("/__workbench/paper-context", {
          sessionId: paperSessionId,
          context: { ...paperContext, sourceHash: "unverified" },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post("/__workbench/paper-context", {
          sessionId: paperSessionId,
          context: paperContext,
        })
      ).status,
      200,
    );
    const paperAgent = liveAgents.get(paperSessionId);
    const signal = new AbortController().signal;
    const decision = {
      kind: "enter",
      startsRequestSeries: true,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Explain this paragraph." }],
        },
      ],
    };
    const entered = await agentPreStep(
      { agent: paperAgent, step: 1, signal },
      async () => decision,
    );
    assert.equal(
      decision.messages.length,
      1,
      "existing messages stay immutable",
    );
    assert.equal(entered.messages.length, 2);
    const sourceText = entered.messages.at(-1).content[0].text;
    assert.ok(sourceText.includes(paperContext.attachmentId));
    assert.ok(sourceText.includes(paperContext.sourceHash));
    assert.ok(sourceText.includes("当前页=2"));
    assert.ok(sourceText.includes(paperContext.selectionText));
    const continuation = { ...decision, startsRequestSeries: false };
    assert.equal(
      await agentPreStep(
        { agent: paperAgent, step: 2, signal },
        async () => continuation,
      ),
      continuation,
      "tool continuations must not duplicate paper context",
    );
    assert.equal(
      await agentPreStep(
        {
          agent: {
            id: "ordinary-unbound-session",
            session: { header: { cwd: projectRoot } },
          },
          step: 1,
          signal,
        },
        async () => decision,
      ),
      decision,
      "unrelated conversations must not inherit context",
    );
    await post("/__workbench/paper-context", {
      sessionId: paperSessionId,
      context: {
        ...paperContext,
        pageIndex: 2,
        selectionText: "New selection",
      },
    });
    const requestId = randomUUID();
    assert.equal(
      (await post("/__workbench/paper-context", {
        sessionId: paperSessionId,
        requestId,
        context: { ...paperContext, sourceHash: "a".repeat(64) },
      })).status,
      409,
    );
    assert.equal(
      (await post("/__workbench/paper-context", {
        sessionId: paperSessionId,
        requestId,
        context: paperContext,
      })).status,
      200,
    );
    const queuedRequest = await agentPreStep(
      { agent: paperAgent, step: 1, signal, messages: [{ source: { kind: "user", rpcId: requestId } }] },
      async () => decision,
    );
    const queuedText = queuedRequest.messages.at(-1).content[0].text;
    assert.match(queuedText, /当前页=2/);
    assert.ok(queuedText.includes(paperContext.selectionText));
    const nextRequest = await agentPreStep(
      { agent: paperAgent, step: 7, signal },
      async () => decision,
    );
    assert.ok(nextRequest.messages.at(-1).content[0].text.includes("当前页=3"));
    assert.ok(
      nextRequest.messages.at(-1).content[0].text.includes("New selection"),
    );

    const previousPid = backendPid;
    const restarts = await Promise.all([
      post("/__workbench/restart", {}),
      post("/__workbench/restart", {}),
    ]);
    assert.deepEqual(restarts.map((result) => result.status), [202, 202]);
    for (let i = 0; i < 150; i++) {
      status = await (await get("/__workbench/status")).json();
      if (status.ready && status.pid !== previousPid) break;
      if (status.phase === "failed") assert.fail(status.error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(status.ready && status.pid !== previousPid, JSON.stringify(status));
    backendPid = status.pid;
    assert.throws(() => process.kill(previousPid, 0), { code: "ESRCH" });
    assert.equal((await (await get("/api/documents")).json())[0].id, documents[0].id);
    assert.equal(status.logs.filter((line) => line.includes("manual restart requested")).length, 1);
  },
);
