import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { projectRoot } from "../src/config.mjs";
const { version } = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const name = `PaperWorkbench-${version}-win-x64-Setup.exe`,
  file = path.join(projectRoot, "output/desktop-dist", name),
  sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
const result = {
  version,
  file,
  bytes: statSync(file).size,
  sha256,
  createdAt: new Date().toISOString(),
};
writeFileSync(
  path.join(projectRoot, "output/desktop-dist/SHA256SUMS.txt"),
  sha256 + "  " + name + "\n",
);
writeFileSync(
  path.join(projectRoot, `output/release-${version}.json`),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
