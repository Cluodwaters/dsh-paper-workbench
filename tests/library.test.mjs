import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";
import { projectRoot } from "../src/config.mjs";
import {
  normalizeMetadata,
  normalizeDoi,
  metadataFromCsl,
  metadataToCsl,
  termKey,
} from "../src/domain/bibliography.mjs";

const parent = path.join(projectRoot, "output/library-tests");
mkdirSync(parent, { recursive: true });
function setup() {
  const dir = mkdtempSync(path.join(parent, "run-"));
  const filename = path.join(dir, "library.sqlite");
  const store = new SqliteStore(filename);
  return { store, library: store.library, filename, dir };
}
function create(library, title, fields = {}) {
  return library.create({
    requestId: randomUUID(),
    metadata: {
      title,
      type: "article-journal",
      authors: [{ literal: "Alice" }],
      year: 2024,
      journal: "Journal A",
      ...fields,
    },
  });
}
const request = (extra) => ({ requestId: randomUUID(), ...extra });
function fixture(library) {
  return [
    create(library, "Density A", {
      authors: [{ literal: "Alice" }, { literal: "Bob" }],
      tags: ["density", "metal"],
    }),
    create(library, "Density B", {
      authors: [{ literal: "Bob" }],
      year: 2025,
      journal: "Journal B",
      tags: ["density"],
      readingStatus: "read",
    }),
    create(library, "中文密度研究", {
      authors: [{ literal: "张三" }],
      year: 2023,
      journal: "Journal A",
      tags: ["金属"],
    }),
    create(library, "Unknown date", { authors: [], year: null, journal: "" }),
  ];
}

