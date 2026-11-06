import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";
import { projectRoot } from "../src/config.mjs";
import { fulltextPhrase } from "../src/domain/fulltext.mjs";
function setup() {
  const parent = path.join(projectRoot, "output/fulltext-tests");
  mkdirSync(parent, { recursive: true });
  const file = path.join(
    mkdtempSync(path.join(parent, "run-")),
    "library.sqlite",
  );
  const store = new SqliteStore(file);
  return { store, file };
}
function attach(store, name = "Paper") {
  return store.addAttachment(
    {
      id: randomUUID(),
      sha256: "a".repeat(64),
      originalName: name + ".pdf",
      pages: 2,
      bytes: 100,
    },
    randomUUID() + ".pdf",
  );
}
function index(store, id, pages) {
  const job = store.fulltext.enqueue(id);
  store.fulltext.mark(job.id, "running");
  pages.forEach((text, pageIndex) =>
    store.fulltext.savePage(job.id, {
      pageIndex,
      nativeText: text,
      ocrText: "",
    }),
  );
  store.fulltext.finish(job.id, pages.length);
  return job;
}
test("fulltext Chinese two-character phrases, English words and phrases combine with metadata filters", () => {
  const { store } = setup(),
    id = attach(store),
    item = store.attachment(id).itemId;
  const record = store.library.get(item);
  store.library.update(item, {
    requestId: randomUUID(),
    expectedRevision: record.revision,
    metadata: {
      ...record.metadata,
      year: 2024,
      authors: [{ literal: "张三" }],
    },
  });
  index(store, id, [
    "熔融金属密度测试 A reversible anharmonicity experiment.",
    "Liquid tungsten diffusion coefficient",
  ]);
  assert.equal(
    store.library.search({ scope: "fulltext", text: "密度" }).total,
    1,
  );
  assert.equal(
    store.library.search({ scope: "fulltext", text: "anharmonicity" }).total,
    1,
  );
  assert.equal(
    store.library.search({
      scope: "fulltext",
      text: '"diffusion coefficient"',
      authors: ["张三"],
      year: { from: 2024, to: 2024 },
    }).total,
    1,
  );
  assert.equal(
    store.library.search({ scope: "fulltext", text: '"coefficient diffusion"' })
      .total,
    0,
  );
  assert.equal(
    store.library.search({ scope: "fulltext", text: "密度 tungsten" }).total,
    1,
  );
  assert.equal(
    store.library.search({
      scope: "fulltext",
      text: "密度",
      year: { from: 2025 },
    }).total,
    0,
  );
  assert.equal(
    store.library.search({ scope: "metadata", text: "anharmonicity" }).total,
    0,
  );
  assert.equal(store.library.search({ scope: "all", text: "Paper" }).total, 1);
  const hits = store.library.search({ scope: "fulltext", text: "tungsten" })
    .items[0].textHits;
  assert.equal(hits[0].pageIndex, 1);
  assert.match(hits[0].snippet, /tungsten/);
  assert.doesNotThrow(() =>
    store.library.search({ scope: "fulltext", text: '" ) OR * - NEAR(' }),
  );
  store.close();
});
test("failed or cancelled rebuild keeps the previous complete index; a complete replacement removes stale words", () => {
  const { store } = setup(),
    id = attach(store);
  index(store, id, ["old unique term", "page two"]);
  const job = store.fulltext.enqueue(id, "ocr");
  store.fulltext.mark(job.id, "running");
  store.fulltext.savePage(job.id, {
    pageIndex: 0,
    nativeText: "new content",
    ocrText: "扫描识别成功",
    confidence: 90,
  });
  assert.throws(() => store.fulltext.finish(job.id, 2), /页数不完整/);
  assert.equal(
    store.library.search({ scope: "fulltext", text: "unique" }).total,
    1,
  );
  assert.equal(
    store.library.search({ scope: "fulltext", text: "扫描" }).total,
    0,
  );
  store.fulltext.savePage(job.id, {
    pageIndex: 1,
    nativeText: "second",
    ocrText: "",
  });
  store.fulltext.finish(job.id, 2);
  assert.equal(
    store.library.search({ scope: "fulltext", text: "unique" }).total,
    0,
  );
  assert.equal(
    store.library.search({ scope: "fulltext", text: "扫描" }).total,
    1,
  );
  store.close();
});
test("running jobs recover durable per-page checkpoints after reopening and active jobs deduplicate", () => {
  const { store, file } = setup(),
    id = attach(store),
    job = store.fulltext.enqueue(id, "ocr");
  store.fulltext.mark(job.id, "running");
  store.fulltext.savePage(job.id, {
    pageIndex: 0,
    nativeText: "first",
    ocrText: "saved",
  });
  assert.equal(store.fulltext.enqueue(id, "ocr").id, job.id);
  store.close();
  const reopened = new SqliteStore(file);
  reopened.fulltext.recover();
  assert.equal(reopened.fulltext.job(job.id).status, "queued");
  assert.deepEqual(reopened.fulltext.staged(job.id), [0]);
  reopened.fulltext.mark(job.id, "running");
  reopened.fulltext.savePage(job.id, {
    pageIndex: 1,
    nativeText: "second",
    ocrText: "",
  });
  reopened.fulltext.finish(job.id, 2);
  assert.equal(reopened.fulltext.pages(id)[0].ocrText, "saved");
  reopened.close();
});
test("tokenizer handles Chinese-Latin mixed strings, scientific typography and quotes as literals", () => {
  assert.equal(
    fulltextPhrase("液体Nb₅Si₃密度"),
    '"han6db2 han4f53 nb5si3 han5bc6 han5ea6"',
  );
  assert.equal(fulltextPhrase("---"), null);
});
