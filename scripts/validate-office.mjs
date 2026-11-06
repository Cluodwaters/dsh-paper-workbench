import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { projectRoot } from "../src/config.mjs";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";
import { CitationService } from "../src/application/citation-service.mjs";
const directory = path.join(projectRoot, "output/office-qa");
mkdirSync(directory, { recursive: true });
const hostExe = path.join(
    process.env.PAPER_WORKBENCH_QA_BIN || directory,
    "OfficeQaHost.exe",
  ),
  filename = path.join(
    directory,
    `PaperWorkbench-QA-citations-${Date.now()}.docx`,
  );
const compile = spawnSync(
  "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  [
    "/nologo",
    "/r:Microsoft.CSharp.dll",
    "/r:System.Core.dll",
    "/r:System.Web.Extensions.dll",
    "/out:" + hostExe,
    path.join(projectRoot, "scripts/office-qa-host.cs"),
    path.join(projectRoot, "desktop/office-bridge/OfficeSession.cs"),
  ],
  { windowsHide: true, encoding: "utf8" },
);
if (compile.status) throw new Error(compile.stdout + compile.stderr);
const tempDirectory = path.join(directory, "temp");
mkdirSync(tempDirectory, { recursive: true });
const host = spawn(hostExe, [filename], {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, TEMP: tempDirectory, TMP: tempDirectory },
});
host.stderr.on("data", (chunk) => process.stderr.write(chunk));
const lines = readline.createInterface({ input: host.stdout }),
  queue = [],
  waiting = [];
lines.on("line", (line) => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("QA host invalid output " + line);
  }
  if (waiting.length) waiting.shift()(value);
  else queue.push(value);
});
const next = () =>
  queue.length
    ? Promise.resolve(queue.shift())
    : new Promise((resolve) => waiting.push(resolve));
