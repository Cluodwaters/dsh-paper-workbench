import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { projectRoot } from "../src/config.mjs";
const install = JSON.parse(
    readFileSync(
      path.join(projectRoot, "output/stage3-installer.json"),
      "utf8",
    ),
  ),
  target = path.resolve(install.target);
if (!target.includes(path.sep + "native-qa" + path.sep))
  throw new Error(
    "Uninstall test must target the dedicated native-qa directory",
  );
const db = path.join(projectRoot, "data/stage3-qa/library.sqlite"),
  hash = () => createHash("sha256").update(readFileSync(db)).digest("hex");
const binaryName = install.binaryName || "文献工作台.exe";
const before = hash(),
  uninstaller = path.join(target, "Uninstall " + binaryName);
const code = await new Promise((resolve, reject) => {
  const child = spawn(uninstaller, ["/S"], {
    windowsHide: true,
    stdio: "ignore",
  });
  child.on("error", reject);
  child.on("exit", resolve);
});
const deadline = Date.now() + 60000;
while (existsSync(path.join(target, binaryName)) && Date.now() < deadline)
  await new Promise((r) => setTimeout(r, 200));
assert.equal(code, 0);
assert.equal(existsSync(path.join(target, binaryName)), false);
assert.equal(hash(), before);
assert.ok(existsSync(path.join(projectRoot, "data/stage3-qa/files")));
const result = {
  passed: true,
  installExitCode: install.exitCode,
  uninstallExitCode: code,
  installedExeRemoved: true,
  externalLibraryRetained: true,
  databaseHashUnchanged: true,
  testInstallDirectory: target,
};
writeFileSync(
  path.join(projectRoot, "output/stage3-installation-cycle.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
