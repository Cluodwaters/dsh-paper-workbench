import { searchKey } from "../domain/bibliography.mjs";
import { fulltextPhrase, searchPieces } from "../domain/fulltext.mjs";

export const LIBRARY_FROM = `FROM library_items i JOIN item_metadata m ON m.item_id=i.id
  LEFT JOIN journal_aliases ja ON ja.alias_key=m.journal_key
  LEFT JOIN journal_terms jt ON jt.term_key=COALESCE(ja.canonical_key,m.journal_key)`;
const marks = (count) => Array(count).fill("?").join(",");
export function libraryWhere(query, resolveJournal, omit = []) {
  const sql = [
      query.archived ? "m.archived_at IS NOT NULL" : "m.archived_at IS NULL",
    ],
    params = [];
  const add = (fragment, ...values) => {
    sql.push(fragment);
    params.push(...values);
  };
  if (query.text) {
    for (const text of searchPieces(query.text)) {
      const metadata = `(instr(m.search_text,?)>0 OR instr(pw_search(COALESCE(jt.label,'')),?)>0 OR EXISTS(SELECT 1 FROM attachments af WHERE af.item_id=i.id AND instr(af.name_key,?)>0))`;
      const phrase = fulltextPhrase(text);
      const fulltext = phrase
        ? `EXISTS(SELECT 1 FROM page_fts f JOIN page_text p ON p.id=f.rowid JOIN attachments af ON af.id=p.attachment_id JOIN text_documents td ON td.attachment_id=af.id AND td.source_hash=af.sha256 WHERE page_fts MATCH ? AND af.item_id=i.id)`
        : "0";
      if (query.scope === "fulltext")
        add(fulltext, ...(phrase ? [phrase] : []));
      else if (query.scope === "all")
        add(
          `(${metadata} OR ${fulltext})`,
          text,
          text,
          text,
          ...(phrase ? [phrase] : []),
        );
      else add(metadata, text, text, text);
    }
  }
  if (!omit.includes("authors") && query.authors.length) {
    if (query.authorMatch === "all")
      for (const key of query.authors)
        add(
          "EXISTS(SELECT 1 FROM item_authors au WHERE au.item_id=i.id AND au.name_key=?)",
          key,
        );
    else
      add(
        `EXISTS(SELECT 1 FROM item_authors au WHERE au.item_id=i.id AND au.name_key IN (${marks(query.authors.length)}))`,
        ...query.authors,
      );
  }
  if (!omit.includes("journals") && query.journals.length) {
    const keys = [...new Set(query.journals.map(resolveJournal))];
    add(
      `COALESCE(ja.canonical_key,m.journal_key) IN (${marks(keys.length)})`,
      ...keys,
    );
  }
  if (!omit.includes("tags") && query.tags.length) {
    if (query.tagMatch === "all")
      for (const key of query.tags)
        add(
          "EXISTS(SELECT 1 FROM item_tags t WHERE t.item_id=i.id AND t.tag_key=?)",
          key,
        );
    else
      add(
        `EXISTS(SELECT 1 FROM item_tags t WHERE t.item_id=i.id AND t.tag_key IN (${marks(query.tags.length)}))`,
        ...query.tags,
      );
  }
  if (!omit.includes("year")) {
    if (query.year.undatedOnly) add("m.year IS NULL");
    else {
      if (query.year.from !== null) add("m.year>=?", query.year.from);
      if (query.year.to !== null) add("m.year<=?", query.year.to);
    }
  }
  if (query.readingStatuses.length)
    add(
      `m.reading_status IN (${marks(query.readingStatuses.length)})`,
      ...query.readingStatuses,
    );
  if (query.reviewStatuses.length)
    add(
      `i.metadata_status IN (${marks(query.reviewStatuses.length)})`,
      ...query.reviewStatuses,
    );
  if (query.needsMetadata) add("m.needs_metadata=1");
  if (query.favoriteOnly) add("m.favorite=1");
  return { sql: sql.join(" AND "), params };
}
export function libraryOrder(sort) {
  const fields = {
    added: "i.created_at",
    updated: "m.updated_at",
    year: "m.year",
    title: "m.title_key",
  };
  return `${sort.field === "year" ? "m.year IS NULL ASC, " : ""}${fields[sort.field]} ${sort.direction === "asc" ? "ASC" : "DESC"},i.id ASC`;
}
