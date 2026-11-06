import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectRoot } from "../src/config.mjs";
const stage = path.join(projectRoot, "output/desktop-stage");
const pins = JSON.parse(
  readFileSync(path.join(projectRoot, "sources.lock.json"), "utf8"),
);
if (process.versions.node !== pins.runtime.node)
  throw new Error(
    "Packaging requires the verified Node runtime " + pins.runtime.node,
  );
for (const script of ["build-office-bridge.mjs", "make-app-icon.mjs"]) {
  const build = spawnSync(
    process.execPath,
    [path.join(projectRoot, "scripts", script)],
    { cwd: projectRoot, stdio: "inherit", windowsHide: true },
  );
  if (build.status) throw new Error("Build step failed: " + script);
}
// Delete only our validated generated staging directory, never library data.
if (path.resolve(stage) !== path.resolve(projectRoot, "output/desktop-stage"))
  throw new Error("Unsafe staging path");
if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
const backend = path.join(stage, "backend"),
  runtime = path.join(stage, "runtime");
mkdirSync(backend, { recursive: true });
mkdirSync(runtime, { recursive: true });
function copy(relative, dest = relative) {
  cpSync(path.join(projectRoot, relative), path.join(backend, dest), {
    recursive: true,
    filter: (src) =>
      !src.endsWith(".map") &&
      !src.includes(path.sep + ".git" + path.sep) &&
      !src.includes(path.join("node_modules", "preview")),
  });
}
for (const file of [
  "src",
  "resources",
  "package.json",
  "package-lock.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "sources.lock.json",
  "phase3-assets.lock.json",
  "README.md",
  "ARCHITECTURE.md",
  "PHASE3.md",
])
  copy(file);
copy("third_party/zotero-reader/build/web");
for (const license of [
  "third_party/zotero-reader/COPYING",
  "third_party/zotero-document-worker/COPYING",
  "third_party/zotero-reader/pdfjs/pdf.js/LICENSE",
  "third_party/zotero-document-worker/pdf.js/LICENSE",
  "third_party/zotero-reader/epubjs/epub.js/license",
])
  copy(license);
for (const relative of [
  "src",
  "scripts/pdfjs-setup.js",
  "scripts/pdfjs-resolve.js",
  "pdf.js/src",
  "pdf.js/external",
  "package.json",
  "node_modules",
]) {
  const full = "third_party/zotero-document-worker/" + relative;
  if (existsSync(path.join(projectRoot, full))) copy(full);
}
// npm's dependency graph is authoritative; dev tooling is never shipped.
const npmCli = path.join(
  path.dirname(process.execPath),
  "node_modules/npm/bin/npm-cli.js",
);
const listed = spawnSync(
  process.execPath,
  [npmCli, "ls", "--omit=dev", "--all", "--parseable"],
  { cwd: projectRoot, encoding: "utf8", windowsHide: true },
);
if (listed.status !== 0) throw new Error(listed.stderr + listed.stdout);
const packages = listed.stdout
  .trim()
  .split(/\r?\n/)
  .filter(
    (p) =>
      p !== projectRoot &&
      p.startsWith(path.join(projectRoot, "node_modules") + path.sep),
  );
for (const pkg of packages) {
  const relative = path.relative(projectRoot, pkg);
  copy(relative);
}
cpSync(process.execPath, path.join(runtime, "node.exe"));
const license = path.join(projectRoot, "resources/licenses/node.txt");
if (!existsSync(license)) throw new Error("Node runtime license missing");
cpSync(license, path.join(runtime, "LICENSE.txt"));
writeFileSync(
  path.join(stage, "build-manifest.json"),
  JSON.stringify(
    {
      version: JSON.parse(
        readFileSync(path.join(projectRoot, "package.json"), "utf8"),
      ).version,
      node: process.version,
      productionPackages: packages.map((p) => path.relative(projectRoot, p)),
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(
  "Staged offline desktop runtime. No personal PDF, database, export or profile included.",
);
