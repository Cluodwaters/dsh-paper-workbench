import { writeFileSync } from "node:fs";
import path from "node:path";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";
import { IndexService } from "../src/application/index-service.mjs";
import { lockLibrary } from "../src/storage/library-lock.mjs";
import { projectRoot, dataRoot, databasePath } from "../src/config.mjs";
const release = lockLibrary(dataRoot);
process.on("exit", release);
const store = new SqliteStore(databasePath),
  indexer = new IndexService({ store, projectRoot, dataRoot });
const started = Date.now();
let lastLog = 0;
async function complete() {
  while (indexer.active || store.fulltext.next()) {
    if (Date.now() - lastLog > 5000) {
      const state = indexer.status();
      console.log(
        JSON.stringify({
          indexed: state.documents.filter((d) => d.indexedAt).length,
          total: state.documents.length,
          progress: state.progress,
        }),
      );
      lastLog = Date.now();
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
try {
  indexer.setPaused(false);
  indexer.enqueueMissing();
  await complete();
  if (process.argv.includes("--ocr-sparse")) {
    const ids = indexer
      .status()
      .documents.filter((d) => d.indexedAt && d.emptyPages > 0)
      .map((d) => d.id);
    indexer.enqueue(ids, "ocr");
    await complete();
  }
  const state = indexer.status();
  const result = {
    createdAt: new Date().toISOString(),
    durationSeconds: (Date.now() - started) / 1000,
    documents: state.documents.length,
    indexedDocuments: state.documents.filter((d) => d.indexedAt).length,
    indexedPages: state.documents
      .filter((d) => d.indexedAt)
      .reduce((n, d) => n + d.pages, 0),
    nativePages: state.documents.reduce((n, d) => n + (d.nativePages || 0), 0),
    ocrPages: state.documents.reduce((n, d) => n + (d.ocrPages || 0), 0),
    emptyPages: state.documents.reduce((n, d) => n + (d.emptyPages || 0), 0),
    failures: state.jobs
      .filter((j) => j.status === "failed")
      .map((j) => ({ name: j.name, error: j.error })),
    integrity: store.db.prepare("PRAGMA integrity_check").get().integrity_check,
  };
  writeFileSync(
    path.join(projectRoot, "output/stage3-primary-index.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await indexer.close();
  store.close();
  release();
}
