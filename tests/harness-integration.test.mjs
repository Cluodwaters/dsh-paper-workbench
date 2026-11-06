import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";
import { AiContextService } from "../src/application/ai-context-service.mjs";
import { integrationConfig } from "../src/server/integration.mjs";
import { annotationExcerpts } from "../src/adapters/zotero/ai-context.mjs";
import { projectRoot } from "../src/config.mjs";

function setup(t, indexed = true) {
  const parent = path.join(projectRoot, "output/harness-tests");
  mkdirSync(parent, { recursive: true });
  const dataRoot = mkdtempSync(path.join(parent, "context-"));
  const store = new SqliteStore(path.join(dataRoot, "library.sqlite"));
  t.after(() => store.close());
  const bytes = Buffer.from("immutable fixture bytes");
  writeFileSync(path.join(dataRoot, "fixture.pdf"), bytes);
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const id = store.addAttachment(
    {
      id: randomUUID(),
      sha256: sourceHash,
      originalName: "Context fixture.pdf",
      pages: 2,
      bytes: bytes.length,
    },
    "fixture.pdf",
  );
  if (indexed) {
    const job = store.fulltext.enqueue(id);
    store.fulltext.mark(job.id, "running");
    store.fulltext.savePage(job.id, {
      pageIndex: 0,
      nativeText: "First page. ".repeat(80),
      ocrText: "",
    });
    store.fulltext.savePage(job.id, {
      pageIndex: 1,
      nativeText: "",
      ocrText: "扫描页正文",
      confidence: 88,
    });
    store.fulltext.finish(job.id, 2);
  }
  return {
    store,
    dataRoot,
    service: new AiContextService({ store, dataRoot }),
    input: { attachmentId: id, sourceHash },
  };
}

test("Harness mount and authorization reject missing tokens, short secrets and paths outside the mount", () => {
  const token = "a".repeat(64);
  const bridge = integrationConfig({
    PAPER_WORKBENCH_BASE_PATH: "/paper-workbench/",
    PAPER_WORKBENCH_BRIDGE_TOKEN: token,
  });
  assert.equal(bridge.route("/paper-workbench/api/health"), "/api/health");
  assert.equal(bridge.route("/paper-workbench/"), "/");
  assert.throws(() => bridge.route("/paper-workbench-extra/api/health"), {
    code: "NOT_FOUND",
  });
  for (const authorization of [undefined, "Bearer " + "b".repeat(64), token])
    assert.throws(() => bridge.authorize({ headers: { authorization } }), {
      code: "AUTH_REQUIRED",
    });
  assert.doesNotThrow(() =>
    bridge.authorize({ headers: { authorization: "Bearer " + token } }),
  );
  assert.throws(
    () => integrationConfig({ PAPER_WORKBENCH_BASE_PATH: "/../other" }),
    { code: "BASE_PATH" },
  );
  assert.throws(
    () => integrationConfig({ PAPER_WORKBENCH_BRIDGE_TOKEN: "short" }),
    { code: "BRIDGE_TOKEN" },
  );
  assert.equal(integrationConfig({}).route("/api/documents"), "/api/documents");
});

test("AI context preserves stable identifiers and page sources while bounding the total excerpt", async (t) => {
  const { service, input, store } = setup(t);
  const context = await service.context({
    ...input,
    pageIndices: [1, 0, 0],
    maxChars: 256,
  });
  assert.equal(context.attachmentId, input.attachmentId);
  assert.equal(context.itemId, store.attachment(input.attachmentId).itemId);
  assert.equal(context.sourceHash, input.sourceHash);
  assert.deepEqual(
    context.pages.map((p) => [p.pageIndex, p.source]),
    [
      [0, "native"],
      [1, "ocr"],
    ],
  );
  assert.equal(
    context.pages.reduce((n, p) => n + p.text.length, 0),
    256,
  );
  assert.equal(context.truncated, true);
  const scan = await service.context({ ...input, pageIndices: [1] });
  assert.equal(scan.pages[0].text, "扫描页正文");
  assert.equal(scan.pages[0].pageLabel, "2");
  assert.equal(scan.truncated, false);
  assert.equal(store.snapshot(input.attachmentId).revision, 0);
});

test("AI context rejects stale source/index, invalid ranges, and missing indexes without starting OCR", async (t) => {
  const { service, input, store, dataRoot } = setup(t);
  await assert.rejects(
    service.context({ ...input, sourceHash: "b".repeat(64) }),
    { code: "SOURCE_CHANGED" },
  );
  for (const pageIndices of [[], [-1], [2], [0.2], "0"])
    await assert.rejects(service.context({ ...input, pageIndices }), {
      code: "CONTEXT_PAGES",
    });
  await assert.rejects(service.context({ ...input, maxChars: 1000000 }), {
    code: "CONTEXT_LIMIT",
  });
  store.db
    .prepare("UPDATE text_documents SET source_hash=? WHERE attachment_id=?")
    .run("b".repeat(64), input.attachmentId);
  await assert.rejects(service.context(input), { code: "INDEX_REQUIRED" });
  writeFileSync(path.join(dataRoot, "fixture.pdf"), "changed");
  await assert.rejects(service.context(input), { code: "SOURCE_CHANGED" });
  const empty = setup(t, false);
  await assert.rejects(empty.service.context(empty.input), {
    code: "INDEX_REQUIRED",
  });
  assert.equal(empty.store.fulltext.status().jobs.length, 0);
});

test("AI annotation excerpts never expose upstream geometry or executable markup", () => {
  const result = annotationExcerpts(
    [
      {
        id: "note",
        type: "highlight",
        position: { pageIndex: 1, rects: [[1, 2, 3, 4]] },
        text: "<b>Paper &amp; text</b>",
        comment: "<script>unsafe()</script><i>Comment</i>",
      },
    ],
    2,
  );
  assert.deepEqual(result, [
    {
      id: "note",
      type: "highlight",
      pageIndex: 1,
      text: "Paper & text",
      comment: "Comment",
    },
  ]);
  assert.equal(
    annotationExcerpts([{ id: "outside", position: { pageIndex: 999 } }], 2)[0]
      .pageIndex,
    null,
  );
});
