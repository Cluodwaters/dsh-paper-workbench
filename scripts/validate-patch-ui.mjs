// Run the actual tarball in an isolated DSH Web profile. All PDFs and jobs in
// this test are local fixtures. No model is required for the selection check.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";
import { ImportService } from "../src/application/import-service.mjs";
import { projectRoot } from "../src/config.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["archive", "previous", "harness", "browser", "playwright", "fixture"].map(
      (key) => [key, { type: "string" }],
    ),
  ),
});
for (const key of ["archive", "harness", "browser", "playwright", "fixture"])
  assert.ok(values[key], "Required option --" + key);
const absolute = (key) => path.resolve(values[key]);
const { chromium } = createRequire(import.meta.url)(absolute("playwright"));
const exe = path.join(absolute("harness"), "DeepSeek Harness.exe");
const cli = path.join(
  absolute("harness"),
  "resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js",
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pw-release-qa-"));
const data = path.join(root, "library"),
  files = path.join(data, "files");
fs.mkdirSync(files, { recursive: true });
const env = {
  ...process.env,
  DSH_HOME: path.join(root, "dsh"),
  DSH_AGENTS_HOME: path.join(root, "agents"),
  LOCALAPPDATA: path.join(root, "appdata"),
  TEMP: path.join(root, "temp"),
  TMP: path.join(root, "temp"),
  PNPM_HOME: path.join(root, "pnpm"),
  npm_config_cache: path.join(root, "npm"),
  ELECTRON_RUN_AS_NODE: "1",
  DSH_TELEMETRY_MODE: "DISABLED",
  DEEPSEEK_API_KEY: "local-qa-placeholder",
  DEEPSEEK_BASE_URL: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
};
for (const directory of [env.TEMP, env.LOCALAPPDATA, env.PNPM_HOME])
  fs.mkdirSync(directory, { recursive: true });
const patch = path.join(root, "test.patch.yml");
fs.writeFileSync(
  patch,
  [
    "- id: paper-workbench",
    "  config:",
    "    dataRoot: " + JSON.stringify(data.replaceAll("\\", "/")),
    "    autoRead: false",
    "    autoIndex: false",
    "- id: llm-deepseek",
    "  config:",
    '    baseURL: "http://127.0.0.1:9"',
    "",
  ].join("\n"),
);
let log = "",
  child,
  browser;
function start(args) {
  const proc = spawn(exe, ["--expose-internals", cli, ...args], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [proc.stdout, proc.stderr])
    stream.on("data", (data) => {
      log = (log + data.toString()).slice(-64000);
    });
  return proc;
}
async function until(read, label, ms = 30000) {
  const deadline = Date.now() + ms;
  do {
    const value = await read();
    if (value) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw Error("Timed out waiting for " + label);
}
const note = (id) => ({
  id,
  type: "note",
  sortIndex: "00000|00001|00000",
  color: "#ffcc00",
  position: { pageIndex: 0, rects: [[30, 30, 50, 50]] },
  comment: id,
  text: "",
  tags: [],
  dateCreated: "2026-01-01T00:00:00Z",
  dateModified: "2026-01-01T00:00:00Z",
  authorName: "QA",
  pageLabel: "1",
});
async function seed() {
  let Store = SqliteStore;
  if (values.previous) {
    execFileSync(
      "tar.exe",
      [
        "-xzf",
        absolute("previous"),
        "-C",
        root,
        "package/resources/backend/src",
      ],
      { windowsHide: true },
    );
    ({ SqliteStore: Store } = await import(
      pathToFileURL(
        path.join(
          root,
          "package/resources/backend/src/storage/sqlite-store.mjs",
        ),
      )
    ));
  }
  const store = new Store(path.join(data, "library.sqlite"));
  try {
    const original = fs.readFileSync(absolute("fixture"));
    const probe = new ImportService({
      store,
      dataRoot: data,
      vendorRoot: path.join(projectRoot, "third_party/zotero-document-worker"),
    });
    const { pages } = await probe.probe(absolute("fixture"));
    assert.ok(
      pages >= 2,
      "Use a synthetic fixture with at least two pages and selectable text on page two",
    );
    const docs = [];
    for (const title of ["Alpha", "Beta"]) {
      const bytes = Buffer.concat([
        original,
        Buffer.from("\n%" + title + "\n"),
      ]);
      const sha = createHash("sha256").update(bytes).digest("hex"),
        name = title + ".pdf";
      fs.writeFileSync(path.join(files, name), bytes);
      const id = store.addAttachment(
        {
          id: title,
          originalName: name,
          pdfTitle: title + " paper",
          sha256: sha,
          pages,
          bytes: bytes.length,
        },
        "files/" + name,
      );
      const job = store.agents.claim(
        store.agents.enqueue(id, {
          kind: "research",
          instruction: "Read fixture",
        }).id,
      );
      store.agents.recordReads(
        job.session_id,
        [{ pageIndex: 0, text: title, source: "native" }],
        { id: job.id, token: job.lease_token },
      );
      store.agents.publish(
        job.id,
        job.lease_token,
        {
          topic: title + " summary",
          scientificQuestion: "q",
          methods: "m",
          argument: "a",
          findings: "f",
          limitations: "l",
          openQuestions: "o",
          evidencePages: [0],
        },
        2,
      );
      docs.push({ id, sha, title });
    }
    const [a, b] = docs;
    store.apply(b.id, {
      requestId: randomUUID(),
      expectedRevision: 0,
      sourceHash: b.sha,
      upserts: [note("savedNote")],
      deletions: [],
    });
    const oldest = store.agents.enqueue(a.id, {
      kind: "research",
      instruction: "Oldest active fixture",
    });
    store.db
      .prepare("UPDATE paper_jobs SET created_at='2000-01-01' WHERE id=?")
      .run(oldest.id);
    store.agents.claim(oldest.id);
    for (let i = 1; i < 60; i++)
      store.agents.enqueue(a.id, {
        kind: "research",
        instruction: "Queued fixture " + i,
      });
    store.db
      .prepare(
        "INSERT OR REPLACE INTO library_settings VALUES('index_paused','1')",
      )
      .run();
    return { a, b, oldest: oldest.id };
  } finally {
    store.close();
  }
}
try {
  const { a, b, oldest } = await seed();
  const install = start([
    "plugin",
    "--profile",
    "web",
    "add",
    absolute("archive"),
  ]);
  assert.equal(
    await new Promise((resolve, reject) => {
      install.on("error", reject);
      install.on("exit", resolve);
    }),
    0,
    "DSH local archive installation",
  );
  log = "";
  child = start([
    "web",
    "--patch",
    patch,
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--no-open",
  ]);
  const url = await until(
    () => log.match(/^dsh web: (https?:\/\/\S+)/m)?.[1],
    "isolated DSH",
    45000,
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: absolute("browser"),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.setDefaultTimeout(30000);
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("文献工作台").waitFor();
  if (
    await button("继续")
      .waitFor({ timeout: 7000 })
      .then(
        () => true,
        () => false,
      )
  )
    await button("继续").click();
  await button("文献工作台").click();
  const frame = page.frameLocator(".pw-frame");
  await frame.locator(".read-link").first().waitFor();
  const health = await page.evaluate(async () => (await fetch("/paper-workbench/api/health")).json());
  assert.equal(path.resolve(health.dataRoot), path.resolve(data));
  assert.equal(health.schemaVersion, 6);
  if (values.previous) assert.ok(fs.readdirSync(path.join(data,"backups")).some(name => name.startsWith("before-schema-5-to-6-")));
  const api = (route) =>
    page.evaluate(
      async (route) => (await fetch("/paper-workbench/api/" + route)).json(),
      route,
    );
  const jobs = button("初读与任务");
  await until(
    () => jobs.innerText().then((t) => t.includes("60")),
    "complete queue count",
  );
  await jobs.click();
  assert.equal((await api("agents/status")).jobs[0].id, oldest);
  assert.equal(await button("打开论文").count(), 62);
  console.log("PASS all 60 active jobs and the oldest running job are visible");
  const completed = (title) =>
    page
      .getByText(title + " paper", { exact: true })
      .locator("..")
      .filter({ has: button("查看摘要") });
  await completed("Alpha").getByRole("button", { name: "查看摘要" }).click();
  await page.getByText("Alpha summary", { exact: false }).first().waitFor();
  await page.getByText("《Alpha paper》", { exact: false }).waitFor();
  await page.evaluate(
    ({ id, sha, mutation }) =>
      localStorage.setItem(
        "paper-workbench:draft:v1:" + id,
        JSON.stringify({
          schemaVersion: 1,
          sourceHash: sha,
          queue: [{ mutation }],
        }),
      ),
    {
      ...b,
      mutation: {
        requestId: randomUUID(),
        expectedRevision: 0,
        sourceHash: b.sha,
        upserts: [note("unsavedNote")],
        deletions: [],
      },
    },
  );
  await completed("Beta").getByRole("button", { name: "打开论文" }).click();
  await page
    .locator(".pw-reader-title #document-title")
    .waitFor({ timeout: 65000 });
  assert.equal(
    await page.locator(".pw-reader-title #document-title").innerText(),
    "Beta paper",
  );
  assert.equal(
    await page.getByText("Alpha summary", { exact: false }).count(),
    0,
  );
  console.log(
    "PASS the summary identifies its source and closes on paper change",
  );
  const status = page.locator(".pw-reader-actions #save-status");
  assert.equal(await status.getAttribute("data-state"), "conflict");
  assert.deepEqual(
    (await api("documents/" + b.id)).snapshot.annotations.map((n) => n.id),
    ["savedNote"],
  );
  await frame.locator("body").evaluate(() => { window.qaOldReader = window.workbench.adapter; });
  page.once("dialog", (dialog) => dialog.accept());
  await button("合并草稿").click();
  await until(
    async () =>
      (await api("documents/" + b.id)).snapshot.annotations.length === 2 &&
      (await status.getAttribute("data-state")) === "saved" &&
      await frame.locator("body").evaluate(() => window.workbench.adapter !== window.qaOldReader &&
        Boolean(window.workbench.adapter?.pdfApplication && window.workbench.adapter.timer)),
    "both acknowledged annotations",
  );
  console.log(
    "PASS the old draft shows conflict and an explicit merge preserves both notes",
  );
  await jobs.click();
  await frame.locator("body").evaluate(async () => {
    const a = window.workbench.adapter;
    a.reader.toggleVerticalSplit(true);
    await a.reader._secondaryView.initializedPromise;
    const viewer =
      a.reader._secondaryView._iframeWindow.PDFViewerApplication.pdfViewer;
    viewer.currentScaleValue = "page-fit";
    viewer.currentPageNumber = 2;
    a.reader.focusView(false);
  });
  const selected = await until(
    () =>
      frame.locator("body").evaluate(() => {
        const a = window.workbench.adapter,
          view = a.reader._secondaryView._iframeWindow;
        const text = [
          ...view.document.querySelectorAll(
            '.page[data-page-number="2"] .textLayer span',
          ),
        ].find((n) => n.textContent.trim().length > 1);
        if (!text) return null;
        const range = view.document.createRange();
        range.selectNodeContents(text);
        const selection = view.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return selection.toString().trim();
      }),
    "text in the second pane",
  );
  await page.evaluate(() =>
    window.addEventListener("message", (e) => {
      if (e.data?.type === "paper-workbench:ai")
        window.qaSelection = e.data.context;
    }),
  );
  await button("阅读工具").click();
  await button("就此提问").click();
  const context = await until(
    () => page.evaluate(() => window.qaSelection),
    "paper question",
  );
  assert.equal(context.pageIndex, 1);
  assert.equal(context.selection.text, selected);
  console.log(
    "PASS native question receives the selected text and page from the second pane",
  );
  await button("文献库").click();
  await frame
    .locator("tr")
    .filter({ hasText: "Alpha paper" })
    .locator(".paper-title")
    .click();
  await frame.locator('#details [data-action="change-archive"]').click();
  await frame.locator('dialog[open] button[type="submit"]').click();
  await until(
    () =>
      frame
        .locator("#count-trash")
        .innerText()
        .then((n) => n === "1"),
    "archive",
  );
  await frame
    .locator("#file-input")
    .setInputFiles(path.join(files, "Alpha.pdf"));
  const dialog = frame.locator("dialog[open]");
  await dialog.getByText("此 PDF 已在回收站").waitFor();
  await dialog.getByRole("button", { name: "恢复到文献库" }).click();
  await dialog.getByText("已恢复到文献库", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "完成" }).click();
  await until(
    () =>
      frame
        .locator("#count-trash")
        .innerText()
        .then((n) => n === "0"),
    "restore",
  );
  assert.ok((await api("documents")).some((d) => d.id === a.id));
  console.log("PASS duplicate import restores the original archived item");
  await button("工具").click();
  await frame.locator('button[data-ocr="' + b.id + '"]').click();
  await frame.locator('input[value="force-ocr"]').check();
  await frame.getByRole("button", { name: "加入识别队列" }).click();
  await until(
    async () =>
      (await api("index/status")).jobs.some(
        (j) =>
          j.attachment_id === b.id &&
          j.mode === "force-ocr" &&
          j.status === "queued",
      ),
    "durable OCR upgrade",
  );
  await frame.locator("#index-pause").click();
  await until(async () => {
    const index = await api("index/status");
    const job = index.jobs.find(j => j.attachment_id === b.id && j.mode === "force-ocr");
    if (job?.status === "failed") throw Error(job.error);
    return job?.status === "done" && index.documents.find(d => d.id === b.id)?.ocrPages > 0;
  }, "completed OCR with recognized text", 180000);
  console.log("PASS the OCR action upgrades the extraction job and the bundled engine recognizes the PDF");
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await Promise.race([exited, delay(3000)]);
  }
  await delay(2500);
  const actual = fs.realpathSync(root);
  if (
    path.dirname(actual).toLowerCase() ===
      fs.realpathSync(os.tmpdir()).toLowerCase() &&
    path.basename(actual).startsWith("pw-release-qa-")
  )
    fs.rmSync(actual, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
}
