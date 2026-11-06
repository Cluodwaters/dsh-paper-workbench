import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../src/config.mjs";
const compiler = path.join(
  process.env.WINDIR || "C:/Windows",
  "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
);
if (!existsSync(compiler))
  throw new Error(".NET Framework C# compiler not found");
const output = path.join(
  projectRoot,
  "resources/bin/PaperWorkbench.OfficeBridge.exe",
);
mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync(
  compiler,
  [
    "/nologo",
    "/target:exe",
    "/platform:anycpu",
    "/optimize+",
    "/r:Microsoft.CSharp.dll",
    "/r:System.Web.Extensions.dll",
    "/r:System.Core.dll",
    "/out:" + output,
    path.join(projectRoot, "desktop/office-bridge/Program.cs"),
    path.join(projectRoot, "desktop/office-bridge/OfficeSession.cs"),
  ],
  { encoding: "utf8", windowsHide: true },
);
if (result.status !== 0) throw new Error(result.stdout + "\n" + result.stderr);
console.log("Built " + output);
