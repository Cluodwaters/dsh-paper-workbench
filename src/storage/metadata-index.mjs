import {
  authorLabel,
  effectiveYear,
  missingFields,
  searchKey,
  termKey,
} from "../domain/bibliography.mjs";

/** Derived, rebuildable indexes. The original CSL record and metadata payload remain authoritative. */
export function writeMetadataIndex(
  db,
  itemId,
  metadata,
  {
    revision = 0,
    updatedAt = new Date().toISOString(),
    archivedAt = null,
  } = {},
) {
  const year = effectiveYear(metadata),
    journalKey = termKey(metadata.journal);
  if (journalKey)
    db.prepare(
      "INSERT INTO journal_terms VALUES(?,?) ON CONFLICT(term_key) DO NOTHING",
    ).run(journalKey, metadata.journal);
  const searchText = searchKey(
    [
      metadata.title,
      ...metadata.authors.map(authorLabel),
      ...metadata.authors.map((a) => a.orcid || ""),
      metadata.journal,
      metadata.doi,
      metadata.abstract,
      metadata.publisher,
      ...metadata.tags,
    ].join("\n"),
  );
  db.prepare(
    `INSERT INTO item_metadata VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET revision=excluded.revision, metadata_json=excluded.metadata_json,
    title=excluded.title,title_key=excluded.title_key,year=excluded.year,year_source=excluded.year_source,
    journal_key=excluded.journal_key,doi=excluded.doi,search_text=excluded.search_text,reading_status=excluded.reading_status,
    favorite=excluded.favorite,needs_metadata=excluded.needs_metadata,archived_at=excluded.archived_at,updated_at=excluded.updated_at`,
  ).run(
    itemId,
    revision,
    JSON.stringify(metadata),
    metadata.title,
    searchKey(metadata.title),
    year.value,
    year.source,
    journalKey,
    metadata.doi,
    searchText,
    metadata.readingStatus,
    Number(metadata.favorite),
    Number(missingFields(metadata).length > 0),
    archivedAt,
    updatedAt,
  );
  db.prepare("DELETE FROM item_authors WHERE item_id=?").run(itemId);
  const authorInsert = db.prepare("INSERT INTO item_authors VALUES(?,?,?,?,?)");
  metadata.authors.forEach((author, index) =>
    authorInsert.run(
      itemId,
      index,
      termKey(authorLabel(author)),
      authorLabel(author),
      author.orcid || "",
    ),
  );
  db.prepare("DELETE FROM item_tags WHERE item_id=?").run(itemId);
  const tagInsert = db.prepare("INSERT INTO item_tags VALUES(?,?,?)");
  metadata.tags.forEach((tag) => tagInsert.run(itemId, termKey(tag), tag));
}
