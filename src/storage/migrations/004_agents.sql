CREATE TABLE agent_bindings (
  binding_key TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('master','paper','task','digest')),
  attachment_id TEXT REFERENCES attachments(id), source_hash TEXT,
  created_at TEXT NOT NULL, published_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE paper_jobs (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id), source_hash TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_bindings(session_id),
  kind TEXT NOT NULL CHECK(kind IN ('initial','research','digest')),
  state TEXT NOT NULL DEFAULT 'queued', instruction TEXT NOT NULL,
  baseline_json TEXT NOT NULL, progress_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT, error TEXT, lease_token TEXT, lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX paper_jobs_pending ON paper_jobs(state,created_at);
CREATE TABLE paper_checkpoints (
  job_id TEXT NOT NULL REFERENCES paper_jobs(id), cursor TEXT NOT NULL,
  page_index INTEGER NOT NULL, end_offset INTEGER NOT NULL, note TEXT NOT NULL,
  PRIMARY KEY(job_id,cursor)
);
CREATE TABLE paper_digests (
  id INTEGER PRIMARY KEY, attachment_id TEXT NOT NULL REFERENCES attachments(id),
  source_hash TEXT NOT NULL, session_id TEXT NOT NULL, source_seq INTEGER NOT NULL,
  version INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(attachment_id,version)
);
CREATE VIRTUAL TABLE paper_digest_fts USING fts5(digest_id UNINDEXED,tokens, tokenize='unicode61 remove_diacritics 0');
CREATE TABLE agent_receipts (
  request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response_json TEXT NOT NULL
);
