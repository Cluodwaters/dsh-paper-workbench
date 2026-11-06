import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
import { projectRoot } from "../src/config.mjs";

const installed = process.env.PAPER_WORKBENCH_INSTALL_DIR;
assert.ok(installed && path.isAbsolute(installed));
const dataRoot = path.join(projectRoot, "data/workspace");
const session = JSON.parse(
  readFileSync(path.join(dataRoot, "server-session.json")),
);
const origin = `http://127.0.0.1:${session.port}`;
const health = async () => {
  try {
    return await fetch(origin + "/api/health", {
      signal: AbortSignal.timeout(1000),
    }).then((r) => r.json());
  } catch {
    return null;
  }
};
const before = await health();
assert.equal(path.resolve(before.dataRoot), path.resolve(dataRoot));
assert.ok(before.desktopParentPid);
const backup = path.join(
  projectRoot,
  "output/save-fix-recovery",
  String(Date.now()),
);
mkdirSync(backup, { recursive: true });
const document = await fetch(
  origin + "/api/documents/92851ec4-c327-4cd5-b27d-a6d2484ad8cc",
).then((r) => r.json());
writeFileSync(
  path.join(backup, "document-before.json"),
  JSON.stringify(document, null, 2),
);
const backend = path.join(installed, "resources/backend");
const relative = "src/domain/annotation-validation.mjs";
copyFileSync(
  path.join(backend, relative),
  path.join(backup, "annotation-validation-before.mjs"),
);
copyFileSync(path.join(projectRoot, relative), path.join(backend, relative));
const stopped = await fetch(origin + "/api/shutdown", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Paper-Workbench": "1" },
  body: JSON.stringify({ expectedPid: before.pid }),
});
assert.ok(stopped.ok);
for (let i = 0; i < 100 && (await health()); i++)
  await new Promise((r) => setTimeout(r, 100));
assert.equal(await health(), null, "Old backend must finish before restarting");
const log = openSync(path.join(dataRoot, "desktop-server.log"), "a");
const child = spawn(
  path.join(installed, "resources/runtime/node.exe"),
  [path.join(backend, "src/server/main.mjs")],
  {
    cwd: backend,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      PAPER_WORKBENCH_DATA: dataRoot,
      PAPER_WORKBENCH_PORT: String(session.port),
      PAPER_WORKBENCH_PARENT_PID: String(before.desktopParentPid),
      PAPER_WORKBENCH_AUTO_INDEX: "0",
    },
  },
);
closeSync(log);
child.unref();
let after;
for (let i = 0; i < 100; i++) {
  after = await health();
  if (after) break;
  await new Promise((r) => setTimeout(r, 100));
}
assert.equal(after?.desktopParentPid, before.desktopParentPid);
const result = {
  backup,
  origin,
  oldBackendPid: before.pid,
  newBackendPid: after.pid,
  desktopParentPid: after.desktopParentPid,
  readerWindowKeptOpen: true,
};
writeFileSync(
  path.join(backup, "service-restart.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
