import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { projectRoot } from "../src/config.mjs";
const require = createRequire(import.meta.url);
const { _electron } = require(process.env.PAPER_WORKBENCH_PLAYWRIGHT);
const executablePath = process.env.PAPER_WORKBENCH_DESKTOP_EXE;
const directory = path.join(projectRoot, "output/save-fix-qa");
mkdirSync(directory, { recursive: true });
const id = "92851ec4-c327-4cd5-b27d-a6d2484ad8cc";
const profile = path.join(projectRoot, "data/save-fix-qa-profile");
const library = path.join(projectRoot, "data/stage3-qa");
const report = { executablePath, checks: [] };
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS", name);
};
const launch = () =>
  _electron.launch({
    executablePath,
    args: ["--profile", profile, "--library", library],
    timeout: 60000,
  });
let app = await launch();
try {
  app.context().setDefaultTimeout(15000);
  let libraryWindow = await app.firstWindow();
  await libraryWindow.waitForSelector("#result-total");
  const origin = new URL(libraryWindow.url()).origin;
  const getDocument = () =>
    fetch(`${origin}/api/documents/${id}`).then((r) => r.json());
  async function openReader() {
    const opening = app.waitForEvent("window");
    await libraryWindow.locator(`a[href="/reader.html?id=${id}"]`).click();
    const reader = await opening;
    // Electron handles beforeunload natively; CDP can observe the notification
    // after it has already been dismissed. Avoid Playwright's unhandled auto reply.
    reader.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
    await reader.waitForFunction(
      () =>
        window.workbench?.adapter?.pdfApplication &&
        window.workbench.adapter.getSaveState() === "saved",
    );
    await reader.evaluate(() => window.workbench.adapter.goToPage(0));
    return reader;
  }
  async function drawDot(reader, offset = 70) {
    const frame = reader.frameLocator("#reader-frame");
    const drawButton = frame.getByRole("button", { name: "Draw", exact: true });
    if (!(await drawButton.getAttribute("class")).split(" ").includes("active"))
      await drawButton.click();
    const pdfFrame = frame.frameLocator("iframe");
    const page = pdfFrame.locator('.page[data-page-number="1"]');
    const pageBox = await page.boundingBox();
    const frameBox = await frame.locator("iframe").boundingBox();
    const x = pageBox.x + offset,
      y = Math.max(pageBox.y + 130, frameBox.y + 100);
    await reader.mouse.click(x, y);
  }
  async function closeWithChoice(reader, choice) {
    await app.evaluate(
      async ({ dialog, BrowserWindow }, { url, choice }) => {
        let prompts = 0;
        dialog.showMessageBox = async () => {
          prompts++;
          return { response: choice };
        };
        const win = BrowserWindow.getAllWindows().find(
          (w) => w.webContents.getURL() === url,
        );
        win.close();
        const end = Date.now() + 10000;
        while (
          !win.isDestroyed() &&
          (prompts === 0 || (choice === 1 && prompts < 2)) &&
          Date.now() < end
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
      },
      { url: reader.url(), choice },
    );
  }
  let reader = await openReader();
  const original = await getDocument();
  const originalIds = original.snapshot.annotations.map((a) => a.id);
  await drawDot(reader);
  await reader.waitForFunction((ids) => {
    const a = window.workbench.adapter;
    return (
      a.getSaveState() === "saved" &&
      a.annotations().some((x) => x.type === "ink" && !ids.includes(x.id))
    );
  }, originalIds);
  const saved = await getDocument();
  const dot = saved.snapshot.annotations.find(
    (a) => a.type === "ink" && !originalIds.includes(a.id),
  );
  assert.ok(dot.position.paths.some((p) => p.length === 2));
  report.dot = dot;
  pass("real Draw-tool click saves a native single-point ink stroke");
  const exported = await fetch(`${origin}/api/export/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Paper-Workbench": "1" },
    body: JSON.stringify({ expectedRevision: saved.snapshot.revision }),
  });
  assert.equal(exported.status, 200);
  report.export = await exported.json();
  writeFileSync(
    path.join(directory, "ink-dot-export.pdf"),
    Buffer.from(
      await fetch(origin + report.export.downloadUrl).then((r) =>
        r.arrayBuffer(),
      ),
    ),
  );
  pass(
    "saved one-point ink exports successfully through the packaged PDF writer",
  );

  const fail = (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: "TEST_SAVE_FAILURE", message: "模拟保存失败" } },
    });
  await reader.route("**/api/annotations/*", fail);
  await drawDot(reader, 210);
  await reader.waitForFunction(
    () => window.workbench.adapter.getSaveState() === "failed",
  );
  await reader.click("#save");
  await reader.waitForFunction(() =>
    document.getElementById("notice").textContent.includes("模拟保存失败"),
  );
  pass(
    "Save reports the failure without hanging on the reader's acknowledgement promise",
  );
  const draftFile = path.join(directory, "unsaved-annotations.json");
  await app.evaluate(({ session }, file) => {
    globalThis.qaDownloadState = "waiting";
    session.defaultSession.once("will-download", (_event, item) => {
      item.setSavePath(file);
      item.once("done", (_event, state) => {
        globalThis.qaDownloadState = state;
      });
    });
  }, draftFile);
  await reader.click("#export-json");
  for (let i = 0; i < 100; i++) {
    if ((await app.evaluate(() => globalThis.qaDownloadState)) === "completed")
      break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    await app.evaluate(() => globalThis.qaDownloadState),
    "completed",
  );
  const draft = JSON.parse(readFileSync(draftFile, "utf8"));
  assert.equal(draft.saveState, "failed");
  assert.ok(
    draft.annotations.some(
      (a) => !saved.snapshot.annotations.some((b) => a.id === b.id),
    ),
  );
  pass(
    "JSON backup exports current unsaved annotations even while database saving fails",
  );
  await closeWithChoice(reader, 0);
  assert.equal(reader.isClosed(), false);
  assert.equal(
    await reader.evaluate(() => window.workbench.adapter.getSaveState()),
    "failed",
  );
  pass("Return to reader preserves the unsaved state");
  await closeWithChoice(reader, 1);
  await reader.waitForFunction(() =>
    document.getElementById("notice").textContent.includes("模拟保存失败"),
  );
  assert.equal(reader.isClosed(), false);
  pass("failed Save and close keeps the window open");
  // Let the first asynchronous close handler finish before a separate click.
  await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
  const closed = reader.waitForEvent("close");
  await closeWithChoice(reader, 2);
  await closed;
  pass(
    "explicit discard closes a real desktop reader with a failed pending save",
  );
  reader = await openReader();
  assert.deepEqual(
    (await getDocument()).snapshot.annotations,
    saved.snapshot.annotations,
  );
  assert.deepEqual(
    await reader.evaluate(() =>
      window.workbench.adapter
        .annotations()
        .map((a) => a.id)
        .sort(),
    ),
    saved.snapshot.annotations.map((a) => a.id).sort(),
  );
  pass("reopening after discard does not replay the discarded annotation");

  await reader.route("**/api/annotations/*", fail);
  await drawDot(reader, 350);
  await reader.waitForFunction(
    () => window.workbench.adapter.getSaveState() === "failed",
  );
  await reader.unroute("**/api/annotations/*", fail);
  const savedClose = reader.waitForEvent("close");
  await closeWithChoice(reader, 1);
  await savedClose;
  const final = await getDocument();
  assert.ok(final.snapshot.revision > saved.snapshot.revision);
  assert.ok(
    final.snapshot.annotations.some(
      (a) => !saved.snapshot.annotations.some((b) => a.id === b.id),
    ),
  );
  pass(
    "Save and close retries the pending request and closes only after it is acknowledged",
  );
  await app.close();
  app = await launch();
  libraryWindow = await app.firstWindow();
  await libraryWindow.waitForSelector("#result-total");
  reader = await openReader();
  assert.deepEqual(
    (await getDocument()).snapshot.annotations,
    final.snapshot.annotations,
  );
  await reader.screenshot({
    path: path.join(directory, "reader-recovered.png"),
    fullPage: true,
  });
  pass("saved ink and the discard decision survive a full desktop restart");
  report.passed = true;
  writeFileSync(
    path.join(directory, "results.json"),
    JSON.stringify(report, null, 2),
  );
} finally {
  // Only this isolated QA process is disposable; never use this for a user's reader.
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
