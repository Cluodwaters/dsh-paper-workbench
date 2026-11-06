import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateFields,
  applyMetadataCandidate,
} from "../src/domain/metadata-candidates.mjs";
test("an existing publication date is not treated as a missing year", () => {
  const current = {
    title: "手动题名",
    authors: [{ literal: "张三" }],
    year: null,
    printDate: "2024-03",
    onlineDate: "",
    extra: { keep: true },
  };
  const candidate = {
    provider: "Crossref",
    doi: "10.1234/test",
    fetchedAt: "2026-10-30",
    metadata: {
      title: "Candidate",
      authors: [{ literal: "Other" }],
      year: null,
      printDate: "2025-02",
      onlineDate: "2024-12",
      journal: "New journal",
    },
  };
  const rows = candidateFields(current, candidate.metadata);
  assert.equal(rows.find((x) => x.key === "year").defaultChecked, false);
  assert.equal(rows.find((x) => x.key === "title").defaultChecked, false);
  assert.equal(rows.find((x) => x.key === "journal").defaultChecked, true);
  const applied = applyMetadataCandidate(current, candidate, ["journal"]);
  assert.equal(applied.title, "手动题名");
  assert.equal(applied.printDate, "2024-03");
  assert.equal(applied.authors[0].literal, "张三");
  assert.equal(applied.extra.keep, true);
  assert.equal(applied.journal, "New journal");
  assert.equal(applied.reviewStatus, "unverified");
});
test("empty provider fields are not offered as replacements and unknown fields are rejected", () => {
  const candidate = {
    metadata: { title: "New", year: null, printDate: "", onlineDate: "" },
  };
  assert.equal(
    candidateFields({ title: "Old" }, candidate.metadata).some(
      (x) => x.key === "year",
    ),
    false,
  );
  assert.throws(
    () => applyMetadataCandidate({ title: "Old" }, candidate, ["madeUp"]),
    { code: "CANDIDATE_FIELDS" },
  );
});
