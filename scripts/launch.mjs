import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { projectRoot, dataRoot, port } from "../src/config.mjs";

const url = `http://127.0.0.1:${port}`;
async function health() {
  try {
    return await fetch(url + "/api/health", {
      signal: AbortSignal.timeout(1500),
    }).then((r) => r.json());
  } catch {
    return null;
  }
}
async function main() {
  let current = await health();
  if (
    current &&
    ((current.application !== 'paper-workbench' && ![1,2].includes(current.phase)) ||
      path.resolve(current.dataRoot) !== path.resolve(dataRoot))
  )
    throw new Error(
      "端口已被其他程序或资料库使用，请配置 PAPER_WORKBENCH_PORT。",
    );
  if (process.argv.includes("--stop")) {
    if (!current) {
      console.log("文献工作台未运行。");
      return;
    }
    const response = await fetch(url + "/api/shutdown", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Paper-Workbench": "1" },
      body: JSON.stringify({ expectedPid: current.pid }),
    });
    if (!response.ok) throw new Error(await response.text());
    await response.json();
    for (let i = 0; i < 20; i++) {
      if (!(await health())) {
        console.log("文献工作台已停止。");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("停止尚未完成，请查看应用日志。");
  }
  if (!current) {
    const logDir = path.join(projectRoot, "output");
    mkdirSync(logDir, { recursive: true });
    const stdout = openSync(path.join(logDir, "application.log"), "a");
    const stderr = openSync(path.join(logDir, "application-error.log"), "a");
    const child = spawn(
      process.execPath,
      [path.join(projectRoot, "src/server/main.mjs")],
      {
        cwd: projectRoot,
        windowsHide: true,
        detached: true,
        stdio: ["ignore", stdout, stderr],
      },
    );
    child.unref();
    closeSync(stdout);
    closeSync(stderr);
    for (let i = 0; i < 40 && !current; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      current = await health();
    }
    if (!current)
      throw new Error("启动失败，请查看 output/application-error.log。");
  }
  console.log(
    `本地文献文献工作台：${url}\n资料目录：${dataRoot}\n后台进程：${current.pid}`,
  );
  if (!process.argv.includes("--no-open")) {
    if (process.platform === "win32") {
      const browser = spawn(
        "rundll32.exe",
        ["url.dll,FileProtocolHandler", url],
        { windowsHide: true, detached: true, stdio: "ignore" },
      );
      browser.unref();
    } else {
      console.log("请在浏览器中打开上面的本机地址。");
    }
  }
}
await main();
