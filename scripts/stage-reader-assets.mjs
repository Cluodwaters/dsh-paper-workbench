import { readdirSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../src/config.mjs";
const readerRoot = path.join(projectRoot, "third_party/zotero-reader");
const target = path.join(readerRoot, "build/web/pdf");
mkdirSync(target, { recursive: true });
function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name),
      to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error("Unexpected non-file build artifact: " + from);
  }
}
copyTree(path.join(readerRoot, "pdfjs/pdf.js/build/generic"), target);
copyFileSync(
  path.join(readerRoot, "pdfjs/viewer.css"),
  path.join(target, "web/viewer.css"),
);
console.log(
  "Staged modern Chromium PDF.js build and upstream Zotero viewer styles",
);
