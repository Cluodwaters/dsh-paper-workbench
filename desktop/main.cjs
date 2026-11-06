const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { installCloseGuard } = require("./close-guard.cjs");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
if (arg("--profile")) app.setPath("userData", path.resolve(arg("--profile")));
let backend,
  baseUrl,
  libraryPath,
  quitting = false,
  backendOwned = false;
const windows = new Set();
async function health(port) {
  try {
    return await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    }).then((r) => r.json());
  } catch {
    return null;
  }
}
async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
async function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () =>
      reject(
        new Error(
          `此资料库上次使用的本地端口 ${port} 已被占用。请关闭占用程序后重试，本机草稿已保留。`,
        ),
      ),
    );
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function runtimeRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "backend")
    : path.resolve(__dirname, "..");
}
async function launchBackend() {
  const root = runtimeRoot();
  const configPath = path.join(app.getPath("userData"), "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {}
  libraryPath = arg("--library") || settings.libraryPath;
  if (!libraryPath) {
    const result = await dialog.showMessageBox({
      type: "question",
      title: "文献工作台 · 选择资料库",
      message: "打开已有资料库，或建立新的本地资料库",
      detail:
        "已有资料库是包含 library.sqlite 的文件夹。程序、资料和备份分别存放；升级或卸载程序会保留资料。",
      buttons: ["打开已有资料库", "建立新资料库", "取消"],
      defaultId: 0,
      cancelId: 2,
    });
    if (result.response === 2) return;
    if (result.response === 0) {
      const chosen = await dialog.showOpenDialog({
        title: "选择包含 library.sqlite 的资料库文件夹",
        properties: ["openDirectory"],
      });
      if (chosen.canceled) return;
      libraryPath = chosen.filePaths[0];
      if (!fs.existsSync(path.join(libraryPath, "library.sqlite")))
        throw new Error("所选文件夹中没有 library.sqlite。");
    } else libraryPath = path.join(app.getPath("userData"), "library");
  }
  libraryPath = path.resolve(libraryPath);
  fs.mkdirSync(libraryPath, { recursive: true });
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({ version: 1, libraryPath }, null, 2),
  );
  let previousPort = null;
  try {
    previousPort = JSON.parse(
      fs.readFileSync(path.join(libraryPath, "server-session.json"), "utf8"),
    ).port;
  } catch {}
  let existing = await health(previousPort || 4178);
  if (existing?.desktopParentPid && !processAlive(existing.desktopParentPid)) {
    // An interrupted desktop owns this service; its parent watcher will stop it.
    for (let i = 0; i < 40 && existing; i++) {
      await new Promise((r) => setTimeout(r, 100));
      existing = await health(previousPort || 4178);
    }
  }
  if (
    existing?.application === "paper-workbench" &&
    path.resolve(existing.dataRoot).toLowerCase() === libraryPath.toLowerCase()
  ) {
    if (existing.phase !== 3)
      throw new Error(
        "此资料库正在由旧版程序使用。请关闭旧版窗口并运行“停止文献工作台”，再打开桌面版。",
      );
    baseUrl = `http://127.0.0.1:${previousPort || 4178}`;
    return;
  }
  // A stable origin is required for durable annotation and metadata drafts.
  const port = arg("--port")
    ? Number(arg("--port"))
    : previousPort || (await unusedPort());
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("本地端口配置无效。");
  await assertPortAvailable(port);
  baseUrl = `http://127.0.0.1:${port}`;
  const node = app.isPackaged
    ? path.join(process.resourcesPath, "runtime/node.exe")
    : arg("--node") || process.env.PAPER_WORKBENCH_NODE || "node";
  // In development discover Node from PATH when no local bundled runtime exists.
  const executable = fs.existsSync(node) ? node : "node";
  const log = fs.openSync(path.join(libraryPath, "desktop-server.log"), "a");
  backend = spawn(executable, [path.join(root, "src/server/main.mjs")], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      PAPER_WORKBENCH_DATA: libraryPath,
      PAPER_WORKBENCH_PORT: String(port),
      PAPER_WORKBENCH_PARENT_PID: String(process.pid),
    },
  });
  fs.closeSync(log);
  backendOwned = true;
  let error;
  backend.on("error", (e) => {
    error = e;
  });
  backend.on("exit", () => {
    if (!quitting && windows.size)
      dialog.showErrorBox(
        "本地服务已停止",
        "请重新打开文献工作台。已确认保存的文献和标注保留在资料库中。",
      );
  });
  for (let i = 0; i < 160; i++) {
    if (error) throw error;
    const info = await health(port);
    if (info?.application === "paper-workbench" && info.pid === backend.pid)
      return;
    if (backend.exitCode !== null)
      throw new Error(
        "本地服务启动失败，请查看资料库中的 desktop-server.log。",
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("启动超时，请查看资料库中的 desktop-server.log。");
}
function permitted(url) {
  try {
    return new URL(url).origin === baseUrl;
  } catch {
    return false;
  }
}
function createWindow(url = baseUrl) {
  const win = new BrowserWindow({
    width: 1450,
    height: 950,
    minWidth: 900,
    minHeight: 650,
    title: "文献工作台",
    icon: path.join(runtimeRoot(), "resources/icon.png"),
    backgroundColor: "#f4f5ef",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  windows.add(win);
  win.on("closed", () => windows.delete(win));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (permitted(url)) createWindow(url);
    else if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!permitted(url)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  installCloseGuard(win, dialog);
  win.once("ready-to-show", () => win.show());
  win.loadURL(url);
  return win;
}
function menus() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "文献工作台",
        submenu: [
          { label: "文献库", click: () => createWindow(baseUrl) },
          {
            label: "全文索引与 OCR",
            click: () => createWindow(baseUrl + "/tools.html#index"),
          },
          {
            label: "Word / WPS 引用",
            click: () => createWindow(baseUrl + "/tools.html#citations"),
          },
          { type: "separator" },
          {
            label: "打开资料库文件夹",
            click: () => shell.openPath(libraryPath),
          },
          {
            label: "切换资料库…",
            click: async () => {
              const chosen = await dialog.showOpenDialog({
                title: "选择包含 library.sqlite 的资料库文件夹",
                properties: ["openDirectory"],
              });
              if (chosen.canceled) return;
              const selected = chosen.filePaths[0];
              if (!fs.existsSync(path.join(selected, "library.sqlite")))
                return dialog.showErrorBox(
                  "无法打开",
                  "所选文件夹中没有 library.sqlite。",
                );
              fs.writeFileSync(
                path.join(app.getPath("userData"), "settings.json"),
                JSON.stringify({ version: 1, libraryPath: selected }),
              );
              dialog.showMessageBox({
                message: "已记录新的资料库位置",
                detail: "关闭当前全部窗口后重新打开桌面版即可切换。",
                buttons: ["知道了"],
              });
            },
          },
          { type: "separator" },
          { role: "quit", label: "退出" },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo", label: "撤销" },
          { role: "redo", label: "重做" },
          { type: "separator" },
          { role: "cut", label: "剪切" },
          { role: "copy", label: "复制" },
          { role: "paste", label: "粘贴" },
          { role: "selectAll", label: "全选" },
        ],
      },
      {
        label: "视图",
        submenu: [
          { role: "reload", label: "重新载入" },
          { role: "resetZoom", label: "实际大小" },
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
          { role: "togglefullscreen", label: "全屏" },
        ],
      },
      {
        label: "帮助",
        submenu: [
          {
            label: "关于",
            click: () =>
              dialog.showMessageBox({
                message: `文献工作台 ${app.getVersion()}`,
                detail:
                  "本地文献管理、PDF 阅读标注、离线全文/OCR 与 Word 引用。开源许可证 AGPL-3.0。\n资料库：" +
                  libraryPath,
                buttons: ["关闭"],
              }),
          },
        ],
      },
    ]),
  );
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const win = [...windows][0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    try {
      await launchBackend();
      if (!baseUrl) {
        app.quit();
        return;
      }
      menus();
      createWindow();
    } catch (error) {
      dialog.showErrorBox("文献工作台启动失败", error.message);
      app.quit();
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting || !backendOwned || !backend) return;
    // Close windows first so each reader can block exit until acknowledged saves.
    if (windows.size) {
      event.preventDefault();
      for (const win of windows) win.close();
      return;
    }
    event.preventDefault();
    quitting = true;
    (async () => {
      try {
        const healthInfo = await fetch(baseUrl + "/api/health").then((r) =>
          r.json(),
        );
        if (healthInfo.pid === backend.pid)
          await fetch(baseUrl + "/api/shutdown", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Paper-Workbench": "1",
            },
            body: JSON.stringify({ expectedPid: backend.pid }),
          });
      } catch {
      } finally {
        app.quit();
      }
    })();
  });
}
