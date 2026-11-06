import {
  readdirSync,
  lstatSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { projectRoot } from "../src/config.mjs";
import builder from "../desktop/builder.cjs";
const binaryName = (builder.executableName || builder.productName) + ".exe";
const root = path.resolve(
  process.argv[2] || path.join(projectRoot, "output/desktop-dist/win-unpacked"),
);
const required = [
  binaryName,
  "resources/app.asar",
  "resources/runtime/node.exe",
  "resources/runtime/LICENSE.txt",
  "resources/backend/src/server/main.mjs",
  "resources/backend/node_modules/citeproc/package.json",
  "resources/backend/node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm",
  "resources/backend/node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node",
  "resources/backend/resources/ocr/eng.traineddata",
  "resources/backend/resources/ocr/chi_sim.traineddata",
  "resources/backend/resources/csl/gb-t-7714-2015.csl",
  "resources/backend/resources/bin/PaperWorkbench.OfficeBridge.exe",
  "resources/backend/third_party/zotero-reader/build/web/reader.html",
  "resources/backend/third_party/zotero-reader/COPYING",
  "resources/backend/third_party/zotero-document-worker/COPYING",
];
for (const file of required)
  if (!existsSync(path.join(root, file)))
    throw new Error("Missing runtime file " + file);
const files = [],
  links = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name),
      stat = lstatSync(full),
      relative = path.relative(root, full).replaceAll("\\", "/");
    if (stat.isSymbolicLink()) {
      links.push(relative);
      continue;
    }
    if (stat.isDirectory()) walk(full);
    else files.push({ path: relative, bytes: stat.size });
  }
}
walk(root);
if (links.length)
  throw new Error(
    "Runtime must not depend on filesystem links: " + links.join(","),
  );
const privateFiles = files.filter(
  (f) =>
    /\.(sqlite|sqlite-wal|sqlite-shm)$/.test(f.path) ||
    /^resources\/backend\/(data|output|\.cache)\//.test(f.path) ||
    /sample-\d+\.pdf$/.test(f.path),
);
if (privateFiles.length) throw new Error("Unexpected private data in runtime");
const result = {
  passed: true,
  requiredFiles: required.length,
  fileCount: files.length,
  bytes: files.reduce((n, f) => n + f.bytes, 0),
  asarBytes: files.find((f) => f.path === "resources/app.asar").bytes,
  privateFiles: 0,
  filesystemLinks: 0,
  exeSha256: createHash("sha256")
    .update(readFileSync(path.join(root, binaryName)))
    .digest("hex"),
};
writeFileSync(
  path.join(projectRoot, "output/stage3-package-audit.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
