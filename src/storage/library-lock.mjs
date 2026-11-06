import {
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export function lockLibrary(dataRoot) {
  mkdirSync(dataRoot, { recursive: true });
  const file = path.join(dataRoot, ".server.lock"),
    token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(file, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      closeSync(fd);
      return () => {
        try {
          if (JSON.parse(readFileSync(file, "utf8")).token === token)
            unlinkSync(file);
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let previous;
      try {
        previous = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        throw new Error(
          "资料库进程锁无法读取，请确认其他窗口已退出后检查 .server.lock。",
        );
      }
      let alive = true;
      try {
        process.kill(previous.pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") alive = false;
      }
      if (alive)
        throw new Error(
          "资料库已由另一个本地服务打开，请连接该服务或先关闭它。",
        );
      unlinkSync(file);
    }
  }
  throw new Error("无法取得资料库进程锁。");
}
