import { createHash, randomUUID } from "node:crypto";
import { AppError, requireValue } from "../domain/errors.mjs";
import {
  normalizeMetadata,
  metadataFromCsl,
  metadataToCsl,
  missingFields,
  termKey,
  cleanText,
  searchKey,
  normalizeTags,
} from "../domain/bibliography.mjs";
import { normalizeLibraryQuery } from "../domain/library-query.mjs";
import { writeMetadataIndex } from "./metadata-index.mjs";
import { LIBRARY_FROM, libraryWhere, libraryOrder } from "./library-sql.mjs";

export class LibraryRepository {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.function("pw_search", { deterministic: true }, (value) =>
      searchKey(value || ""),
    );
  }
  initializeItem(id, csl, createdAt) {
    writeMetadataIndex(this.db, id, metadataFromCsl(csl), {
      updatedAt: createdAt,
    });
  }
  resolveJournal(key) {
    return (
      this.db
        .prepare("SELECT canonical_key FROM journal_aliases WHERE alias_key=?")
        .get(key)?.canonical_key || key
    );
  }
  mutation(scope, command, action) {
    requireValue(
      command && typeof command === "object" && !Array.isArray(command),
      "REQUEST",
      "操作内容必须是对象。",
    );
    requireValue(
      typeof command.requestId === "string" &&
        command.requestId.length > 0 &&
        command.requestId.length <= 128,
      "REQUEST_ID",
      "操作缺少请求标识。",
    );
    const hash = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    return this.store.transaction(() => {
      const receipt = this.db
        .prepare(
          "SELECT * FROM library_mutations WHERE scope=? AND request_id=?",
        )
        .get(scope, command.requestId);
      if (receipt) {
        requireValue(
          receipt.request_hash === hash,
          "REQUEST_REUSED",
          "请求标识已用于其他内容。",
          409,
        );
        return JSON.parse(receipt.response_json);
      }
      const result = action();
      this.db
        .prepare("INSERT INTO library_mutations VALUES(?,?,?,?)")
        .run(scope, command.requestId, hash, JSON.stringify(result));
      return result;
    });
  }
  get(id) {
    const row = this.db
      .prepare(
        `SELECT i.csl_json,i.created_at,i.metadata_status,m.*,COALESCE(jt.label,'') AS journal_display,
      COALESCE(ja.canonical_key,m.journal_key) AS canonical_journal_key ${LIBRARY_FROM} WHERE i.id=?`,
      )
      .get(id);
    if (!row) throw new AppError("NOT_FOUND", "没有找到这条文献。", 404);
    const metadata = JSON.parse(row.metadata_json);
    return {
      id,
      revision: row.revision,
      metadata,
      csl: JSON.parse(row.csl_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      year: row.year,
      yearSource: row.year_source,
      journalDisplay: row.journal_display,
      journalKey: row.canonical_journal_key,
      missingFields: missingFields(metadata),
      archivedAt: row.archived_at,
      attachments: this.db
        .prepare(
          `SELECT a.id,a.original_name AS originalName,a.page_count AS pages,a.byte_length AS bytes,a.sample_key AS sampleKey,
        (SELECT count(*) FROM annotations n WHERE n.attachment_id=a.id) AS annotationCount FROM attachments a WHERE a.item_id=? ORDER BY a.created_at,a.id`,
        )
        .all(id),
    };
  }
  search(input = {}, page = {}) {
    const query = normalizeLibraryQuery(input);
    const limit = Number(page.limit ?? 100),
      offset = Number(page.offset ?? 0);
    requireValue(
      Number.isInteger(limit) &&
        limit >= 1 &&
        limit <= 200 &&
        Number.isInteger(offset) &&
        offset >= 0,
      "QUERY_PAGE",
      "分页参数无效。",
    );
    const where = libraryWhere(query, (key) => this.resolveJournal(key));
    const total = this.db
      .prepare(`SELECT count(*) AS n ${LIBRARY_FROM} WHERE ${where.sql}`)
      .get(...where.params).n;
    const rows = this.db
      .prepare(
        `SELECT i.id,m.revision,m.title,m.year,m.year_source,m.reading_status,m.favorite,m.needs_metadata,m.archived_at,
      m.metadata_json,i.metadata_status,i.created_at,m.updated_at,COALESCE(jt.label,'') AS journal_display,
      COALESCE(ja.canonical_key,m.journal_key) AS journal_key,
      (SELECT json_group_array(json_object('id',a.id,'name',a.original_name,'pages',a.page_count)) FROM attachments a WHERE a.item_id=i.id) AS files,
      (SELECT count(*) FROM annotations n JOIN attachments a ON a.id=n.attachment_id WHERE a.item_id=i.id) AS annotation_count
      ${LIBRARY_FROM} WHERE ${where.sql} ORDER BY ${libraryOrder(query.sort)} LIMIT ? OFFSET ?`,
      )
      .all(...where.params, limit, offset);
    return {
      query,
      total,
      limit,
      offset,
      items: rows.map((row) => {
        const metadata = JSON.parse(row.metadata_json);
        return {
          id: row.id,
          revision: row.revision,
          title: row.title,
          authors: metadata.authors,
          year: row.year,
          yearSource: row.year_source,
          journal: row.journal_display,
          journalRaw: metadata.journal,
          journalKey: row.journal_key,
          doi: metadata.doi,
          tags: metadata.tags,
          type: metadata.type,
          readingStatus: row.reading_status,
          reviewStatus: row.metadata_status,
          favorite: Boolean(row.favorite),
          needsMetadata: Boolean(row.needs_metadata),
          archivedAt: row.archived_at,
          updatedAt: row.updated_at,
          createdAt: row.created_at,
          attachments: JSON.parse(row.files),
          annotationCount: row.annotation_count,
          textHits:
            query.text && query.scope !== "metadata"
              ? this.store.fulltext.hits(row.id, query.text)
              : [],
        };
      }),
      facets: this.facets(query),
      counts: this.counts(),
    };
  }
  facets(query) {
    const where = (dimension) =>
      libraryWhere(query, (key) => this.resolveJournal(key), [dimension]);
    const a = where("authors"),
      j = where("journals"),
      t = where("tags"),
      y = where("year");
    return {
      authors: this.db
        .prepare(
          `SELECT au.name_key AS key,min(au.label) AS label,count(DISTINCT i.id) AS count ${LIBRARY_FROM} JOIN item_authors au ON au.item_id=i.id WHERE ${a.sql} GROUP BY au.name_key ORDER BY count DESC,label LIMIT 300`,
        )
        .all(...a.params),
      journals: this.db
        .prepare(
          `SELECT COALESCE(ja.canonical_key,m.journal_key) AS key,min(jt.label) AS label,count(*) AS count ${LIBRARY_FROM} WHERE ${j.sql} AND m.journal_key<>'' GROUP BY COALESCE(ja.canonical_key,m.journal_key) ORDER BY count DESC,label LIMIT 300`,
        )
        .all(...j.params),
      tags: this.db
        .prepare(
          `SELECT t.tag_key AS key,min(t.label) AS label,count(DISTINCT i.id) AS count ${LIBRARY_FROM} JOIN item_tags t ON t.item_id=i.id WHERE ${t.sql} GROUP BY t.tag_key ORDER BY count DESC,label LIMIT 300`,
        )
        .all(...t.params),
      years: this.db
        .prepare(
          `SELECT m.year AS year,count(*) AS count ${LIBRARY_FROM} WHERE ${y.sql} GROUP BY m.year ORDER BY m.year DESC`,
        )
        .all(...y.params),
    };
  }
  counts() {
    const counts = this.db
      .prepare(
        `SELECT count(*) AS total,sum(m.archived_at IS NULL) AS active,
    sum(m.archived_at IS NOT NULL) AS archived,sum(m.archived_at IS NULL AND m.needs_metadata=1) AS needsMetadata,
    sum(m.archived_at IS NULL AND m.reading_status='unread') AS unread,sum(m.archived_at IS NULL AND m.favorite=1) AS favorites
    FROM item_metadata m`,
      )
      .get();
    return Object.fromEntries(
      Object.entries(counts).map(([key, value]) => [key, value ?? 0]),
    );
  }
  write(id, metadata, revision, archivedAt) {
    const current = this.db
      .prepare("SELECT csl_json FROM library_items WHERE id=?")
      .get(id);
    const csl = metadataToCsl(JSON.parse(current.csl_json), metadata, id);
    this.db
      .prepare(
        "UPDATE library_items SET csl_json=?,metadata_status=? WHERE id=?",
      )
      .run(JSON.stringify(csl), metadata.reviewStatus, id);
    writeMetadataIndex(this.db, id, metadata, { revision, archivedAt });
  }
  create(command) {
    return this.mutation("create", command, () => {
      const metadata = normalizeMetadata(command.metadata),
        id = randomUUID(),
        createdAt = new Date().toISOString();
      const csl = metadataToCsl({}, metadata, id);
      this.db
        .prepare(
          "INSERT INTO library_items(id,csl_json,metadata_status,created_at) VALUES(?,?,?,?)",
        )
        .run(id, JSON.stringify(csl), metadata.reviewStatus, createdAt);
      writeMetadataIndex(this.db, id, metadata, { updatedAt: createdAt });
      return this.get(id);
    });
  }
  update(id, command) {
    return this.mutation("item:" + id, command, () => {
      const current = this.get(id);
      requireValue(
        current.revision === command.expectedRevision,
        "METADATA_CONFLICT",
        "这条文献已在其他窗口更新，请保留草稿后重新载入。",
        409,
      );
      const metadata = normalizeMetadata(command.metadata);
      this.write(id, metadata, current.revision + 1, current.archivedAt);
      return this.get(id);
    });
  }
  batch(command) {
    return this.mutation("batch", command, () => {
      requireValue(
        Array.isArray(command.items) &&
          command.items.length > 0 &&
          command.items.length <= 200,
        "BATCH_ITEMS",
        "每次可批量修改 1—200 条文献。",
      );
      requireValue(
        new Set(command.items.map((x) => x.id)).size === command.items.length,
        "BATCH_ITEMS",
        "批量选择包含重复条目。",
      );
      const change = command.changes || {};
      const allowed = new Set([
        "readingStatus",
        "reviewStatus",
        "favorite",
        "journal",
        "year",
        "addTags",
        "removeTags",
        "archived",
      ]);
      requireValue(
        Object.keys(change).length > 0 &&
          Object.keys(change).every((key) => allowed.has(key)),
        "BATCH_FIELDS",
        "批量修改字段无效。",
      );
      const rows = command.items.map((item) => {
        const row = this.get(item.id);
        requireValue(
          row.revision === item.expectedRevision,
          "METADATA_CONFLICT",
          "部分条目已被更新，本次批量修改尚未写入。",
          409,
        );
        return row;
      });
      for (const row of rows) {
        const metadata = { ...row.metadata };
        for (const key of [
          "readingStatus",
          "reviewStatus",
          "favorite",
          "journal",
          "year",
        ])
          if (Object.hasOwn(change, key)) metadata[key] = change[key];
        const remove = new Set(
          normalizeTags(change.removeTags || []).map(termKey),
        );
        metadata.tags = normalizeTags([
          ...metadata.tags.filter((tag) => !remove.has(termKey(tag))),
          ...normalizeTags(change.addTags || []),
        ]);
        const archivedAt = Object.hasOwn(change, "archived")
          ? change.archived
            ? new Date().toISOString()
            : null
          : row.archivedAt;
        this.write(
          row.id,
          normalizeMetadata(metadata),
          row.revision + 1,
          archivedAt,
        );
      }
      return {
        updated: rows.map((row) => ({
          id: row.id,
          revision: row.revision + 1,
        })),
        count: rows.length,
      };
    });
  }
  searches() {
    return this.db
      .prepare("SELECT * FROM saved_searches ORDER BY name,id")
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        query: JSON.parse(row.query_json),
        revision: row.revision,
      }));
  }
  saveSearch(command) {
    return this.mutation("search:" + (command.id || "new"), command, () => {
      const name = cleanText(command.name, 100);
      requireValue(name, "SEARCH_NAME", "请填写智能集合名称。");
      const query = normalizeLibraryQuery(command.query),
        now = new Date().toISOString();
      let id = command.id || randomUUID(),
        revision = 0;
      if (command.id) {
        const old = this.db
          .prepare("SELECT revision FROM saved_searches WHERE id=?")
          .get(id);
        requireValue(old, "NOT_FOUND", "智能集合不存在。", 404);
        requireValue(
          old.revision === command.expectedRevision,
          "SEARCH_CONFLICT",
          "智能集合已更新，请刷新后再试。",
          409,
        );
        revision = old.revision + 1;
        this.db
          .prepare(
            "UPDATE saved_searches SET name=?,query_json=?,revision=?,updated_at=? WHERE id=?",
          )
          .run(name, JSON.stringify(query), revision, now, id);
      } else
        this.db
          .prepare("INSERT INTO saved_searches VALUES(?,?,?,?,?,?)")
          .run(id, name, JSON.stringify(query), revision, now, now);
      return { id, name, query, revision };
    });
  }
  deleteSearch(command) {
    return this.mutation("search-delete:" + command.id, command, () => {
      const old = this.db
        .prepare("SELECT revision FROM saved_searches WHERE id=?")
        .get(command.id);
      requireValue(old, "NOT_FOUND", "智能集合不存在。", 404);
      requireValue(
        old.revision === command.expectedRevision,
        "SEARCH_CONFLICT",
        "智能集合已更新。",
        409,
      );
      this.db.prepare("DELETE FROM saved_searches WHERE id=?").run(command.id);
      return { deleted: true };
    });
  }
  aliases() {
    return {
      revision: Number(
        this.db
          .prepare(
            "SELECT value FROM library_settings WHERE key='catalog_revision'",
          )
          .get().value,
      ),
      aliases: this.db
        .prepare(
          `SELECT a.alias_key AS aliasKey,a.canonical_key AS canonicalKey,t.label AS alias,c.label AS canonical
      FROM journal_aliases a JOIN journal_terms t ON t.term_key=a.alias_key JOIN journal_terms c ON c.term_key=a.canonical_key ORDER BY c.label,t.label`,
        )
        .all(),
    };
  }
  setAlias(command) {
    return this.mutation("journal-alias", command, () => {
      const catalog = this.aliases();
      requireValue(
        catalog.revision === command.expectedRevision,
        "CATALOG_CONFLICT",
        "期刊别名已更新，请刷新后再试。",
        409,
      );
      const alias = cleanText(command.alias, 500),
        canonical = cleanText(command.canonical, 500),
        aliasKey = termKey(alias);
      requireValue(aliasKey, "JOURNAL_ALIAS", "请填写期刊别名。");
      if (command.remove)
        this.db
          .prepare("DELETE FROM journal_aliases WHERE alias_key=?")
          .run(aliasKey);
      else {
        const key = this.resolveJournal(termKey(canonical));
        requireValue(
          key && key !== aliasKey,
          "JOURNAL_ALIAS",
          "别名不能指向自身或形成循环。",
        );
        const insert = this.db.prepare(
          "INSERT INTO journal_terms VALUES(?,?) ON CONFLICT(term_key) DO NOTHING",
        );
        insert.run(aliasKey, alias);
        insert.run(termKey(canonical), canonical);
        this.db
          .prepare(
            "UPDATE journal_aliases SET canonical_key=? WHERE canonical_key=?",
          )
          .run(key, aliasKey);
        this.db
          .prepare(
            "INSERT INTO journal_aliases VALUES(?,?) ON CONFLICT(alias_key) DO UPDATE SET canonical_key=excluded.canonical_key",
          )
          .run(aliasKey, key);
      }
      this.db
        .prepare(
          "UPDATE library_settings SET value=? WHERE key='catalog_revision'",
        )
        .run(String(catalog.revision + 1));
      return this.aliases();
    });
  }
}
