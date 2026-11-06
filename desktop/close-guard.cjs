/** Keep a failed save visible while giving the user an explicit exit path. */
function installCloseGuard(win, dialog) {
  let handling = false;
  win.webContents.on("will-prevent-unload", async () => {
    if (handling || win.isDestroyed()) return;
    handling = true;
    try {
      const choice = await dialog.showMessageBox(win, {
        type: "warning",
        title: "文献工作台",
        message: "还有修改尚未确认保存",
        detail:
          "可重试保存，也可放弃本窗口尚未保存的修改。已自动保存的内容不会撤销；需要备份时，请返回阅读器导出标注 JSON。",
        buttons: ["返回阅读器", "重试保存并关闭", "放弃未保存修改并关闭"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (!choice.response || win.isDestroyed()) return;
      const action = choice.response === 1 ? "save" : "discard";
      const result = await win.webContents.executeJavaScript(
        `window.paperWorkbenchReader?.prepareClose(${JSON.stringify(action)})`,
      );
      if (result?.ok) {
        // The async beforeunload event has already finished. Destroy only after
        // acknowledgement or explicit discard, never merely because save failed.
        if (!win.isDestroyed()) win.destroy();
      } else if (!win.isDestroyed()) {
        await dialog.showMessageBox(win, {
          type: "error",
          title: "文献工作台",
          message: "尚未完成保存，窗口已保留",
          detail: result?.error || "阅读器尚未准备好，请返回后重试。",
          buttons: ["返回阅读器"],
        });
      }
    } catch (error) {
      if (!win.isDestroyed())
        await dialog.showMessageBox(win, {
          type: "error",
          title: "文献工作台",
          message: "未能完成关闭操作，窗口已保留",
          detail: error.message,
          buttons: ["返回阅读器"],
        });
    } finally {
      handling = false;
    }
  });
}
module.exports = { installCloseGuard };
