import { randomUUID } from "node:crypto";
import { requireValue } from "../domain/errors.mjs";
import {
  textTokens,
  fulltextPhrase,
  searchPieces,
  excerpt,
} from "../domain/fulltext.mjs";

export class FulltextRepository {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }
  recover() {
    this.db
      .prepare(
        "UPDATE text_jobs SET status='queued',error=NULL,updated_at=? WHERE status='running'",
      )
      .run(new Date().toISOString());
  }
  enqueue(attachmentId, mode = "text", { onlyMissing = false } = {}) {
    requireValue(
      ["text", "ocr", "force-ocr"].includes(mode),
      "INDEX_MODE",
      "未知的索引方式。",
    );
    const attachment = this.store.attachment(attachmentId);
    const active = this.db
      .prepare(
        "SELECT * FROM text_jobs WHERE attachment_id=? AND status IN ('queued','running')",
      )
      .get(attachmentId);
    if (active) return active;
    if (
      onlyMissing &&
      (this.db
        .prepare(
          "SELECT 1 FROM text_documents WHERE attachment_id=? AND source_hash=?",
        )
        .get(attachmentId, attachment.sourceHash) ||
        this.db
          .prepare(
            "SELECT 1 FROM text_jobs WHERE attachment_id=? AND source_hash=? AND status IN ('failed','cancelled')",
          )
          .get(attachmentId, attachment.sourceHash))
    )
      return null;
    const id = randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO text_jobs(id,attachment_id,source_hash,mode,status,page_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        attachmentId,
        attachment.sourceHash,
        mode,
        "queued",
        attachment.pages,
        now,
        now,
      );
    return this.job(id);
  }
  job(id) {
    const row = this.db.prepare("SELECT * FROM text_jobs WHERE id=?").get(id);
    requireValue(row, "NOT_FOUND", "索引任务不存在。", 404);
    return row;
  }
  next() {
    return this.db
      .prepare(
        "SELECT * FROM text_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1",
      )
      .get();
  }
  mark(id, status, error = null) {
    this.db
      .prepare("UPDATE text_jobs SET status=?,error=?,updated_at=? WHERE id=?")
      .run(status, error, new Date().toISOString(), id);
  }
  savePage(id, page) {
    requireValue(
      this.job(id).status === "running",
      "JOB_STOPPED",
      "任务已停止。",
      409,
    );
    this.db
      .prepare("INSERT OR REPLACE INTO text_job_pages VALUES(?,?,?,?,?)")
      .run(
        id,
        page.pageIndex,
        page.nativeText,
        page.ocrText,
        page.confidence ?? null,
      );
    this.db
      .prepare("UPDATE text_jobs SET updated_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
  }
  staged(id) {
    return this.db
      .prepare("SELECT page_index FROM text_job_pages WHERE job_id=?")
      .all(id)
      .map((row) => row.page_index);
  }
  finish(id, pageCount) {
    const job = this.job(id),
      attachment = this.store.attachment(job.attachment_id);
    requireValue(
      job.status === "running" && attachment.sourceHash === job.source_hash,
      "JOB_STALE",
      "原文件或任务状态已改变。",
      409,
    );
    const pages = this.db
      .prepare(
        "SELECT * FROM text_job_pages WHERE job_id=? ORDER BY page_index",
      )
      .all(id);
    requireValue(
      pages.length === pageCount && pages.every((p, i) => p.page_index === i),
      "INDEX_INCOMPLETE",
      "索引页数不完整，旧索引已保留。",
      409,
    );
    this.store.transaction(() => {
      this.db
        .prepare("DELETE FROM page_text WHERE attachment_id=?")
        .run(job.attachment_id);
      const insert = this.db.prepare(
        "INSERT INTO page_text(attachment_id,page_index,native_text,ocr_text,confidence,tokens) VALUES(?,?,?,?,?,?)",
      );
      for (const p of pages)
        insert.run(
          job.attachment_id,
          p.page_index,
          p.native_text,
          p.ocr_text,
          p.confidence,
          textTokens(p.native_text + "\n" + p.ocr_text).join(" "),
        );
      this.db
        .prepare(
          "INSERT OR REPLACE INTO text_documents VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          job.attachment_id,
          job.source_hash,
          "pdfjs-5.7+tesseract-7",
          new Date().toISOString(),
          pageCount,
          pages.filter((p) => p.native_text.trim().length >= 30).length,
          pages.filter((p) => p.ocr_text.trim()).length,
          pages.filter((p) => (p.native_text + p.ocr_text).trim().length < 30)
            .length,
        );
      this.mark(id, "done");
      this.db.prepare("DELETE FROM text_job_pages WHERE job_id=?").run(id);
    });
  }
  status() {
    return {
      documents: this.db
        .prepare(
          `SELECT a.id,a.item_id AS itemId,a.original_name AS name,a.page_count AS pages,t.indexed_at AS indexedAt,t.native_pages AS nativePages,t.ocr_pages AS ocrPages,t.empty_pages AS emptyPages
        FROM attachments a JOIN item_metadata m ON m.item_id=a.item_id LEFT JOIN text_documents t ON t.attachment_id=a.id AND t.source_hash=a.sha256 WHERE m.archived_at IS NULL ORDER BY a.created_at`,
        )
        .all(),
      jobs: this.db
        .prepare(
          `SELECT j.*,a.original_name AS name,(SELECT count(*) FROM text_job_pages p WHERE p.job_id=j.id) AS completedPages FROM text_jobs j JOIN attachments a ON a.id=j.attachment_id ORDER BY CASE WHEN status='running' THEN 0 WHEN status='queued' THEN 1 ELSE 2 END,j.updated_at DESC LIMIT 200`,
        )
        .all(),
    };
  }
  hits(itemId, text) {
    const pieces = searchPieces(text),
      phrases = pieces.map(fulltextPhrase).filter(Boolean);
    if (!phrases.length) return [];
    const pages = this.db
      .prepare(
        `SELECT p.attachment_id AS attachmentId,p.page_index AS pageIndex,p.native_text,p.ocr_text FROM page_fts f JOIN page_text p ON p.id=f.rowid
      JOIN attachments a ON a.id=p.attachment_id JOIN text_documents d ON d.attachment_id=a.id AND d.source_hash=a.sha256
      WHERE page_fts MATCH ? AND a.item_id=? ORDER BY bm25(page_fts),p.page_index LIMIT 3`,
      )
      .all(phrases.join(" OR "), itemId);
    return pages.map((p) => ({
      attachmentId: p.attachmentId,
      pageIndex: p.pageIndex,
      ocr: Boolean(p.ocr_text),
      snippet: excerpt(p.native_text + "\n" + p.ocr_text, pieces),
    }));
  }
  pages(id) {
    this.store.attachment(id);
    return this.db
      .prepare(
        "SELECT page_index AS pageIndex,native_text AS nativeText,ocr_text AS ocrText,confidence FROM page_text WHERE attachment_id=? ORDER BY page_index",
      )
      .all(id);
  }
  currentPages(id, sourceHash) {
    this.store.attachment(id);
    return this.db
      .prepare(
        `SELECT p.page_index AS pageIndex,p.native_text AS nativeText,p.ocr_text AS ocrText,p.confidence
       FROM page_text p JOIN text_documents d ON d.attachment_id=p.attachment_id
       JOIN attachments a ON a.id=p.attachment_id
       WHERE p.attachment_id=? AND d.source_hash=? AND d.source_hash=a.sha256 ORDER BY p.page_index`,
      )
      .all(id, sourceHash);
  }
}
