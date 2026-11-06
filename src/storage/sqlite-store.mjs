import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { AppError, requireValue } from "../domain/errors.mjs";
import {
  annotationFormat,
  validateAnnotation,
} from "../domain/annotation-validation.mjs";
import { migrateDatabase } from "./migrations.mjs";
import { LibraryRepository } from "./library-repository.mjs";
import { FulltextRepository } from "./fulltext-repository.mjs";
import { searchKey } from "../domain/bibliography.mjs";
import { AgentRepository } from "./agent-repository.mjs";

export class SqliteStore {
  constructor(filename, { autoRead = false } = {}) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    try {
      this.migration = migrateDatabase(this.db, filename);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.fulltext = new FulltextRepository(this);
    this.library = new LibraryRepository(this);
    this.agents = new AgentRepository(this);
    this.autoRead = autoRead;
  }
  close() {
    this.db.close();
  }
  transaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  addAttachment(sample, managedPath, { itemId: existingItemId } = {}) {
    const existing = this.db
      .prepare("SELECT id, sha256 FROM attachments WHERE sample_key=?")
      .get(sample.id);
    if (existing) {
      requireValue(
        existing.sha256 === sample.sha256,
        "SAMPLE_CHANGED",
        "Sample key already refers to a different file",
        409,
      );
      return existing.id;
    }
    const attachmentId = randomUUID();
    const itemId = existingItemId || randomUUID();
    const createdAt = new Date().toISOString();
    const title =
      sample.pdfTitle?.trim() || sample.originalName.replace(/\.pdf$/i, "");
    this.transaction(() => {
      if (existingItemId) this.library.get(existingItemId);
      else
        this.db
          .prepare(
            "INSERT INTO library_items(id,csl_json,created_at) VALUES(?,?,?)",
          )
          .run(itemId, JSON.stringify({ id: itemId, title }), createdAt);
      this.db
        .prepare(
          "INSERT INTO attachments(id,item_id,sample_key,original_name,managed_path,sha256,page_count,byte_length,created_at,name_key) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          attachmentId,
          itemId,
          sample.id,
          sample.originalName,
          managedPath,
          sample.sha256,
          sample.pages,
          sample.bytes,
          createdAt,
          searchKey(sample.originalName),
        );
      this.db
        .prepare(
          "INSERT INTO annotation_documents(attachment_id,format,updated_at) VALUES(?,?,?)",
        )
        .run(attachmentId, annotationFormat, createdAt);
      if (!existingItemId)
        this.library.initializeItem(itemId, { id: itemId, title }, createdAt);
      if (this.autoRead) this.agents.enqueue(attachmentId);
    });
    return attachmentId;
  }
  list() {
    return this.db
      .prepare(
        `SELECT a.id, a.item_id AS itemId, a.sample_key AS sampleKey, a.original_name AS originalName,
      a.sha256 AS sourceHash, a.page_count AS pages, a.byte_length AS bytes,
      json_extract(i.csl_json,'$.title') AS title, d.revision,
      (SELECT count(*) FROM annotations n WHERE n.attachment_id=a.id) AS annotationCount
      FROM attachments a JOIN library_items i ON i.id=a.item_id JOIN annotation_documents d ON d.attachment_id=a.id ORDER BY a.sample_key`,
      )
      .all();
  }
  attachment(id) {
    const row = this.db
      .prepare(
        `SELECT id,item_id AS itemId,sample_key AS sampleKey,original_name AS originalName,
      managed_path AS managedPath,sha256 AS sourceHash,page_count AS pages FROM attachments WHERE id=?`,
      )
      .get(id);
    if (!row) throw new AppError("NOT_FOUND", "Document not found", 404);
    return row;
  }
  snapshot(id) {
    const attachment = this.attachment(id);
    const state = this.db
      .prepare(
        "SELECT revision,format FROM annotation_documents WHERE attachment_id=?",
      )
      .get(id);
    const annotations = this.db
      .prepare(
        "SELECT payload_json FROM annotations WHERE attachment_id=? ORDER BY provider_key",
      )
      .all(id)
      .map((x) => JSON.parse(x.payload_json));
    return {
      attachmentId: id,
      sourceHash: attachment.sourceHash,
      ...state,
      annotations,
    };
  }
  apply(id, mutation) {
    requireValue(
      mutation &&
        typeof mutation.requestId === "string" &&
        mutation.requestId.length <= 128 &&
        mutation.requestId.length > 0,
      "REQUEST_ID",
      "Mutation needs an idempotency key",
    );
    requireValue(
      Number.isInteger(mutation.expectedRevision) &&
        mutation.expectedRevision >= 0,
      "REVISION",
      "Invalid expected revision",
    );
    requireValue(
      Array.isArray(mutation.upserts) && Array.isArray(mutation.deletions),
      "MUTATION",
      "Invalid annotation mutation",
    );
    requireValue(
      mutation.upserts.length + mutation.deletions.length <= 1000,
      "MUTATION_SIZE",
      "Too many annotations in one request",
    );
    const requestHash = createHash("sha256")
      .update(JSON.stringify(mutation))
      .digest("hex");
    return this.transaction(() => {
      const attachment = this.attachment(id);
      requireValue(
        mutation.sourceHash === attachment.sourceHash,
        "SOURCE_CHANGED",
        "Annotation targets a different PDF version",
        409,
      );
      const receipt = this.db
        .prepare(
          "SELECT request_hash,revision FROM mutation_receipts WHERE attachment_id=? AND request_id=?",
        )
        .get(id, mutation.requestId);
      if (receipt) {
        requireValue(
          receipt.request_hash === requestHash,
          "REQUEST_REUSED",
          "Idempotency key was reused for different data",
          409,
        );
        return {
          revision: receipt.revision,
          requestId: mutation.requestId,
          replayed: true,
        };
      }
      const current = this.db
        .prepare(
          "SELECT revision FROM annotation_documents WHERE attachment_id=?",
        )
        .get(id);
      requireValue(
        current.revision === mutation.expectedRevision,
        "REVISION_CONFLICT",
        "Another window changed this document. Preserve the draft and reload.",
        409,
      );
      for (const key of mutation.deletions) {
        requireValue(
          typeof key === "string",
          "ANNOTATION_ID",
          "Invalid deletion ID",
        );
        this.db
          .prepare(
            "DELETE FROM annotations WHERE attachment_id=? AND provider_key=?",
          )
          .run(id, key);
      }
      for (const payload of mutation.upserts) {
        const existing = this.db
          .prepare(
            "SELECT payload_json FROM annotations WHERE attachment_id=? AND provider_key=?",
          )
          .get(id, payload.id);
        const merged = {
          ...(existing ? JSON.parse(existing.payload_json) : {}),
          ...payload,
        };
        validateAnnotation(merged, attachment.pages);
        this.db
          .prepare(
            `INSERT INTO annotations(id,attachment_id,provider_key,payload_json) VALUES(?,?,?,?)
          ON CONFLICT(attachment_id,provider_key) DO UPDATE SET payload_json=excluded.payload_json`,
          )
          .run(randomUUID(), id, payload.id, JSON.stringify(merged));
      }
      const revision = current.revision + 1;
      this.db
        .prepare(
          "UPDATE annotation_documents SET revision=?,updated_at=? WHERE attachment_id=?",
        )
        .run(revision, new Date().toISOString(), id);
      this.db
        .prepare("INSERT INTO mutation_receipts VALUES(?,?,?,?)")
        .run(id, mutation.requestId, requestHash, revision);
      return { revision, requestId: mutation.requestId };
    });
  }
  readingState(id) {
    this.attachment(id);
    return Object.fromEntries(
      this.db
        .prepare(
          "SELECT view_key,payload_json FROM reading_states WHERE attachment_id=?",
        )
        .all(id)
        .map((x) => [x.view_key, JSON.parse(x.payload_json)]),
    );
  }
  saveReadingState(id, view, state) {
    this.attachment(id);
    requireValue(
      ["primary", "secondary"].includes(view),
      "VIEW",
      "Invalid reading view",
    );
    requireValue(
      JSON.stringify(state).length <= 100000,
      "VIEW_STATE_SIZE",
      "Reading state is too large",
    );
    this.db
      .prepare(
        `INSERT INTO reading_states VALUES(?,?,?) ON CONFLICT(attachment_id,view_key) DO UPDATE SET payload_json=excluded.payload_json`,
      )
      .run(id, view, JSON.stringify(state));
  }
  addExport(record) {
    this.db
      .prepare("INSERT INTO exports VALUES(?,?,?,?,?,?,?,?)")
      .run(
        record.id,
        record.attachmentId,
        record.sourceHash,
        record.revision,
        JSON.stringify(record.snapshot),
        record.relativePath,
        record.sha256,
        new Date().toISOString(),
      );
  }
  getExport(id) {
    const row = this.db.prepare("SELECT * FROM exports WHERE id=?").get(id);
    if (!row) throw new AppError("NOT_FOUND", "Export not found", 404);
    return row;
  }
  exports() {
    return this.db.prepare("SELECT * FROM exports ORDER BY created_at").all();
  }
}
