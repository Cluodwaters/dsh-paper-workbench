import { writeFileSync } from "node:fs";
import path from "node:path";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";
import { databasePath, projectRoot } from "../src/config.mjs";
const store = new SqliteStore(databasePath);
const snapshots = store
  .list()
  .filter((d) => d.annotationCount > 0)
  .map((d) => ({
    sampleKey: d.sampleKey,
    attachmentId: d.id,
    snapshot: store.snapshot(d.id),
    readingState: store.readingState(d.id),
  }));
const filename = path.join(
  projectRoot,
  "output",
  process.argv[2] || "restart-checkpoint.json",
);
writeFileSync(filename, JSON.stringify(snapshots, null, 2));
console.log(
  JSON.stringify({
    documents: snapshots.length,
    annotations: snapshots.reduce(
      (s, x) => s + x.snapshot.annotations.length,
      0,
    ),
    filename,
  }),
);
store.close();
