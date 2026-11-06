import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";
import { ExportService } from "../src/application/export-service.mjs";
import { projectRoot } from "../src/config.mjs";

const out = path.join(projectRoot, "output/storage-tests");
mkdirSync(out, { recursive: true });
function setup() {
  const dir = mkdtempSync(path.join(out, "run-"));
  const file = path.join(dir, "library.sqlite");
  const store = new SqliteStore(file);
  const hash = "a".repeat(64);
  const id = store.addAttachment(
    {
      id: "test",
      originalName: "副本.pdf",
      pdfTitle: "Test",
      sha256: hash,
      pages: 3,
      bytes: 50,
    },
    "files/test.pdf",
  );
  return { store, dir, file, id, hash };
}
function annotation(id = "ANNOT001") {
  return {
    id,
    type: "highlight",
    color: "#ffd400",
    sortIndex: "00000|000001|00010",
    text: "Test quotation",
    comment: "中文批注 / α β",
    tags: [],
    position: { pageIndex: 0, rects: [[10, 20, 120, 36]] },
    dateCreated: "2026-10-30T00:00:00Z",
    dateModified: "2026-10-30T00:00:00Z",
  };
}
function mutation(
  ctx,
  upserts = [annotation()],
  deletions = [],
  expectedRevision = 0,
) {
  return {
    requestId: randomUUID(),
    expectedRevision,
    sourceHash: ctx.hash,
    upserts,
    deletions,
  };
}

test("saved annotation survives closing and reopening the database", () => {
  const c = setup();
  const a = annotation();
  c.store.apply(c.id, mutation(c, [a]));
  c.store.close();
  const reopened = new SqliteStore(c.file);
  assert.deepEqual(reopened.snapshot(c.id).annotations, [a]);
  assert.equal(reopened.snapshot(c.id).revision, 1);
  reopened.close();
});

test("native one-point ink strokes persist and survive reopening", () => {
  const c = setup();
  const ink = {
    ...annotation("INKDOT01"),
    type: "ink",
    text: "",
    position: {
      pageIndex: 0,
      width: 2,
      paths: [
        [25.5, 40.25],
        [80, 90, 100, 110],
      ],
    },
  };
  c.store.apply(c.id, mutation(c, [ink]));
  c.store.close();
  const reopened = new SqliteStore(c.file);
  assert.deepEqual(reopened.snapshot(c.id).annotations, [ink]);
  reopened.close();
});

test("accepting ink dots still rejects incomplete and non-finite coordinates atomically", () => {
  const c = setup();
  c.store.apply(c.id, mutation(c));
  for (const stroke of [[], [1], [1, 2, 3], [1, Infinity], [NaN, 2]]) {
    const ink = {
      ...annotation("BADINK01"),
      type: "ink",
      text: "",
      position: { pageIndex: 0, width: 2, paths: [stroke] },
    };
    assert.throws(
      () => c.store.apply(c.id, mutation(c, [ink], ["ANNOT001"], 1)),
      { code: "ANNOTATION_POSITION" },
    );
    assert.equal(c.store.snapshot(c.id).revision, 1);
    assert.equal(c.store.snapshot(c.id).annotations[0].id, "ANNOT001");
  }
  c.store.close();
});
test("a failed batch rolls back updates and deletions together", () => {
  const c = setup();
  c.store.apply(c.id, mutation(c));
  assert.throws(
    () =>
      c.store.apply(
        c.id,
        mutation(
          c,
          [
            {
              ...annotation("BAD001"),
              position: { pageIndex: 99, rects: [[1, 2, 3, 4]] },
            },
          ],
          ["ANNOT001"],
          1,
        ),
      ),
    { code: "ANNOTATION_PAGE" },
  );
  assert.equal(c.store.snapshot(c.id).annotations.length, 1);
  assert.equal(c.store.snapshot(c.id).revision, 1);
  c.store.close();
});
test("retrying an acknowledged request is idempotent; conflicting reuse is rejected", () => {
  const c = setup();
  const m = mutation(c);
  c.store.apply(c.id, m);
  assert.equal(c.store.apply(c.id, m).replayed, true);
  assert.equal(c.store.snapshot(c.id).revision, 1);
  assert.throws(
    () =>
      c.store.apply(c.id, {
        ...m,
        upserts: [{ ...annotation(), comment: "changed" }],
      }),
    { code: "REQUEST_REUSED" },
  );
  c.store.close();
});
test("stale windows and wrong PDF versions cannot silently overwrite data", () => {
  const c = setup();
  c.store.apply(c.id, mutation(c));
  assert.throws(
    () =>
      c.store.apply(c.id, mutation(c, [{ ...annotation(), comment: "stale" }])),
    { code: "REVISION_CONFLICT" },
  );
  assert.throws(
    () =>
      c.store.apply(c.id, {
        ...mutation(c, [], [], 1),
        sourceHash: "b".repeat(64),
      }),
    { code: "SOURCE_CHANGED" },
  );
  assert.equal(c.store.snapshot(c.id).annotations[0].comment, "中文批注 / α β");
  c.store.close();
});
test("annotation IDs remain isolated between attachments and bibliographic IDs are independent", () => {
  const c = setup();
  const id2 = c.store.addAttachment(
    {
      id: "test2",
      originalName: "copy2.pdf",
      sha256: "b".repeat(64),
      pages: 1,
      bytes: 50,
    },
    "files/2.pdf",
  );
  c.store.apply(c.id, mutation(c));
  c.store.apply(id2, {
    ...mutation(c, [{ ...annotation(), comment: "second" }]),
    sourceHash: "b".repeat(64),
  });
  assert.notEqual(
    c.store.attachment(c.id).itemId,
    c.store.attachment(id2).itemId,
  );
  assert.equal(c.store.snapshot(c.id).annotations[0].comment, "中文批注 / α β");
  assert.equal(c.store.snapshot(id2).annotations[0].comment, "second");
  c.store.close();
});
test("update/delete and reading position survive restart", () => {
  const c = setup();
  c.store.apply(c.id, mutation(c, [annotation(), annotation("DELETE01")]));
  c.store.apply(
    c.id,
    mutation(
      c,
      [{ ...annotation(), comment: "updated 中文" }],
      ["DELETE01"],
      1,
    ),
  );
  c.store.saveReadingState(c.id, "primary", {
    pageIndex: 2,
    scale: "page-width",
    top: 120,
  });
  c.store.close();
  const s = new SqliteStore(c.file);
  assert.equal(s.snapshot(c.id).annotations.length, 1);
  assert.equal(s.snapshot(c.id).annotations[0].comment, "updated 中文");
  assert.equal(s.readingState(c.id).primary.pageIndex, 2);
  s.close();
});
test("abrupt process exit rolls back an uncommitted SQLite transaction", () => {
  const c = setup();
  c.store.apply(c.id, mutation(c));
  c.store.close();
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');db.prepare('DELETE FROM annotations').run();process.exit(17);`,
    c.file,
  ]);
  assert.equal(child.status, 17);
  const s = new SqliteStore(c.file);
  assert.equal(s.snapshot(c.id).annotations.length, 1);
  assert.equal(
    s.db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  s.close();
});
test("changed managed PDF is rejected before export", async () => {
  const c = setup();
  mkdirSync(path.join(c.dir, "files"));
  writeFileSync(path.join(c.dir, "files/test.pdf"), "changed");
  const e = new ExportService({
    store: c.store,
    dataRoot: c.dir,
    vendorRoot: "unused",
  });
  await assert.rejects(e.export(c.id, 0), { code: "SOURCE_CHANGED" });
  c.store.close();
});
