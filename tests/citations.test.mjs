import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  CslFormatter,
  STYLES,
  formattedRuns,
} from "../src/adapters/citation/csl-formatter.mjs";
import {
  encodeField,
  decodeField,
  portableCsl,
} from "../src/domain/citation-document.mjs";
import { projectRoot } from "../src/config.mjs";
const a = {
  id: "a",
  type: "article-journal",
  title: "An alpha experiment",
  author: [{ family: "Smith", given: "Alice" }],
  issued: { "date-parts": [[2024]] },
  "container-title": "Example Journal",
  volume: "12",
  page: "1-9",
};
const b = {
  id: "b",
  type: "article-journal",
  title: "中文文献",
  author: [{ literal: "张三" }],
  issued: { "date-parts": [[2023]] },
  "container-title": "示例学报",
  volume: "5",
  page: "10-20",
};
const c = (id, items) => ({
  id,
  items: items.map((csl) => ({ id: csl.id, csl })),
});
const text = (runs) => runs.map((r) => r.text).join("");
test("CSL numbering follows first occurrence, reuses numbers, removes deleted sources and preserves Unicode", () => {
  const f = new CslFormatter(path.join(projectRoot, "resources/csl"));
  const first = f.format("gb-t-7714-2015", [
    c("c1", [a]),
    c("c2", [b]),
    c("c3", [a, b]),
  ]);
  assert.equal(text(first.citations.get("c1")), "[1]");
  assert.equal(text(first.citations.get("c2")), "[2]");
  assert.equal(first.bibliographyCount, 2);
  assert.match(text(first.bibliography), /中文文献/);
  assert.ok(first.citations.get("c1")[0].superscript);
  const next = f.format("gb-t-7714-2015", [c("c2", [b])]);
  assert.equal(text(next.citations.get("c2")), "[1]");
  assert.equal(next.bibliographyCount, 1);
  assert.doesNotMatch(text(next.bibliography), /alpha experiment/);
});
test("every bundled style formats repeat citations; APA keeps italics as explicit runs", () => {
  const f = new CslFormatter(path.join(projectRoot, "resources/csl"));
  for (const style of STYLES) {
    const result = f.format(style.id, [c("one", [a, b]), c("two", [a])]);
    assert.equal(result.bibliographyCount, 2);
    assert.ok(result.citations.get("two").length);
  }
  const apa = f.format("apa", [c("one", [a])]);
  assert.match(text(apa.citations.get("one")), /Smith, 2024/);
  assert.ok(apa.bibliography.some((r) => r.italic));
});
test("portable fields round-trip stable IDs and omit reading notes, PDF text and abstract", () => {
  const portable = portableCsl({
    ...a,
    note: "private note",
    abstract: "full abstract",
    pdfText: "private PDF",
  });
  assert.equal(portable.note, undefined);
  assert.equal(portable.abstract, undefined);
  const value = {
    version: 1,
    id: "citation-1",
    style: "apa",
    items: [{ id: "a", csl: portable }],
  };
  assert.deepEqual(decodeField(encodeField("citation", value)), {
    kind: "citation",
    value,
  });
  assert.equal(decodeField("ADDIN ZOTERO_ITEM CSL_CITATION {}"), null);
  assert.throws(() => decodeField("ADDIN PW_CITE_V1 broken!"), /标记/);
});
test("CSL formatting becomes safe text and formatting runs without executing HTML", () => {
  const runs = formattedRuns("<div><i>A &amp; B</i><sup>2</sup></div>");
  assert.equal(text(runs), "A & B2");
  assert.equal(runs[0].italic, true);
  assert.equal(runs[1].superscript, true);
});
