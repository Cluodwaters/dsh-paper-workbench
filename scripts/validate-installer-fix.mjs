import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { projectRoot } from "../src/config.mjs";
import builder from "../desktop/builder.cjs";

const { version } = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json")),
);
const installer =
  process.env.PAPER_WORKBENCH_INSTALLER ||
  path.join(
    projectRoot,
    "output/desktop-dist",
    `PaperWorkbench-${version}-win-x64-Setup.exe`,
  );
const target = process.env.PAPER_WORKBENCH_INSTALL_DIR;
assert.ok(
  target && path.isAbsolute(target),
  "Set an explicitly authorized installation directory",
);
if (process.argv.includes("--upgrade-existing")) {
  const installedMetadata = JSON.parse(
    readFileSync(path.join(target, "resources/backend/package.json"), "utf8"),
  );
  assert.equal(
    installedMetadata.name,
    "personal-paper-workbench",
    "Upgrade only an existing installation of this app",
  );
} else
  assert.equal(
    existsSync(path.join(target, builder.executableName + ".exe")),
    false,
    "Do not overwrite an existing installation in this check",
  );
const fixtures = path.join(
  projectRoot,
  "output/installer-fix-qa",
  String(Date.now()),
);
mkdirSync(fixtures, { recursive: true });
const report = {
  version,
  installer,
  target,
  checks: [],
  createdAt: new Date().toISOString(),
};
const record = (name) => {
  report.checks.push(name);
  console.log("PASS", name);
};
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const primaryDb = path.join(projectRoot, "data/workspace/library.sqlite");
const before = hash(primaryDb);

function run(destination) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      installer,
      ["/S", "/currentuser", "/D=" + destination],
      {
        windowsHide: true,
        stdio: "ignore",
      },
    );
    console.log("Installer PID", child.pid, "target", destination);
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          "Installer exceeded 120 seconds; inspect its dialog before retrying",
        ),
      );
    }, 120000);
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

const blocked = path.join(fixtures, "not-a-directory");
writeFileSync(blocked, "untouched sentinel");
assert.equal(await run(path.join(blocked, "app")), 2);
assert.equal(readFileSync(blocked, "utf8"), "untouched sentinel");
record(
  "invalid destination is rejected before extraction with failure exit code",
);

const library = path.join(fixtures, "protected-library");
mkdirSync(library);
writeFileSync(
  path.join(library, "library.sqlite"),
  "untouched library sentinel",
);
assert.equal(await run(library), 2);
assert.deepEqual(readdirSync(library), ["library.sqlite"]);
assert.equal(
  readFileSync(path.join(library, "library.sqlite"), "utf8"),
  "untouched library sentinel",
);
record("a library directory is rejected without changing its files");

report.installExitCode = await run(target);
assert.equal(report.installExitCode, 0);
const unpacked = path.join(projectRoot, "output/desktop-dist/win-unpacked");
let compared = 0;
function compare(relative = "") {
  for (const entry of readdirSync(path.join(unpacked, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) compare(child);
    else {
      assert.equal(
        hash(path.join(target, child)),
        hash(path.join(unpacked, child)),
        "Installed content mismatch: " + child,
      );
      compared++;
    }
  }
}
compare();
report.comparedFiles = compared;
record(
  "custom directory installation succeeds and every packaged file matches its source hash",
);
assert.ok(
  existsSync(path.join(target, "Uninstall " + builder.executableName + ".exe")),
);
record("native uninstaller is present");
assert.equal(hash(primaryDb), before);
record("primary literature database is unchanged by installation");
writeFileSync(
  path.join(projectRoot, `output/installer-${version}-results.json`),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
