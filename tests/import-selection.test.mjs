import test from "node:test";
import assert from "node:assert/strict";
import { selectPdfImports } from "../src/domain/import-selection.mjs";
test("directory import excludes this application generated files but honors explicit file choices", () => {
  const file = (name, webkitRelativePath = "") => ({
    name,
    webkitRelativePath,
  });
  const result = selectPdfImports(
    [
      file("paper.pdf", "papers/research/paper.pdf"),
      file(
        "export.pdf",
        "papers/paper-workbench/data/workspace/exports/export.pdf",
      ),
      file("demo.pdf", "papers/paper-workbench/third_party/demo.pdf"),
      file("measurements.pdf", "papers/research/data/measurements.pdf"),
      file("export.pdf"),
      file("note.txt", "papers/note.txt"),
    ],
    {
      projectFolder: "paper-workbench",
      generatedFolders: ["data", "output", "third_party", ".cache"],
    },
  );
  assert.equal(result.selected.length, 3);
  assert.equal(result.ignored.length, 2);
  assert.equal(result.nonPdf, 1);
  assert.ok(result.selected.some((x) => x.webkitRelativePath === ""));
});
