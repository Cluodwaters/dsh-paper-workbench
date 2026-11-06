import { spawn } from "node:child_process";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../src/config.mjs";
import builder from "../desktop/builder.cjs";
const { version } = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const binaryName = (builder.executableName || builder.productName) + ".exe";
const target =
    process.env.PAPER_WORKBENCH_INSTALL_DIR ||
    path.join(projectRoot, "output/installed-qa"),
  installer =
    process.env.PAPER_WORKBENCH_INSTALLER ||
    path.join(
      projectRoot,
      `output/desktop-dist/PaperWorkbench-${version}-win-x64-Setup.exe`,
    );
if (
  !path.isAbsolute(target) ||
  (!target.startsWith(path.join(projectRoot, "output") + path.sep) &&
    !target.includes(path.sep + "native-qa" + path.sep))
)
  throw new Error("Invalid QA install directory");
const child = spawn(installer, ["/S", "/D=" + target], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
console.log("Installer PID", child.pid);
child.stdout.on("data", (c) => process.stdout.write(c));
child.stderr.on("data", (c) => process.stderr.write(c));
child.on("error", (e) => {
  throw e;
});
child.on("exit", (code) => {
  const result = {
    exitCode: code,
    target,
    binaryName,
    exeExists: existsSync(path.join(target, binaryName)),
  };
  writeFileSync(
    path.join(projectRoot, "output/stage3-installer.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  if (code || !result.exeExists) process.exitCode = 1;
});
