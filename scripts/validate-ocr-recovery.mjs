import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";
import { IndexService } from "../src/application/index-service.mjs";
import { projectRoot } from "../src/config.mjs";
const directory = mkdtempSync(path.join(projectRoot, "output/ocr-recovery-")),
  file = path.join(directory, "library.sqlite");
const source = path.join(
    projectRoot,
    "data/validation/fixtures/fixture-scanned.pdf",
  ),
  bytes = readFileSync(source),
  hash = createHash("sha256").update(bytes).digest("hex");
copyFileSync(source, path.join(directory, "scanned.pdf"));
let store = new SqliteStore(file),
  indexer = new IndexService({ store, projectRoot, dataRoot: directory });
const id = store.addAttachment(
  {
    id: "ocr-restart",
    sha256: hash,
    pages: 2,
    bytes: bytes.length,
    originalName: "扫描恢复测试.pdf",
  },
  "scanned.pdf",
);
const [job] = indexer.enqueue([id], "ocr");
let deadline = Date.now() + 90000;
while (store.fulltext.staged(job.id).length < 1) {
  if (Date.now() > deadline) throw new Error("OCR checkpoint timeout");
  if (store.fulltext.job(job.id).status === "failed")
    throw new Error(store.fulltext.job(job.id).error);
  await new Promise((r) => setTimeout(r, 20));
}
indexer.setPaused(true);
await indexer.close();
const stagedBefore = store.fulltext.staged(job.id);
assert.equal(store.fulltext.pages(id).length, 0);
store.close();
store = new SqliteStore(file);
indexer = new IndexService({ store, projectRoot, dataRoot: directory });
assert.equal(indexer.paused, true);
assert.deepEqual(store.fulltext.staged(job.id), stagedBefore);
indexer.setPaused(false);
deadline = Date.now() + 90000;
while (store.fulltext.job(job.id).status !== "done") {
  if (Date.now() > deadline) throw new Error("OCR completion timeout");
  if (store.fulltext.job(job.id).status === "failed")
    throw new Error(store.fulltext.job(job.id).error);
  await new Promise((r) => setTimeout(r, 50));
}
const pages = store.fulltext.pages(id);
assert.equal(pages.length, 2);
assert.match(pages[0].ocrText, /Supplementary Information/i);
assert.equal(
  store.library.search({ scope: "fulltext", text: "Supplementary" }).total,
  1,
);
assert.equal(
  createHash("sha256")
    .update(readFileSync(path.join(directory, "scanned.pdf")))
    .digest("hex"),
  hash,
);
const result = {
  passed: true,
  stagedBeforeRestart: stagedBefore,
  completedPages: pages.length,
  confidence: pages.map((p) => p.confidence),
  sourceUnchanged: true,
};
await indexer.close();
assert.equal(store.fulltext.job(job.id).status, "done");
indexer = new IndexService({ store, projectRoot, dataRoot: directory });
const [cancelledJob] = indexer.enqueue([id], "force-ocr");
indexer.cancel(cancelledJob.id);
await indexer.close();
assert.equal(store.fulltext.job(cancelledJob.id).status, "cancelled");
result.completedJobNotRequeued = true;
result.cancelledJobNotRequeued = true;
store.close();
writeFileSync(
  path.join(projectRoot, "output/stage3-ocr-recovery.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
