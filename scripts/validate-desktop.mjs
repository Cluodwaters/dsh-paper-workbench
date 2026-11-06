import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { projectRoot } from "../src/config.mjs";
const require = createRequire(import.meta.url),
  { _electron } = require(
    process.env.PAPER_WORKBENCH_PLAYWRIGHT || "playwright",
  );
const executablePath = process.env.PAPER_WORKBENCH_DESKTOP_EXE;
if (!executablePath) throw new Error("Set PAPER_WORKBENCH_DESKTOP_EXE");
const directory = path.join(projectRoot, "output/desktop-qa");
mkdirSync(directory, { recursive: true });
const profile = path.join(projectRoot, "data/desktop-qa-profile"),
  library = path.join(projectRoot, "data/stage3-qa");
const report = { checks: [], executablePath };
const pass = (name, check) => {
  check?.();
  report.checks.push(name);
  console.log("PASS", name);
};
const launch = () =>
  _electron.launch({
    executablePath,
    args: ["--profile", profile, "--library", library],
    timeout: 90000,
  });
let app = await launch();
try {
  app.context().setDefaultTimeout(30000);
  const page = await app.firstWindow({ timeout: 60000 });
  await page.waitForSelector("#result-total");
  await page.waitForFunction(
    () => Number(document.querySelector("#result-total").textContent) > 0,
  );
  const preferences = await app.evaluate(({ BrowserWindow, app }) => ({
    packaged: app.isPackaged,
    preferences:
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    versions: process.versions,
  }));
  pass(
    "packaged desktop opens with Node integration disabled and renderer sandbox enabled",
    () => {
      assert.equal(preferences.packaged, true);
      assert.equal(preferences.preferences.nodeIntegration, false);
      assert.equal(preferences.preferences.contextIsolation, true);
      assert.equal(preferences.preferences.sandbox, true);
    },
  );
  report.versions = preferences.versions;
  assert.deepEqual(
    await page.evaluate(() => [typeof require, typeof process]),
    ["undefined", "undefined"],
  );
  const health = await page.evaluate(() =>
    fetch("/api/health").then((r) => r.json()),
  );
  assert.equal(health.schemaVersion, 3);
  report.backend = health;
  const origin = new URL(page.url()).origin;
  report.origin = origin;
  await page.selectOption("#search-scope", "fulltext");
  await page.fill("#search", "anharmonicity");
  await page.waitForSelector(".text-hit");
  pass("full-library text search returns page snippets");
  await page.screenshot({
    path: path.join(directory, "desktop-fulltext.png"),
    fullPage: true,
  });
  const readerPromise = app.waitForEvent("window");
  await page
    .locator('a[href="/reader.html?id=b0884063-dd0a-4090-bde7-32f106df268d"]')
    .click();
  const reader = await readerPromise;
  await reader.waitForFunction(
    () => {
      try {
        return (
          window.workbench?.adapter?.getSaveState() === "saved" &&
          window.workbench.adapter.currentPage() >= 0
        );
      } catch {
        return false;
      }
    },
    {},
    { timeout: 60000 },
  );
  const count = await reader.evaluate(
    () => window.workbench.adapter.annotations().length,
  );
  assert.equal(count, 6);
  await reader.evaluate(() => window.workbench.adapter.goToPage(1));
  await reader.click("#save");
  pass(
    "independent packaged PDF reader restores all existing annotations and saves page position",
  );
  await reader.click("#page-text-button");
  await reader.waitForSelector("#page-text.text-viewer");
  pass("reader exposes indexed page text");
  await reader.locator("dialog [data-close]").last().click();
  const exported = path.join(directory, "packaged-export.pdf");
  await app.evaluate(({ session }, filename) => {
    session.defaultSession.on("will-download", (_event, item) =>
      item.setSavePath(filename),
    );
  }, exported);
  await reader.click("#export-pdf");
  await reader.waitForFunction(
    () => document.querySelector("#notice").textContent.includes("已导出"),
    {},
    { timeout: 130000 },
  );
  let deadline = Date.now() + 20000;
  while (!existsSync(exported)) {
    if (Date.now() > deadline) throw new Error("Export download timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(readFileSync(exported).length > 10000);
  pass(
    "packaged runtime exports an annotated PDF with bundled fonts and writer",
  );
  await reader.screenshot({ path: path.join(directory, "desktop-reader.png") });
  const toolsPromise = app.waitForEvent("window");
  await page.locator('a[href="/tools.html#index"]').click();
  const tools = await toolsPromise;
  await tools.waitForSelector(".index-row");
  await tools.screenshot({
    path: path.join(directory, "desktop-index.png"),
    fullPage: true,
  });
  const ocrJob = await tools.evaluate(() =>
    fetch("/api/index/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Paper-Workbench": "1" },
      body: JSON.stringify({
        ids: ["cee1a1b1-69d6-4684-a102-03570eb767f8"],
        mode: "force-ocr",
      }),
    })
      .then((r) => r.json())
      .then((j) => j[0].id),
  );
  let ocrDeadline = Date.now() + 90000;
  while (true) {
    const state = await tools.evaluate(() =>
      fetch("/api/index/status").then((r) => r.json()),
    );
    const job = state.jobs.find((j) => j.id === ocrJob);
    if (job.status === "done") break;
    if (job.status === "failed") throw new Error(job.error);
    if (Date.now() > ocrDeadline) throw new Error("Packaged OCR timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
  const ocrText = await tools.evaluate(() =>
    fetch("/api/index/text/cee1a1b1-69d6-4684-a102-03570eb767f8").then((r) =>
      r.json(),
    ),
  );
  assert.match(ocrText[0].ocrText, /Supplementary Information/i);
  pass(
    "packaged OCR actually recognizes scanned pages with its bundled engine and models",
  );
  await tools
    .locator('[data-text="cd96557b-6bd9-4df9-a049-b549b818c221"]')
    .click();
  await tools.waitForFunction(() =>
    document.querySelector("#page-text")?.textContent.includes("哈尔滨"),
  );
  await tools.screenshot({ path: path.join(directory, "desktop-ocr.png") });
  pass("Chinese OCR text is readable and exportable in the desktop interface");
  await tools.locator("dialog [data-close]").last().click();
  await tools.locator('a[href="#citations"]').click();
  await tools.waitForFunction(
    () => document.querySelector("#cite-style").options.length >= 4,
  );
  const office = await tools.evaluate(() =>
    fetch("/api/citations/info").then((r) => r.json()),
  );
  report.office = office;
  assert.ok(office.applications.find((a) => a.id === "word").installed);
  pass("packaged Word connector is present and responds");
  await tools.screenshot({
    path: path.join(directory, "desktop-citations.png"),
  });
  await tools.locator("[data-cite-id]:not(:disabled)").first().click();
  let captureRoute, finishRoute;
  const captured = new Promise((resolve) => (captureRoute = resolve));
  await tools.route(
    "**/api/citations/prepare",
    (route) =>
      new Promise((resolve) => {
        finishRoute = resolve;
        captureRoute(route);
      }),
  );
  await tools.locator("#cite-insert").click();
  const pendingRoute = await captured;
  await tools.locator("[data-cite-id]:not(:disabled)").first().click();
  await pendingRoute.fulfill({
    json: {
      planId: "stale-preview-test",
      target: { name: "test.docx", fullName: "test.docx" },
      style: "apa",
      citationCount: 1,
      bibliographyCount: 1,
      warnings: [],
      citation: "old preview",
      bibliography: "old preview",
    },
  });
  finishRoute();
  await tools.waitForFunction(
    () => !document.querySelector("#cite-insert").disabled,
  );
  assert.equal(await tools.locator("#cite-preview").isVisible(), false);
  await tools.unroute("**/api/citations/prepare");
  pass("changing citation selection discards a delayed stale preview");
  const itemId = "62a56daf-9433-4d87-bef1-4a0db759f087";
  await page.locator(`[data-select="${itemId}"]`).click();
  await page.locator('#details [data-action="edit"]').click();
  const draftTitle =
    "【未保存草稿验证】Mass transport and thermal properties of liquid tungsten";
  await page.locator('#details [data-field="title"]').fill(draftTitle);
  await page.waitForFunction(() =>
    document.querySelector("#draft-status")?.textContent.includes("本机保留"),
  );
  await app.close();
  app = null;
  // A fresh Electron process, backend process and SQLite connection must recover
  // the library and reader state using only the installed runtime.
  app = await launch();
  const reopened = await app.firstWindow();
  await reopened.waitForSelector("#result-total");
  assert.equal(new URL(reopened.url()).origin, origin);
  await reopened.selectOption("#search-scope", "metadata");
  await reopened.fill("#search", "Mass transport and thermal properties");
  await reopened.locator(`[data-select="${itemId}"]`).click();
  const recovery = reopened.locator('#details [data-action="recover-draft"]');
  await recovery.waitFor();
  await recovery.click();
  await reopened
    .getByRole("button", { name: "载入为当前草稿", exact: true })
    .click();
  assert.equal(
    await reopened.locator('#details [data-field="title"]').inputValue(),
    draftTitle,
  );
  pass(
    "desktop restart retains the local origin and restores an unsaved metadata draft",
  );
  await reopened.locator('#details [data-action="reset-draft"]').click();
  await reopened
    .getByRole("button", { name: "丢弃草稿并载入", exact: true })
    .click();
  await reopened.goto(
    origin + "/reader.html?id=b0884063-dd0a-4090-bde7-32f106df268d",
  );
  await reopened.waitForFunction(
    () => {
      try {
        return (
          window.workbench.adapter.currentPage() === 1 &&
          window.workbench.adapter.getSaveState() === "saved"
        );
      } catch {
        return false;
      }
    },
    {},
    { timeout: 60000 },
  );
  assert.equal(
    await reopened.evaluate(
      () => window.workbench.adapter.annotations().length,
    ),
    6,
  );
  pass("desktop and backend restart recover annotations and reading position");
  report.status = "passed";
  writeFileSync(
    path.join(directory, "results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report.checks));
} finally {
  await app?.close();
}
