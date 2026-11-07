import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { projectRoot } from "../src/config.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PAPER_WORKBENCH_PLAYWRIGHT || "playwright",
);
const output = path.join(projectRoot, "output/harness-validation");
mkdirSync(output, { recursive: true });
const dataRoot = mkdtempSync(path.join(output, "library-"));
const token = randomBytes(32).toString("hex");
const mount = "/paper-workbench";
const freePort = async () => {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
};
const backendPort = await freePort();
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const child = spawn(process.execPath, ["src/server/main.mjs"], {
  cwd: projectRoot,
  windowsHide: true,
  env: {
    ...process.env,
    PAPER_WORKBENCH_PORT: String(backendPort),
    PAPER_WORKBENCH_DATA: dataRoot,
    PAPER_WORKBENCH_BASE_PATH: mount,
    PAPER_WORKBENCH_BRIDGE_TOKEN: token,
    PAPER_WORKBENCH_AUTO_INDEX: "0",
    PAPER_WORKBENCH_PARENT_PID: String(process.pid),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "",
  browser,
  proxy;
child.stdout.on("data", (b) => {
  logs += b;
});
child.stderr.on("data", (b) => {
  logs += b;
});
const report = { checks: [], consoleErrors: [], failedRequests: [] };
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS", name);
};
const request = async (route, data, extra = {}) =>
  fetch(backendOrigin + mount + route, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(data === undefined
        ? {}
        : { "content-type": "application/json", "x-paper-workbench": "1" }),
      ...extra.headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
const api = async (route, data) => {
  const r = await request(route, data);
  const v = await r.json();
  assert.ok(r.ok, JSON.stringify(v));
  return v;
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await request("/api/health")).ok) break;
    } catch {}
    if (child.exitCode !== null) throw new Error(logs);
    await pause(100);
  }
  assert.equal(
    (await fetch(backendOrigin + mount + "/api/health")).status,
    401,
  );
  assert.equal(
    (
      await fetch(backendOrigin + "/api/health", {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        "/api/library/search",
        {},
        { headers: { origin: "http://untrusted.invalid" } },
      )
    ).status,
    403,
  );
  pass(
    "backend rejects unauthenticated, outside-mount and cross-origin requests",
  );
  const imported = await fetch(
    backendOrigin + mount + "/api/library/import-pdf",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-paper-workbench": "1",
        "x-file-name": encodeURIComponent("Harness 阅读验证.pdf"),
        "content-type": "application/pdf",
      },
      body: readFileSync(
        path.join(projectRoot, "data/validation/fixtures/fixture-existing.pdf"),
      ),
    },
  );
  assert.ok(imported.ok, await imported.text());
  const doc = (await api("/api/documents"))[0];
  assert.ok(doc?.id);
  await api("/api/index/queue", { ids: [doc.id], mode: "text" });
  for (let i = 0; i < 200; i++) {
    const status = await api("/api/index/status");
    if (status.documents[0].indexedAt) break;
    if (i === 199) throw new Error("index timeout");
    await pause(150);
  }
  const context = await api("/api/ai/context", {
    attachmentId: doc.id,
    sourceHash: doc.sourceHash,
    pageIndices: [0],
  });
  assert.ok(context.pages[0].text.length > 100);
  pass("copied fixture imports, indexes and yields verified page context");
  const shell = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#f9fafb}iframe{border:0;width:100%;height:100%}</style></head><body><iframe id="workbench" title="Harness test shell" src="${mount}/?embed=harness"></iframe><script>window.messages=[];window.addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow&&e.origin===location.origin)messages.push(e.data)});window.command=(command,payload)=>new Promise((resolve,reject)=>{const requestId=crypto.randomUUID();const timer=setTimeout(()=>{removeEventListener('message',listener);reject(Error('command timeout '+command))},20000);const listener=e=>{if(e.origin!==location.origin||e.source!==document.querySelector('iframe').contentWindow||e.data.requestId!==requestId)return;clearTimeout(timer);removeEventListener('message',listener);resolve(e.data)};addEventListener('message',listener);document.querySelector('iframe').contentWindow.postMessage({type:'paper-workbench:command',version:1,requestId,command,payload},location.origin)});</script></body></html>`;
  proxy = http.createServer((req, res) => {
    if (req.url === "/qa") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(shell);
      return;
    }
    if (!req.url.startsWith(mount + "/")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const headers = {
      ...req.headers,
      host: `127.0.0.1:${backendPort}`,
      authorization: `Bearer ${token}`,
    };
    delete headers.origin;
    delete headers.cookie;
    const upstream = http.request(
      backendOrigin + req.url,
      { method: req.method, headers },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PAPER_WORKBENCH_BROWSER ||
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => report.consoleErrors.push(error.message));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("/api/annotations/"))
      report.failedRequests.push({
        url: r.url().replace(origin, ""),
        status: r.status(),
      });
  });
  await page.goto(origin + "/qa");
  await page.waitForFunction(() =>
    messages.some(
      (m) => m.type === "paper-workbench:ready" && m.view === "library",
    ),
  );
  let frame = page.frames().find((f) => f.url().includes("embed=harness"));
  assert.equal(await frame.locator("#result-total").textContent(), "1");
  await frame.locator("#new-item").click();
  await frame.locator('[data-field="title"]').fill("Harness 未保存表单验证");
  assert.equal((await page.evaluate(() => command("flush"))).ok, false);
  await frame.getByRole("button", { name: "保存信息", exact: true }).click();
  await frame.waitForFunction(() => !document.querySelector(".metadata-form"));
  await frame.locator("#save-query").click();
  assert.equal((await page.evaluate(() => command("flush"))).ok, false);
  await frame.getByRole("button", { name: "关闭对话框" }).click();
  assert.equal((await page.evaluate(() => command("flush"))).ok, true);
  for (const width of [960, 640]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await frame.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `library overflow at ${width}`,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => command("theme", { theme: "dark" }));
  await page.screenshot({ path: path.join(output, "library-dark.png") });
  await page.evaluate(() => command("theme", { theme: "light" }));
  await frame.locator(".read-link").first().click();
  await page.waitForFunction(() =>
    messages.some(
      (m) => m.type === "paper-workbench:open" && m.view === "reader",
    ),
  );
  assert.equal(
    (
      await page.evaluate(() =>
        messages.find((m) => m.type === "paper-workbench:open"),
      )
    ).attachmentId,
    doc.id,
  );
  await page.screenshot({ path: path.join(output, "library.png") });
  pass(
    "embedded library loads all mounted modules and routes PDF navigation to its host",
  );
  pass(
    "open edit dialogs block host navigation and narrow plugin widths do not overflow",
  );
  await page.evaluate(
    (src) => (document.querySelector("iframe").src = src),
    `${mount}/reader.html?embed=harness&id=${doc.id}`,
  );
  await page.waitForFunction(
    () =>
      messages.some(
        (m) => m.type === "paper-workbench:ready" && m.view === "reader",
      ),
    null,
    { timeout: 60000 },
  );
  frame = page.frames().find((f) => f.url().includes("/reader.html?"));
  const toolsToggle = frame.locator("#reader-tools-toggle");
  const toolsPanel = frame.locator("#reader-tools");
  assert.equal(await toolsToggle.isVisible(), true);
  assert.equal(await frame.locator(".harness-ai-tools").isVisible(), false);
  const title = frame.locator("#document-title");
  assert.equal(await title.getAttribute("title"), await title.textContent());
  report.readerLayout = [];
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => command("theme", { theme }), theme);
    for (const width of [1440, 960, 640, 480, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const before = await frame.locator(".reading-area").boundingBox();
      assert.equal(before.y, 36, "only one compact bar precedes the PDF");
      assert.equal(
        before.height,
        864,
        "no redundant footer consumes reading space",
      );
      await toolsToggle.click();
      assert.equal(await toolsPanel.isVisible(), true);
      assert.equal(await toolsToggle.getAttribute("aria-expanded"), "true");
      assert.deepEqual(
        await frame.locator(".reading-area").boundingBox(),
        before,
      );
      const panelBox = await toolsPanel.boundingBox();
      assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= width);
      assert.ok(panelBox.y + panelBox.height <= 900);
      assert.ok(
        await frame.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      if (width === 1440 || width === 320)
        await page.screenshot({
          path: path.join(output, `reader-tools-${theme}-${width}.png`),
        });
      await frame.locator("#page-text-button").focus();
      await page.keyboard.press("Escape");
      assert.equal(await toolsPanel.isVisible(), false);
      assert.equal(await toolsToggle.getAttribute("aria-expanded"), "false");
      assert.equal(
        await toolsToggle.evaluate((el) => el === document.activeElement),
        true,
      );
      report.readerLayout.push({
        theme,
        width,
        toolbarHeight: before.y,
        readerHeight: before.height,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await toolsToggle.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  assert.equal(
    await frame
      .locator("#page-text-button")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("Enter");
  await frame.locator("dialog[open] #page-text").waitFor();
  assert.equal(await toolsPanel.isVisible(), false);
  await frame.getByRole("button", { name: "关闭对话框" }).click();
  await toolsToggle.click();
  await frame.locator("#save").click();
  await frame.waitForFunction(
    () => document.querySelector("#save-status").textContent === "已保存",
  );
  await toolsToggle.click();
  await frame.locator("#document-title").click();
  assert.equal(await toolsPanel.isVisible(), false);
  pass(
    "reader tools float above a 36px toolbar in both themes at 320–1440px; keyboard, OCR, save and dismissal work",
  );
  assert.equal(
    (await page.evaluate(() => command("navigate", { pageIndex: 1 }))).value
      .pageIndex,
    1,
  );
  await page.evaluate(() => command("navigate", { pageIndex: 0 }));
  const pdf = page.frames().find((f) => f.url().includes("/pdf/"));
  assert.ok(pdf, "PDF frame loaded");
  await pdf.locator(".textLayer span").first().waitFor();
  const clickPdf = async () => {
    const box = await (await pdf.frameElement()).boundingBox();
    await page.mouse.click(box.x + 100, box.y + 120);
  };
  await toolsToggle.click();
  await clickPdf();
  assert.equal(
    await toolsPanel.isVisible(),
    false,
    "clicking the PDF dismisses reader tools",
  );
  await toolsToggle.click();
  await clickPdf();
  assert.equal(
    await toolsPanel.isVisible(),
    false,
    "PDF dismissal also works when the PDF already had focus",
  );
  const selected = await pdf.evaluate(() => {
    const el = document.querySelector(".textLayer span");
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
    return s.toString().trim();
  });
  assert.ok(selected);
  await toolsToggle.click();
  await frame.locator('[data-ai-action="translate"]').click();
  assert.equal(await toolsPanel.isVisible(), false);
  await page.waitForFunction(() =>
    messages.some((m) => m.type === "paper-workbench:ai"),
  );
  const ai = await page.evaluate(() =>
    messages.findLast((m) => m.type === "paper-workbench:ai"),
  );
  assert.equal(ai.context.selection.text, selected);
  assert.equal(ai.context.attachmentId, doc.id);
  assert.equal(ai.context.sourceHash, doc.sourceHash);
  pass(
    "selected PDF text and stable source/page identifiers reach the AI action without an automatic model request",
  );
  await page.evaluate(() => command("theme", { theme: "dark" }));
  assert.equal(await frame.locator("html").getAttribute("data-theme"), "dark");
  await frame.evaluate(() =>
    window.postMessage(
      {
        type: "paper-workbench:command",
        version: 1,
        requestId: "spoof",
        command: "theme",
        payload: { theme: "light" },
      },
      location.origin,
    ),
  );
  await pause(100);
  assert.equal(await frame.locator("html").getAttribute("data-theme"), "dark");
  await page.screenshot({ path: path.join(output, "reader-dark.png") });
  await page.evaluate(() => command("theme", { theme: "light" }));
  pass("host theme commands work and messages from another source are ignored");
  const upstream = frame.frameLocator("#reader-frame");
  await upstream.getByRole("button", { name: "Draw", exact: true }).click();
  const pageBox = await upstream
    .frameLocator("iframe")
    .locator('.page[data-page-number="1"]')
    .boundingBox();
  const frameBox = await upstream.locator("iframe").boundingBox();
  const draw = () =>
    page.mouse.click(
      pageBox.x + 85,
      Math.max(pageBox.y + 140, frameBox.y + 110),
    );
  await draw();
  await frame.waitForFunction(
    () =>
      window.workbench.adapter.getSaveState() === "saved" &&
      window.workbench.adapter
        .snapshot()
        .annotations.some((a) => a.type === "ink"),
  );
  const saved = await api("/api/documents/" + doc.id);
  assert.ok(saved.snapshot.annotations.some((a) => a.type === "ink"));
  assert.equal((await page.evaluate(() => command("flush"))).ok, true);
  const fail = (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: { code: "QA_SAVE_FAILED", message: "模拟数据库暂不可用" },
      },
    });
  await page.route("**/api/annotations/**", fail);
  await page.mouse.click(
    pageBox.x + 125,
    Math.max(pageBox.y + 145, frameBox.y + 115),
  );
  await frame.waitForFunction(
    () => window.workbench.adapter.getSaveState() === "failed",
  );
  assert.equal((await page.evaluate(() => command("flush"))).ok, false);
  assert.equal(await toolsPanel.isVisible(), false);
  assert.equal(await frame.locator("#retry").isVisible(), true);
  assert.equal(
    await frame.locator("#save-status").getAttribute("data-state"),
    "failed",
  );
  await page.unroute("**/api/annotations/**", fail);
  await frame.locator("#retry").click();
  assert.equal((await page.evaluate(() => command("flush"))).ok, true);
  pass(
    "native ink saves durably; failed acknowledgements reject host navigation until retry succeeds",
  );
  const annotations = await api(
    `/api/ai/annotations/${doc.id}?sourceHash=${doc.sourceHash}`,
  );
  assert.ok(annotations.annotations.some((a) => a.type === "ink"));
  await toolsToggle.click();
  const backupDownload = page.waitForEvent("download");
  await frame.locator("#export-json").click();
  const backup = await backupDownload;
  const snapshot = JSON.parse(readFileSync(await backup.path(), "utf8"));
  assert.equal(snapshot.saveState, "saved");
  assert.ok(snapshot.annotations.some((a) => a.type === "ink"));
  await toolsToggle.click();
  const pdfDownload = page.waitForEvent("download");
  await frame.locator("#export-pdf").click();
  assert.equal(await toolsPanel.isVisible(), false);
  const exported = await pdfDownload;
  assert.equal(
    readFileSync(await exported.path())
      .subarray(0, 5)
      .toString(),
    "%PDF-",
  );
  const pdfResponse = await fetch(exported.url());
  assert.equal(pdfResponse.status, 200);
  assert.match(pdfResponse.headers.get("content-type"), /application\/pdf/);
  pass("mounted export downloads remain reachable after acknowledged saves");
  await page.screenshot({ path: path.join(output, "reader-light.png") });
  await page.evaluate(
    (src) => (document.querySelector("iframe").src = src),
    `${mount}/tools.html?embed=harness#index`,
  );
  await page.waitForFunction(() =>
    messages.some(
      (m) => m.type === "paper-workbench:ready" && m.view === "tools",
    ),
  );
  pass("index and citation tools load within the same plugin mount");
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.failedRequests, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
  }
  try {
    await api("/api/shutdown", { expectedPid: child.pid });
  } catch {
    child.kill();
  }
  writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  writeFileSync(path.join(output, "backend.log"), logs);
}
