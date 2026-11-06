import test from "node:test";
import assert from "node:assert/strict";
import { PersistenceClient } from "../src/web/persistence-client.js";
import { ZoteroReaderAdapter } from "../src/web/zotero-reader-adapter.js";
import { installCloseGuard } from "../desktop/close-guard.cjs";

function environment(t) {
  const original = {
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage,
  };
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  t.after(() => Object.assign(globalThis, original));
  return values;
}
const snapshot = {
  attachmentId: "test",
  sourceHash: "a".repeat(64),
  revision: 0,
};
const errorResponse = () =>
  new Response(
    JSON.stringify({ error: { code: "FAILED", message: "test save failure" } }),
    { status: 422 },
  );
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.fail("Condition did not settle");
}

test("failed saves keep their journal and retry acknowledges the original request once", async (t) => {
  environment(t);
  const client = new PersistenceClient(snapshot, () => {});
  globalThis.fetch = async () => errorResponse();
  let acknowledged = false;
  const pending = client.enqueue([{ id: "ink" }], []).then(() => {
    acknowledged = true;
  });
  await until(() => client.error);
  assert.equal(acknowledged, false);
  assert.equal(JSON.parse(localStorage.getItem(client.key)).queue.length, 1);
  const requestId = client.queue[0].mutation.requestId;
  globalThis.fetch = async (_, options) => {
    assert.equal(JSON.parse(options.body).requestId, requestId);
    return new Response(JSON.stringify({ revision: 1, requestId }));
  };
  await client.retry();
  await pending;
  assert.equal(acknowledged, true);
  assert.equal(localStorage.getItem(client.key), null);
});

test("discard clears failed pending changes so reopening cannot replay them", async (t) => {
  environment(t);
  globalThis.fetch = async () => errorResponse();
  const client = new PersistenceClient(snapshot, () => {});
  const pending = client.enqueue([{ id: "discard-this" }], []);
  await until(() => client.error);
  client.discard();
  await pending;
  assert.equal(new PersistenceClient(snapshot, () => {}).queue.length, 0);
});

test("discarding an in-flight save cannot recreate the journal or report it saved", async (t) => {
  environment(t);
  const states = [];
  const client = new PersistenceClient(snapshot, (state) => states.push(state));
  let release;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = client.enqueue([{ id: "in-flight" }], []);
  client.discard();
  await pending;
  release(new Response(JSON.stringify({ revision: 1 })));
  await until(() => !client.running);
  assert.equal(localStorage.getItem(client.key), null);
  assert.equal(states.includes("saved"), false);
});

test("discard preserves a journal replaced by another reader window", async (t) => {
  environment(t);
  globalThis.fetch = async () => errorResponse();
  const client = new PersistenceClient(snapshot, () => {});
  client.enqueue([{ id: "ours" }], []);
  await until(() => client.error);
  localStorage.setItem(client.key, "another window's journal");
  client.discard();
  assert.equal(localStorage.getItem(client.key), "another window's journal");
});

test("flush surfaces a failed persistence acknowledgement without waiting on upstream forever", async (t) => {
  environment(t);
  globalThis.fetch = async () => errorResponse();
  const adapter = new ZoteroReaderAdapter(
    null,
    () => {},
    () => {},
  );
  adapter.persistence = new PersistenceClient(snapshot, () => {});
  adapter.captureViewState = async () => {};
  adapter.reader = {
    _annotationManager: {
      _triggerSaving: () => adapter.persistence.enqueue([{ id: "bad" }], []),
      _unsavedAnnotations: new Map(),
      _savingInProgress: true,
    },
  };
  await assert.rejects(adapter.flush(), /test save failure/);
});

function closeWindow(choice, result) {
  const handlers = {},
    calls = [];
  const win = {
    isDestroyed: () => calls.includes("destroy"),
    destroy: () => calls.push("destroy"),
    webContents: {
      on: (event, callback) => {
        handlers[event] = callback;
      },
      executeJavaScript: async (code) => {
        calls.push(code);
        return result;
      },
    },
  };
  let dialogs = 0;
  installCloseGuard(win, {
    showMessageBox: async () => ({ response: dialogs++ === 0 ? choice : 0 }),
  });
  return { calls, run: handlers["will-prevent-unload"] };
}
test("cancelled close leaves the reader and its pending changes untouched", async () => {
  const c = closeWindow(0, { ok: true });
  await c.run();
  assert.deepEqual(c.calls, []);
});
test("a failed close-time save keeps the window open", async () => {
  const c = closeWindow(1, { ok: false, error: "failed" });
  await c.run();
  assert.match(c.calls[0], /prepareClose\("save"\)/);
  assert.equal(c.calls.includes("destroy"), false);
});
test("explicit discard runs renderer cleanup before closing the desktop window", async () => {
  const c = closeWindow(2, { ok: true });
  await c.run();
  assert.match(c.calls[0], /prepareClose\("discard"\)/);
  assert.equal(c.calls[1], "destroy");
});
