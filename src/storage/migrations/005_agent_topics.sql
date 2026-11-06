CREATE TABLE agent_heads (
  scope_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_bindings(session_id)
);
INSERT INTO agent_heads(scope_key,session_id)
  SELECT binding_key,session_id FROM agent_bindings
  WHERE role IN ('master','paper');
ALTER TABLE agent_bindings ADD COLUMN summary_turn_seq INTEGER NOT NULL DEFAULT 0;
CREATE TABLE agent_page_reads (
  session_id TEXT NOT NULL REFERENCES agent_bindings(session_id),
  source_hash TEXT NOT NULL, page_index INTEGER NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id,source_hash,page_index)
);
CREATE INDEX agent_bindings_scope ON agent_bindings(role,attachment_id,created_at);
