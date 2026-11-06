import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";
import { projectRoot, dataRoot, databasePath } from "../src/config.mjs";
import { SCHEMA_VERSION } from "../src/storage/migrations.mjs";
import { lockLibrary } from "../src/storage/library-lock.mjs";

const tables = {
  library_items: [
    "id",
    "schema_version",
    "csl_json",
    "metadata_status",
    "created_at",
  ],
  attachments: [
    "id",
    "item_id",
    "sample_key",
    "original_name",
    "managed_path",
    "sha256",
    "page_count",
    "byte_length",
    "created_at",
  ],
  annotation_documents: ["attachment_id", "format", "revision", "updated_at"],
  annotations: ["id", "attachment_id", "provider_key", "payload_json"],
  reading_states: ["attachment_id", "view_key", "payload_json"],
  exports: [
    "id",
    "attachment_id",
    "source_hash",
    "annotation_revision",
    "snapshot_json",
    "relative_path",
    "sha256",
    "created_at",
  ],
};
function snapshot(db) {
  return Object.fromEntries(
    Object.entries(tables).map(([table, columns]) => {
      const rows = db
        .prepare(
          `SELECT ${columns.join(",")} FROM ${table} ORDER BY ${columns.join(",")}`,
        )
        .all();
      return [
        table,
        {
          count: rows.length,
          digest: createHash("sha256")
            .update(JSON.stringify(rows))
            .digest("hex"),
        },
      ];
    }),
  );
}
const release = lockLibrary(dataRoot);
process.on("exit", release);
const previous = new DatabaseSync(databasePath, { readOnly: true });
for (const row of previous
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )
  .all()) {
  if (
    !tables[row.name] &&
    !row.name.startsWith("page_fts") &&
    !row.name.startsWith("text_") &&
    row.name !== "page_text"
  )
    tables[row.name] = previous
      .prepare(`PRAGMA table_info("${row.name.replaceAll('"', '""')}")`)
      .all()
      .map((c) => c.name);
}
const before = snapshot(previous);
previous.close();
const store = new SqliteStore(databasePath),
  after = snapshot(store.db);
const records = Object.entries(before).map(([table, value]) => ({
  table,
  before: value.count,
  after: after[table].count,
  unchanged: value.digest === after[table].digest,
}));
const files = store.db
  .prepare("SELECT id,managed_path,sha256 FROM attachments")
  .all()
  .map((file) => ({
    id: file.id,
    matches:
      createHash("sha256")
        .update(readFileSync(path.join(dataRoot, file.managed_path)))
        .digest("hex") === file.sha256,
  }));
const result = {
  migration: store.migration,
  schemaVersion: store.db.prepare("PRAGMA user_version").get().user_version,
  records,
  filesChecked: files.length,
  filesUnchanged: files.filter((x) => x.matches).length,
  integrity: store.db.prepare("PRAGMA integrity_check").get().integrity_check,
};
store.close();
release();
mkdirSync(path.join(projectRoot, "output"), { recursive: true });
const reportName = `stage${SCHEMA_VERSION}-primary-upgrade.json`;
writeFileSync(
  path.join(projectRoot, "output", reportName),
  JSON.stringify(result, null, 2),
);
if (
  records.some((row) => !row.unchanged) ||
  files.some((file) => !file.matches) ||
  result.integrity !== "ok"
)
  throw new Error(
    "Upgrade verification failed; inspect " +
      reportName +
      " and the automatic backup",
  );
console.log(JSON.stringify(result));
