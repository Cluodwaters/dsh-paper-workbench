ALTER TABLE agent_page_reads ADD COLUMN spans TEXT NOT NULL DEFAULT '[]';
DELETE FROM agent_page_reads AS r WHERE EXISTS (
  SELECT 1 FROM page_text p JOIN text_documents d ON d.attachment_id=p.attachment_id
  WHERE p.attachment_id=(SELECT attachment_id FROM agent_bindings WHERE session_id=r.session_id) AND p.page_index=r.page_index AND d.source_hash=r.source_hash
    AND trim(p.native_text || p.ocr_text,char(9,10,13,32))=''
);
