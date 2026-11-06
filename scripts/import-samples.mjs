import { readFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";
import { projectRoot, dataRoot, databasePath } from "../src/config.mjs";

const manifest = JSON.parse(
  readFileSync(path.join(projectRoot, "data/validation/samples.json"), "utf8"),
);
const fixturesFile = path.join(projectRoot, "data/validation/fixtures.json");
if (existsSync(fixturesFile))
  manifest.samples.push(
    ...JSON.parse(readFileSync(fixturesFile, "utf8")).samples,
  );
const store = new SqliteStore(databasePath);
mkdirSync(path.join(dataRoot, "files"), { recursive: true });
for (const sample of manifest.samples) {
  const relative = path.join("files", sample.sha256 + ".pdf");
  const target = path.join(dataRoot, relative);
  if (!existsSync(target)) copyFileSync(sample.copyPath, target);
  const actual = createHash("sha256")
    .update(readFileSync(target))
    .digest("hex");
  if (actual !== sample.sha256)
    throw new Error("Managed copy hash mismatch: " + sample.id);
  store.addAttachment(sample, relative);
}
console.log(
  JSON.stringify({
    imported: manifest.samples.length,
    database: databasePath,
    documents: store.list().length,
  }),
);
store.close();
