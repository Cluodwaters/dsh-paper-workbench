import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { requireValue } from "../domain/errors.mjs";
import { metadataFromCsl, searchKey } from "../domain/bibliography.mjs";
import { writeMetadataIndex } from "./metadata-index.mjs";

export const SCHEMA_VERSION = 5;
export function migrateDatabase(db, filename) {
  const originalVersion = db.prepare("PRAGMA user_version").get().user_version;
  requireValue(
    originalVersion <= SCHEMA_VERSION,
    "SCHEMA_TOO_NEW",
    "资料库来自更新版本，请使用匹配的程序。",
    409,
  );
  let backupPath = null;
  if (originalVersion > 0 && originalVersion < SCHEMA_VERSION) {
    const directory = path.join(path.dirname(filename), "backups");
    mkdirSync(directory, { recursive: true });
    backupPath = path.join(
      directory,
      `before-schema-${originalVersion}-to-${SCHEMA_VERSION}-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`,
    );
    db.prepare("VACUUM INTO ?").run(backupPath);
  }
  const steps = ["001_initial.sql", "002_library.sql", "003_fulltext.sql", "004_agents.sql", "005_agent_topics.sql"];
  for (
    let version = originalVersion + 1;
    version <= SCHEMA_VERSION;
    version++
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        readFileSync(
          new URL(`./migrations/${steps[version - 1]}`, import.meta.url),
          "utf8",
        ),
      );
      if (version === 2) {
        for (const row of db.prepare("SELECT * FROM library_items").all()) {
          const metadata = metadataFromCsl(
            JSON.parse(row.csl_json),
            row.metadata_status,
          );
          writeMetadataIndex(db, row.id, metadata, {
            updatedAt: row.created_at,
          });
        }
        const update = db.prepare(
          "UPDATE attachments SET name_key=? WHERE id=?",
        );
        for (const file of db
          .prepare("SELECT id,original_name FROM attachments")
          .all())
          update.run(searchKey(file.original_name), file.id);
        db.prepare("INSERT INTO library_settings VALUES('library_id',?)").run(
          randomUUID(),
        );
      }
      db.exec(`PRAGMA user_version=${version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return { from: originalVersion, to: SCHEMA_VERSION, backupPath };
}
