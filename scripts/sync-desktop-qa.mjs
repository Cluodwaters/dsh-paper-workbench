import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { projectRoot } from "../src/config.mjs";
const target = process.argv[2];
if (!target || !path.isAbsolute(target) || !target.includes("native-qa"))
  throw new Error("Pass an absolute native-qa directory");
const copy = spawnSync(
  "robocopy.exe",
  [
    path.join(projectRoot, "output/desktop-dist/win-unpacked"),
    target,
    "/E",
    "/COPY:DAT",
    "/DCOPY:DAT",
    "/R:1",
    "/W:1",
    "/NFL",
    "/NDL",
    "/NJH",
    "/NJS",
  ],
  { encoding: "utf8", windowsHide: true },
);
if (copy.status >= 8) throw new Error(copy.stdout + copy.stderr);
for (const required of [
  "resources/backend/node_modules/citeproc/package.json",
  "resources/backend/node_modules/tesseract.js/package.json",
  "resources/backend/node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node",
  "resources/backend/resources/bin/PaperWorkbench.OfficeBridge.exe",
  "resources/runtime/node.exe",
])
  if (!existsSync(path.join(target, required)))
    throw new Error("Missing packaged runtime resource " + required);
console.log("Verified and synchronized packaged runtime: " + target);
