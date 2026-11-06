import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../src/config.mjs";
const source = path.join(projectRoot, "data/workspace"),
  target = path.join(projectRoot, "data/stage3-qa");
if (existsSync(path.join(target, "library.sqlite")))
  throw new Error("QA library already exists; refusing to overwrite it");
mkdirSync(target, { recursive: true });
const db = new DatabaseSync(path.join(source, "library.sqlite"), {
  readOnly: true,
});
db.prepare("VACUUM INTO ?").run(path.join(target, "library.sqlite"));
for (const row of db.prepare("SELECT managed_path FROM attachments").all()) {
  const to = path.join(target, row.managed_path);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(path.join(source, row.managed_path), to);
}
const tables = [
  "library_items",
  "attachments",
  "annotations",
  "annotation_documents",
  "reading_states",
  "exports",
  "item_metadata",
];
const before = Object.fromEntries(
  tables.map((t) => [t, db.prepare(`SELECT count(*) n FROM ${t}`).get().n]),
);
db.close();
writeFileSync(
  path.join(projectRoot, "output/stage3-source-baseline.json"),
  JSON.stringify({ source, target, before }, null, 2),
);
console.log(JSON.stringify(before));