async function call(action, extra = {}) {
  host.stdin.write(JSON.stringify({ action, ...extra }) + "\n");
  const r = await next();
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
const report = { checks: [], filename };
const check = (name, fn) => {
  fn();
  report.checks.push(name);
  console.log("PASS", name);
};
const store = new SqliteStore(path.join(directory, "bibliography.sqlite"));
const itemA = store.library.create({
  requestId: randomUUID(),
  metadata: {
    title: "Thermal transport in liquid metals",
    authors: [{ family: "Smith", given: "Alice" }],
    year: 2024,
    journal: "Journal of Example Research",
    volume: "12",
    issue: "3",
    pages: "41-52",
    type: "article-journal",
  },
});
const itemB = store.library.create({
  requestId: randomUUID(),
  metadata: {
    title: "熔融金属密度的实验方法",
    authors: [{ literal: "张三" }, { literal: "李四" }],
    year: 2023,
    journal: "示例材料学报",
    volume: "8",
    pages: "101-109",
    type: "article-journal",
  },
});
const service = new CitationService({ store, projectRoot });
if (process.env.PAPER_WORKBENCH_QA_BIN)
  service.connector.executable = path.join(
    process.env.PAPER_WORKBENCH_QA_BIN,
    "PaperWorkbench.OfficeBridge.exe",
  );
async function prepare(action, items = [], style = "gb-t-7714-2015") {
  const p = await service.prepare({
    application: "word",
    action,
    style,
    items: items.map((id) => ({ id })),
  });
  assert.equal(
    p.target.name,
    path.basename(filename),
    "Refusing to modify a non-QA document",
  );
  return p;
}
try {
  const start = await next();
  console.log("Word QA startup:", JSON.stringify(start));
  assert.equal(start.ok, true, start.error);
  report.wordVersion = start.version;
  await call("otherField");
  await call("select", { text: "First citation follows: " });
  const p1 = await prepare("insert", [itemA.id]);
  assert.equal(p1.citation, "[1]");
  await service.apply(p1.planId);
  const first = await call("text");
  check("real Word citation field inserted and locked", () => {
    assert.match(first.text, /First citation follows: \[1\]/);
    assert.equal(
      first.fields.filter((f) => f.code.includes("PW_CITE")).length,
      1,
    );
    assert.ok(first.fields.every((f) => f.locked));
  });
  const replay = await service.apply(p1.planId);
  check("acknowledged apply is idempotent", () =>
    assert.equal(replay.inserted, true),
  );
  await call("select", { text: "Second citation follows: " });
  const p2 = await prepare("insert", [itemB.id]);
  await service.apply(p2.planId);
  await call("select", { text: "Repeated citation follows: " });
  const p3 = await prepare("insert", [itemA.id, itemB.id]);
  await service.apply(p3.planId);
  await call("select", { text: "参考文献" });
  const pb = await prepare("bibliography");
  await service.apply(pb.planId);
  const all = await call("text");
  check(
    "multiple and repeated citations share numbers and bibliography deduplicates",
    () => {
      assert.match(all.text, /Second citation follows: \[2\]/);
      assert.equal(
        all.fields.filter((f) => f.code.includes("PW_CITE")).length,
        3,
      );
      assert.equal(pb.bibliographyCount, 2);
      assert.match(all.text, /Other application field/);
      assert.match(all.text, /Greek α β 保持不变/);
    },
  );
  await call("save");
  await call("reopen");
  const restored = await call("text");
  check(
    "docx save and reopen preserves field codes and displayed results",
    () => assert.deepEqual(restored.fields, all.fields),
  );
  const citationB = restored.fields.find(
    (f) => f.text === "[2]" && f.code.includes("PW_CITE"),
  );
  await call("delete", { index: citationB.index });
  const firstField = (await call("text")).fields.find((f) =>
    f.code.includes("PW_CITE"),
  );
  await call("delete", { index: firstField.index });
  // Only the group A+B remains; then delete it too and reinsert B first to test renumbering.
  const group = (await call("text")).fields.find((f) =>
    f.code.includes("PW_CITE"),
  );
  await call("delete", { index: group.index });
  await call("select", { text: "Second citation follows: " });
  const onlyB = await prepare("insert", [itemB.id]);
  await service.apply(onlyB.planId);
  const renumbered = await call("text");
  check(
    "deletions remove uncited bibliography items and renumber remaining citations",
    () => {
      assert.match(renumbered.text, /Second citation follows: \[1\]/);
      assert.equal(onlyB.bibliographyCount, 1);
      assert.doesNotMatch(
        renumbered.fields.find((f) => f.code.includes("PW_BIB")).text,
        /Thermal transport/,
      );
    },
  );
  const stale = await prepare("refresh");
  await call("moveEnd");
  await assert.rejects(() => service.apply(stale.planId), /变化/);
  report.checks.push("stale document or cursor rejects writing");
  await call("track", { enabled: true });
  const track = await prepare("refresh");
  await assert.rejects(() => service.apply(track.planId), /修订/);
  await call("track", { enabled: false });
  report.checks.push("track-changes mode is not silently disabled");
  const apa = await prepare("refresh", [], "apa");
  await service.apply(apa.planId);
  const apaText = await call("text");
  check("style switching recomputes existing fields through CSL", () => {
    assert.match(
      apaText.fields.find((f) => f.code.includes("PW_CITE")).text,
      /2023/,
    );
    assert.doesNotMatch(
      apaText.fields.find((f) => f.code.includes("PW_CITE")).text,
      /\[1\]/,
    );
  });
  await call("undo");
  const undo = await call("text");
  check("one native Word undo restores the entire reference update", () =>
    assert.equal(
      undo.fields.find((f) => f.code.includes("PW_CITE")).text,
      "[1]",
    ),
  );
  await call("save");
  await call("reopen");
  const refresh = await prepare("refresh");
  await service.apply(refresh.planId);
  await call("save");
  await call("export", {
    path: path.join(directory, "PaperWorkbench-QA-citations.pdf"),
  });
  report.status = "passed";
  writeFileSync(
    path.join(directory, "results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error);
  throw error;
} finally {
  if (host.exitCode === null)
    try {
      await Promise.race([
        call("quit"),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {}
  host.stdin.end();
  store.close();
}
