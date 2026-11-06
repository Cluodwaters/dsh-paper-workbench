CREATE TABLE library_items (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  csl_json TEXT NOT NULL CHECK(json_valid(csl_json)),
  metadata_status TEXT NOT NULL DEFAULT 'unverified',
  created_at TEXT NOT NULL
);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES library_items(id),
  sample_key TEXT UNIQUE,
  original_name TEXT NOT NULL,
  managed_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  page_count INTEGER NOT NULL CHECK(page_count > 0),
  byte_length INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE annotation_documents (
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(id),
  format TEXT NOT NULL DEFAULT 'zotero-pdf-v1',
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  provider_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  UNIQUE(attachment_id, provider_key)
);
CREATE TABLE mutation_receipts (
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(attachment_id, request_id)
);
CREATE TABLE reading_states (
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  view_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(attachment_id, view_key)
);
CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  source_hash TEXT NOT NULL,
  annotation_revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX annotations_by_attachment ON annotations(attachment_id);
