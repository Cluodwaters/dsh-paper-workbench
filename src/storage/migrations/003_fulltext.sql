CREATE TABLE text_documents (
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(id),
  source_hash TEXT NOT NULL,
  engine TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  native_pages INTEGER NOT NULL,
  ocr_pages INTEGER NOT NULL,
  empty_pages INTEGER NOT NULL
);
CREATE TABLE page_text (
  id INTEGER PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  page_index INTEGER NOT NULL,
  native_text TEXT NOT NULL,
  ocr_text TEXT NOT NULL,
  confidence REAL,
  tokens TEXT NOT NULL,
  UNIQUE(attachment_id,page_index)
);
CREATE VIRTUAL TABLE page_fts USING fts5(tokens, content='page_text', content_rowid='id', tokenize='unicode61 remove_diacritics 0');
CREATE TRIGGER page_text_ai AFTER INSERT ON page_text BEGIN
  INSERT INTO page_fts(rowid,tokens) VALUES(new.id,new.tokens);
END;
CREATE TRIGGER page_text_ad AFTER DELETE ON page_text BEGIN
  INSERT INTO page_fts(page_fts,rowid,tokens) VALUES('delete',old.id,old.tokens);
END;
CREATE TRIGGER page_text_au AFTER UPDATE ON page_text BEGIN
  INSERT INTO page_fts(page_fts,rowid,tokens) VALUES('delete',old.id,old.tokens);
  INSERT INTO page_fts(rowid,tokens) VALUES(new.id,new.tokens);
END;
CREATE TABLE text_jobs (
  id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  source_hash TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('text','ocr','force-ocr')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','cancelled')),
  page_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_text_job ON text_jobs(attachment_id) WHERE status IN ('queued','running');
CREATE TABLE text_job_pages (
  job_id TEXT NOT NULL REFERENCES text_jobs(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL,
  native_text TEXT NOT NULL,
  ocr_text TEXT NOT NULL,
  confidence REAL,
  PRIMARY KEY(job_id,page_index)
);