test("combined facets use AND across fields and OR within a field; all-author matching is explicit", () => {
  const c = setup();
  const rows = fixture(c.library);
  assert.deepEqual(
    c.library
      .search({
        authors: ["alice", "bob"],
        journals: ["journal a"],
        year: { from: 2024, to: 2025 },
      })
      .items.map((x) => x.id),
    [rows[0].id],
  );
  assert.equal(
    c.library.search({ authors: ["alice", "bob"], authorMatch: "all" }).total,
    1,
  );
  assert.equal(
    c.library.search({
      authors: ["bob"],
      tags: ["density", "metal"],
      tagMatch: "all",
    }).total,
    1,
  );
  c.store.close();
});
test("missing year, unknown author, date boundaries and Chinese short-term metadata search are explicit", () => {
  const c = setup();
  fixture(c.library);
  assert.equal(c.library.search({ year: { undatedOnly: true } }).total, 1);
  assert.equal(c.library.search({ year: { from: 2024, to: 2024 } }).total, 1);
  assert.equal(c.library.search({ text: "密度" }).total, 1);
  assert.equal(c.library.search({ needsMetadata: true }).total, 1);
  assert.throws(() => c.library.search({ year: { from: 2025, to: 2020 } }), {
    code: "QUERY_YEAR_RANGE",
  });
  c.store.close();
});
test("same-name facets do not duplicate a paper, and structured author order is preserved", () => {
  const c = setup();
  const r = create(c.library, "Authors", {
    authors: [
      { family: "Gohil", given: "D. R." },
      { literal: "研究组" },
      { family: "Gohil", given: "D. R." },
    ],
  });
  const found = c.library.search({ authors: ["gohil, d. r."] });
  assert.equal(found.total, 1);
  assert.equal(
    found.facets.authors.find((x) => x.key === "gohil, d. r.").count,
    1,
  );
  assert.deepEqual(c.library.get(r.id).csl.author, [
    { family: "Gohil", given: "D. R." },
    { literal: "研究组" },
    { family: "Gohil", given: "D. R." },
  ]);
  c.store.close();
});
test("journal aliases group without rewriting original journal strings or breaking saved alias queries", () => {
  const c = setup();
  create(c.library, "Short", { journal: "Phys. Rev. B" });
  create(c.library, "Long", { journal: "Physical Review B" });
  const saved = c.library.saveSearch(
    request({
      name: "Old alias search",
      query: { journals: ["Phys. Rev. B"] },
    }),
  );
  c.library.setAlias(
    request({
      alias: "Phys. Rev. B",
      canonical: "Physical Review B",
      expectedRevision: 0,
    }),
  );
  const result = c.library.search(saved.query);
  assert.equal(result.total, 2);
  assert.equal(result.facets.journals.length, 1);
  assert.ok(result.items.some((x) => x.journalRaw === "Phys. Rev. B"));
  assert.equal(c.library.search({ text: "physical review b" }).total, 2);
  assert.throws(
    () =>
      c.library.setAlias(
        request({
          alias: "Physical Review B",
          canonical: "Phys. Rev. B",
          expectedRevision: 1,
        }),
      ),
    { code: "JOURNAL_ALIAS" },
  );
  c.store.close();
});
test("metadata saves protect revisions, replay safely, and do not alter attachment or annotation IDs", () => {
  const c = setup();
  const attachmentId = c.store.addAttachment(
    {
      id: "old",
      originalName: "old.pdf",
      sha256: "a".repeat(64),
      pages: 3,
      bytes: 20,
    },
    "files/old.pdf",
  );
  const id = c.store.attachment(attachmentId).itemId;
  const old = c.library.get(id);
  const command = request({
    expectedRevision: 0,
    metadata: {
      ...old.metadata,
      title: "Edited",
      authors: [{ literal: "张三" }],
      year: 2026,
    },
  });
  const saved = c.library.update(id, command);
  assert.equal(saved.revision, 1);
  assert.equal(c.library.update(id, command).revision, 1);
  assert.throws(
    () =>
      c.library.update(
        id,
        request({ expectedRevision: 0, metadata: old.metadata }),
      ),
    { code: "METADATA_CONFLICT" },
  );
  assert.equal(c.store.attachment(attachmentId).itemId, id);
  assert.equal(c.store.snapshot(attachmentId).revision, 0);
  c.store.close();
});
test("batch modification is all-or-nothing when a stale row is included", () => {
  const c = setup();
  const [a, b] = fixture(c.library);
  c.library.update(
    b.id,
    request({
      expectedRevision: 0,
      metadata: { ...b.metadata, title: "Other edit" },
    }),
  );
  assert.throws(
    () =>
      c.library.batch(
        request({
          items: [
            { id: a.id, expectedRevision: 0 },
            { id: b.id, expectedRevision: 0 },
          ],
          changes: { readingStatus: "read" },
        }),
      ),
    { code: "METADATA_CONFLICT" },
  );
  assert.equal(c.library.get(a.id).metadata.readingStatus, "unread");
  c.store.close();
});
test("trash/restore retains files and annotations; tags normalize without splitting multi-word labels", () => {
  const c = setup();
  const a = create(c.library, "Trash", {
    tags: ["Machine Learning", " machine learning ", "金属"],
  });
  assert.equal(a.metadata.tags.length, 2);
  c.library.batch(
    request({
      items: [{ id: a.id, expectedRevision: 0 }],
      changes: { archived: true },
    }),
  );
  assert.equal(c.library.search({}).total, 0);
  assert.equal(c.library.search({ archived: true }).total, 1);
  c.library.batch(
    request({
      items: [{ id: a.id, expectedRevision: 1 }],
      changes: {
        archived: false,
        addTags: ["Density"],
        readingStatus: "reading",
      },
    }),
  );
  assert.equal(
    c.library.search({ tags: ["density"], readingStatuses: ["reading"] }).total,
    1,
  );
  c.store.close();
});
test("saved searches persist across reopening and evaluate new matching records", () => {
  const c = setup();
  const s = c.library.saveSearch(
    request({
      name: "Recent",
      query: { year: { from: 2025 }, journals: ["Journal A"] },
    }),
  );
  create(c.library, "Before", { year: 2024 });
  c.store.close();
  const reopened = new SqliteStore(c.filename);
  create(reopened.library, "After", { year: 2026 });
  assert.equal(
    reopened.library.search(reopened.library.searches()[0].query).total,
    1,
  );
  assert.equal(reopened.library.searches()[0].id, s.id);
  reopened.close();
});
test("CSL extension fields and author particles survive known-field edits", () => {
  const existing = {
    id: "old",
    title: "Before",
    type: "article-journal",
    author: [
      { family: "Beethoven", given: "Ludwig", "non-dropping-particle": "van" },
    ],
    custom: { retained: true },
  };
  const m = metadataFromCsl(existing);
  m.title = "After";
  const csl = metadataToCsl(existing, m, "old");
  assert.deepEqual(csl.custom, { retained: true });
  assert.equal(csl.author[0]["non-dropping-particle"], "van");
  assert.equal(csl.title, "After");
});
test("normalization keeps unknown dates empty and rejects invalid dates without guessing identities", () => {
  assert.equal(normalizeDoi("https://doi.org/10.1234/ABC"), "10.1234/abc");
  assert.equal(normalizeMetadata({ title: "Test" }).year, null);
  assert.throws(
    () => normalizeMetadata({ title: "Test", printDate: "2025-02-29" }),
    { code: "DATE_FORMAT" },
  );
  assert.notEqual(termKey("J. Smith"), termKey("John Smith"));
});
test("DOI links copied from the application normalize without encoded-slash errors", () => {
  assert.equal(
    normalizeDoi("https://doi.org/10.1038%2Fnphys1170"),
    "10.1038/nphys1170",
  );
  assert.equal(
    normalizeDoi("https://dx.doi.org/10.1234/ABC?utm_source=example#section"),
    "10.1234/abc",
  );
});
test("scientific title typography is retained while search accepts plain equivalents and multiple terms", () => {
  const c = setup();
  const item = create(c.library, "Nb₅Si₃ 的密度", {
    authors: [{ literal: "张三" }],
  });
  assert.equal(item.metadata.title, "Nb₅Si₃ 的密度");
  assert.equal(c.library.search({ text: "Nb5Si3 张三" }).total, 1);
  assert.equal(c.library.search({ text: '"Nb5Si3 的密度"' }).total, 1);
  c.store.close();
});
test("v1 migration creates a readable backup and preserves historical annotation payloads", () => {
  const c = setup();
  c.store.close();
  const legacy = path.join(c.dir, "legacy.sqlite");
  const db = new DatabaseSync(legacy);
  db.exec(
    readFileSync(
      new URL("../src/storage/migrations/001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec("PRAGMA user_version=1");
  db.prepare("INSERT INTO library_items VALUES(?,?,?,?,?)").run(
    "item",
    1,
    JSON.stringify({ id: "item", title: "Legacy" }),
    "unverified",
    "2026-01-01",
  );
  db.prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?)").run(
    "file",
    "item",
    "old",
    "old.pdf",
    "files/old.pdf",
    "a".repeat(64),
    2,
    20,
    "2026-01-01",
  );
  db.prepare("INSERT INTO annotation_documents VALUES(?,?,?,?)").run(
    "file",
    "zotero-pdf-v1",
    7,
    "2026-01-01",
  );
  db.prepare("INSERT INTO annotations VALUES(?,?,?,?)").run(
    "annotation",
    "file",
    "ORIGINAL",
    JSON.stringify({ id: "ORIGINAL", comment: "必须保留" }),
  );
  db.close();
  const migrated = new SqliteStore(legacy);
  assert.equal(migrated.migration.from, 1);
  assert.ok(existsSync(migrated.migration.backupPath));
  assert.equal(migrated.snapshot("file").revision, 7);
  assert.equal(migrated.snapshot("file").annotations[0].comment, "必须保留");
  assert.equal(migrated.library.get("item").metadata.title, "Legacy");
  const backup = new DatabaseSync(migrated.migration.backupPath, {
    readOnly: true,
  });
  assert.equal(backup.prepare("PRAGMA user_version").get().user_version, 1);
  backup.close();
  migrated.close();
});
