ALTER TABLE attachments ADD COLUMN name_key TEXT NOT NULL DEFAULT '';
CREATE INDEX attachments_by_item ON attachments(item_id);
CREATE INDEX attachments_by_hash ON attachments(sha256);
CREATE TABLE item_metadata (
  item_id TEXT PRIMARY KEY REFERENCES library_items(id),
  revision INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  title TEXT NOT NULL, title_key TEXT NOT NULL,
  year INTEGER, year_source TEXT,
  journal_key TEXT NOT NULL DEFAULT '', doi TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL,
  reading_status TEXT NOT NULL DEFAULT 'unread',
  favorite INTEGER NOT NULL DEFAULT 0,
  needs_metadata INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX metadata_by_year ON item_metadata(year);
CREATE INDEX metadata_by_journal ON item_metadata(journal_key);
CREATE INDEX metadata_by_doi ON item_metadata(doi);
CREATE INDEX metadata_by_archive_status ON item_metadata(archived_at,reading_status);
CREATE TABLE item_authors (
  item_id TEXT NOT NULL REFERENCES library_items(id), position INTEGER NOT NULL,
  name_key TEXT NOT NULL, label TEXT NOT NULL, orcid TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(item_id,position)
);
CREATE INDEX authors_by_name ON item_authors(name_key,item_id);
CREATE TABLE item_tags (
  item_id TEXT NOT NULL REFERENCES library_items(id), tag_key TEXT NOT NULL, label TEXT NOT NULL,
  PRIMARY KEY(item_id,tag_key)
);
CREATE INDEX tags_by_key ON item_tags(tag_key,item_id);
CREATE TABLE journal_terms (term_key TEXT PRIMARY KEY, label TEXT NOT NULL);
CREATE TABLE journal_aliases (
  alias_key TEXT PRIMARY KEY REFERENCES journal_terms(term_key),
  canonical_key TEXT NOT NULL REFERENCES journal_terms(term_key),
  CHECK(alias_key<>canonical_key)
);
CREATE TABLE saved_searches (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, query_json TEXT NOT NULL CHECK(json_valid(query_json)),
  revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE library_mutations (
  scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  PRIMARY KEY(scope,request_id)
);
CREATE TABLE library_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO library_settings VALUES('catalog_revision','0');
