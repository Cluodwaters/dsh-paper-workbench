import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { AppError, requireValue } from "../../domain/errors.mjs";

export class OfficeConnector {
  constructor(projectRoot) {
    this.executable =
      process.env.PAPER_WORKBENCH_OFFICE_BRIDGE ||
      path.join(projectRoot, "resources/bin/PaperWorkbench.OfficeBridge.exe");
  }
  call(action, input = {}) {
    requireValue(
      process.platform === "win32",
      "OFFICE_PLATFORM",
      "桌面引用连接器目前支持 Windows。",
    );
    requireValue(
      existsSync(this.executable),
      "OFFICE_BRIDGE",
      "引用连接器未构建，请运行 npm run build:bridge。",
      503,
    );
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "",
        error = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new AppError(
            "OFFICE_TIMEOUT",
            "Word/WPS 暂未响应。请关闭软件中的对话框，再重新预览；如操作已发生，请先查看文档。",
            504,
          ),
        );
      }, 60000);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
        if (output.length > 12000000) child.kill();
      });
      child.stderr.on("data", (chunk) => {
        error = (error + chunk).slice(-2000);
      });
      child.on("close", () => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(output.replace(/^\uFEFF/, ""));
          if (!result.ok)
            throw new AppError(result.code || "OFFICE", result.error, 409);
          resolve(result.value);
        } catch (e) {
          reject(
            e instanceof SyntaxError
              ? new Error("引用连接器响应异常。" + error)
              : e,
          );
        }
      });
      child.stdin.end(JSON.stringify({ action, ...input }), "utf8");
    });
  }
}
