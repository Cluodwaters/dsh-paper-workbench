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
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
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

test("a late acknowledgement from another reader cannot erase a conflicting draft", async (t) => {
  environment(t);
  const first = new PersistenceClient(snapshot, () => {});
  const second = new PersistenceClient(snapshot, () => {});
  await first.recover();
  await second.recover();
  let acknowledge;
  globalThis.fetch = async (_, options) => {
    const m = JSON.parse(options.body);
    if (m.upserts[0].id === "first") return new Promise(resolve => { acknowledge = resolve; });
    return Response.json({ error: { code: "REVISION_CONFLICT", message: "conflict" } }, { status: 409 });
  };
  const saved = first.enqueue([{ id: "first" }], []);
  second.enqueue([{ id: "second" }], []);
  await until(() => second.error);
  acknowledge(Response.json({ revision: 1 }));
  await saved;
  assert.ok(localStorage.getItem(second.key));
  const third = new PersistenceClient({ ...snapshot, revision: 1 }, () => {});
  await third.recover();
  assert.equal(third.queue.length, 0, "a live reader still owns the journal");
  second.release();
  const reopened = new PersistenceClient({ ...snapshot, revision: 1 }, () => {});
  await reopened.recover();
  assert.deepEqual(reopened.overlay([]), [{ id: "second" }]);
  await reopened.pump();
  assert.equal(reopened.error.code, "REVISION_CONFLICT");
  globalThis.fetch = async (_, options) => {
    assert.equal(JSON.parse(options.body).expectedRevision, 1);
    return Response.json({ revision: 2 });
  };
  await reopened.mergeConflict({ ...snapshot, revision: 1 });
  assert.equal(reopened.revision, 2);
  assert.equal(localStorage.getItem(second.key), null);
  for (const client of [first, third, reopened]) client.release();
});

test("a restored legacy conflict remains visible until the database acknowledges it", async (t) => {
  environment(t);
  const legacyKey = "paper-workbench:draft:v1:" + snapshot.attachmentId;
  const mutation = { expectedRevision: 0, requestId: "legacy", sourceHash: snapshot.sourceHash,
    upserts: [{ id: "old" }], deletions: [] };
  localStorage.setItem(legacyKey, JSON.stringify({ schemaVersion: 1, sourceHash: snapshot.sourceHash, queue: [{ mutation }] }));
  const states = [];
  const adapter = new ZoteroReaderAdapter(null, state => states.push(state), () => {});
  adapter.persistence = new PersistenceClient(snapshot, () => adapter.reportSaveState());
  await adapter.persistence.recover();
  globalThis.fetch = async () => Response.json({ error: { code: "REVISION_CONFLICT", message: "conflict" } }, {status: 409});
  await adapter.persistence.pump();
  adapter.reportSaveState();
  assert.equal(states.at(-1), "conflict");
  assert.equal(states.includes("saved"), false);
  assert.ok(localStorage.getItem(legacyKey));
  adapter.persistence.discard();
  assert.equal(localStorage.getItem(legacyKey), null);
});

test("reader context uses the focused split pane and retains primary restoration position", () => {
  const adapter = new ZoteroReaderAdapter(null, () => {}, () => {});
  const pane = (page, text) => ({ _iframeWindow: { PDFViewerApplication: { pdfViewer: { currentPageNumber: page } },
    getSelection: () => ({ anchorNode: { parentElement: { closest: selector => selector === ".page" ?
      { dataset: { pageNumber: String(page) } } : {} } }, toString: () => text }) } });
  adapter.document = { attachment: snapshot };
  adapter.reader = { _primaryView: pane(1, "left"), _secondaryView: pane(3, "right"), _lastViewPrimary: false };
  adapter.pdfApplication = adapter.reader._primaryView._iframeWindow.PDFViewerApplication;
  const context = adapter.context();
  assert.equal(context.pageIndex, 2);
  assert.equal(context.readingPageIndex, 0);
  assert.equal(context.selection.text, "right");
});

test("reader context recognizes selections anchored directly on an Element node", () => {
  const adapter = new ZoteroReaderAdapter(null, () => {}, () => {});
  const textLayerElement = {
    nodeType: 1,
    closest: (selector) =>
      selector === ".textLayer"
        ? textLayerElement
        : selector === ".page"
          ? { dataset: { pageNumber: "2" } }
          : null,
  };
  const pane = {
    _iframeWindow: {
      PDFViewerApplication: { pdfViewer: { currentPageNumber: 1 } },
      getSelection: () => ({
        anchorNode: textLayerElement,
        toString: () => "Selected paragraph",
      }),
    },
  };
  adapter.document = { attachment: snapshot };
  adapter.reader = { _primaryView: pane, _lastViewPrimary: true };
  adapter.pdfApplication = pane._iframeWindow.PDFViewerApplication;
  const context = adapter.context();
  assert.equal(context.pageIndex, 1);
  assert.equal(context.selection.text, "Selected paragraph");
});

test("saveViewState coalesces rapid scroll bursts and clears transient errors once a later write succeeds", async (t) => {
  environment(t);
  let calls = 0;
  let releaseFirst;
  globalThis.fetch = () => {
    calls++;
    if (calls === 1) {
      return new Promise((resolve) => {
        releaseFirst = () => resolve(errorResponse());
      });
    }
    return Promise.resolve(Response.json({ saved: true }));
  };
  const adapter = new ZoteroReaderAdapter(null, () => {}, () => {});
  adapter.document = { attachment: { id: "test" } };
  const first = adapter.saveViewState({ pageIndex: 1 }, true);
  adapter.saveViewState({ pageIndex: 2 }, true);
  adapter.saveViewState({ pageIndex: 3 }, true);
  adapter.saveViewState({ pageIndex: 4 }, true);
  releaseFirst();
  await first;
  await until(() => !adapter.dirty());
  assert.equal(calls, 2, "intermediate scroll updates coalesce into a single follow-up write");
  assert.equal(adapter.stateError, null, "later successful save clears prior transient stateError");
  assert.equal(adapter.getSaveState(), "saved");
});

test("mergeConflict rebases queued mutations across recovered and current draft keys", async (t) => {
  environment(t);
  const legacyKey = "paper-workbench:draft:v1:" + snapshot.attachmentId;
  const oldMutation = {
    expectedRevision: 0,
    requestId: "legacy-req",
    sourceHash: snapshot.sourceHash,
    upserts: [{ id: "from-old-window" }],
    deletions: [],
  };
  localStorage.setItem(
    legacyKey,
    JSON.stringify({ schemaVersion: 1, sourceHash: snapshot.sourceHash, queue: [{ mutation: oldMutation }] }),
  );
  const client = new PersistenceClient({ ...snapshot, revision: 2 }, () => {});
  await client.recover();
  globalThis.fetch = async () =>
    Response.json({ error: { code: "REVISION_CONFLICT", message: "conflict" } }, { status: 409 });
  await client.pump();
  assert.equal(client.error.code, "REVISION_CONFLICT");
  client.enqueue([{ id: "from-current-window" }], []);
  const seen = [];
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body);
    seen.push(body.expectedRevision);
    return Response.json({ revision: body.expectedRevision + 1 });
  };
  await client.mergeConflict({ ...snapshot, revision: 2 });
  assert.deepEqual(seen, [2, 3]);
  assert.equal(client.revision, 4);
  assert.equal(localStorage.getItem(legacyKey), null);
  assert.equal(localStorage.getItem(client.key), null);
  client.release();
});
