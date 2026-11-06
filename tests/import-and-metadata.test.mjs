import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  createReadStream,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";
import { ImportService } from "../src/application/import-service.mjs";
import { CrossrefMetadataProvider } from "../src/adapters/metadata/crossref.mjs";
import { projectRoot } from "../src/config.mjs";
import { normalizeMetadata } from "../src/domain/bibliography.mjs";

const parent = path.join(projectRoot, "output/import-tests");
mkdirSync(parent, { recursive: true });
const source = path.join(
  projectRoot,
  "data/validation/originals/sample-10.pdf",
);
function setup(maxBytes) {
  const dataRoot = mkdtempSync(path.join(parent, "run-"));
  const store = new SqliteStore(path.join(dataRoot, "library.sqlite"));
  const importer = new ImportService({
    store,
    dataRoot,
    vendorRoot: path.join(projectRoot, "third_party/zotero-document-worker"),
    maxBytes,
  });
  return { dataRoot, store, importer };
}
test("concurrent identical PDF imports create one managed attachment and preserve source bytes", async () => {
  const c = setup();
  const originalHash = createHash("sha256")
    .update(readFileSync(source))
    .digest("hex");
  const results = await Promise.all([
    c.importer.import(createReadStream(source), "文献.pdf"),
    c.importer.import(createReadStream(source), "same-content.pdf"),
  ]);
  assert.equal(results.filter((x) => x.duplicate).length, 1);
  assert.equal(c.store.library.search({}).total, 1);
  assert.equal(c.store.list().length, 1);
  assert.equal(
    c.store.attachment(results[0].attachmentId).sourceHash,
    originalHash,
  );
  assert.equal(
    createHash("sha256").update(readFileSync(source)).digest("hex"),
    originalHash,
  );
  assert.deepEqual(readdirSync(path.join(c.dataRoot, ".incoming")), []);
  c.store.close();
});
test("attaching a PDF retains existing bibliographic identity and edited fields", async () => {
  const c = setup();
  const item = c.store.library.create({
    requestId: randomUUID(),
    metadata: {
      title: "Manually verified title",
      authors: [{ literal: "张三" }],
      year: 2025,
      journal: "Verified Journal",
      reviewStatus: "reviewed",
    },
  });
  const result = await c.importer.import(
    createReadStream(source),
    "附加 PDF.pdf",
    { itemId: item.id },
  );
  assert.equal(result.item.id, item.id);
  assert.equal(result.item.metadata.title, "Manually verified title");
  assert.equal(result.item.metadata.reviewStatus, "reviewed");
  assert.equal(c.store.library.search({}).total, 1);
  assert.equal(result.item.attachments.length, 1);
  c.store.close();
});
test("invalid, encrypted and oversized files leave no bibliographic rows or temporary files", async () => {
  const c = setup();
  await assert.rejects(
    c.importer.import(Readable.from([Buffer.from("not a pdf")]), "fake.pdf"),
    { code: "PDF_INVALID" },
  );
  await assert.rejects(
    c.importer.import(
      createReadStream(
        path.join(projectRoot, "data/validation/fixtures/fixture-password.pdf"),
      ),
      "locked.pdf",
    ),
    { code: "PASSWORD_REQUIRED" },
  );
  const tiny = new ImportService({
    store: c.store,
    dataRoot: c.dataRoot,
    vendorRoot: "unused",
    maxBytes: 10,
  });
  await assert.rejects(tiny.import(createReadStream(source), "large.pdf"), {
    code: "PDF_TOO_LARGE",
  });
  assert.equal(c.store.library.search({}).total, 0);
  assert.equal(c.store.list().length, 0);
  assert.deepEqual(readdirSync(path.join(c.dataRoot, ".incoming")), []);
  c.store.close();
});
test("Crossref query sends only the normalized DOI and produces unapplied structured candidates", async () => {
  let request;
  const provider = new CrossrefMetadataProvider({
    fetcher: async (url, options) => {
      request = { url, options };
      return new Response(
        JSON.stringify({
          message: {
            DOI: "10.1234/example",
            title: ["Nb₅Si₃ properties"],
            type: "journal-article",
            author: [
              {
                family: "Chen",
                given: "Wei",
                ORCID: "https://orcid.org/0000-0002-1825-0097",
              },
              { name: "Research Group" },
            ],
            "container-title": ["Journal A"],
            "published-print": { "date-parts": [[2024, 3, 2]] },
            volume: "8",
            issue: "2",
            page: "10–18",
          },
        }),
        { status: 200 },
      );
    },
  });
  const result = await provider.lookup("https://doi.org/10.1234/EXAMPLE");
  assert.equal(request.url, "https://api.crossref.org/works/10.1234%2Fexample");
  assert.equal(request.options.body, undefined);
  assert.equal(result.metadata.title, "Nb₅Si₃ properties");
  assert.equal(result.metadata.authors[0].family, "Chen");
  assert.equal(result.metadata.printDate, "2024-03-02");
  assert.equal(normalizeMetadata(result.metadata).reviewStatus, "unverified");
});
test("metadata provider failures and mismatched DOI never return an applicable candidate", async () => {
  const offline = new CrossrefMetadataProvider({
    fetcher: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(offline.lookup("10.1234/example"), {
    code: "METADATA_OFFLINE",
  });
  const wrong = new CrossrefMetadataProvider({
    fetcher: async () =>
      new Response(JSON.stringify({ message: { DOI: "10.9999/wrong" } })),
  });
  await assert.rejects(wrong.lookup("10.1234/example"), {
    code: "DOI_MISMATCH",
  });
});
