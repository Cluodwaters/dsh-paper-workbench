import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { projectRoot } from "../src/config.mjs";
const require = createRequire(import.meta.url),
  { _electron } = require(
    process.env.PAPER_WORKBENCH_PLAYWRIGHT || "playwright",
  );
const executablePath = process.env.PAPER_WORKBENCH_DESKTOP_EXE,
  profile = path.join(projectRoot, "data/desktop-qa-profile"),
  library = path.join(projectRoot, "data/stage3-qa");
const launch = () =>
  _electron.launch({
    executablePath,
    args: ["--profile", profile, "--library", library],
    timeout: 60000,
  });
let app = await launch();
const page = await app.firstWindow({ timeout: 60000 });
await page.waitForSelector("#result-total");
const origin = new URL(page.url()).origin;
const api = async (route, data) => {
  const response = await fetch(
    origin + route,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Paper-Workbench": "1",
          },
          body: JSON.stringify(data),
        },
  );
  const body = await response.json();
  if (!response.ok) throw new Error(body.error.message);
  return body;
};
const docs = await api("/api/documents"),
  long = docs.find((d) => d.sampleKey === "sample-01");
assert.equal(long.pages, 211);
const [job] = await api("/api/index/queue", {
  ids: [long.id],
  mode: "force-ocr",
});
let deadline = Date.now() + 90000,
  checkpoint;
while (true) {
  const status = await api("/api/index/status");
  const j = status.jobs.find((j) => j.id === job.id);
  if (j.status === "failed") throw new Error(j.error);
  if (j.completedPages >= 1) {
    checkpoint = j.completedPages;
    break;
  }
  if (Date.now() > deadline) throw new Error("No durable OCR checkpoint");
  await new Promise((r) => setTimeout(r, 100));
}
const health = await api("/api/health");
assert.ok(health.desktopParentPid);
process.kill(health.desktopParentPid);
app = null;
deadline = Date.now() + 20000;
let stopped = false;
while (Date.now() < deadline) {
  try {
    await api("/api/health");
  } catch {
    stopped = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 150));
}
assert.ok(stopped, "Owned backend did not stop after desktop interruption");
try {
  app = await launch();
  const restored = await app.firstWindow({ timeout: 60000 });
  await restored.waitForSelector("#result-total");
  assert.equal(new URL(restored.url()).origin, origin);
  const status = await api("/api/index/status"),
    resumed = status.jobs.find((j) => j.id === job.id);
  assert.ok(["running", "queued"].includes(resumed.status));
  assert.ok(resumed.completedPages >= checkpoint);
  await api("/api/index/cancel", { id: job.id });
  const after = await api("/api/index/status");
  assert.ok(after.documents.find((d) => d.id === long.id).indexedAt);
  const annotations = (await api("/api/documents")).reduce(
    (n, d) => n + d.annotationCount,
    0,
  );
  assert.equal(annotations, 102);
  const result = {
    passed: true,
    backendStopped: true,
    originRestored: true,
    checkpointBeforeCrash: checkpoint,
    checkpointAfterRestart: resumed.completedPages,
    oldIndexPreserved: true,
    annotationsPreserved: annotations,
  };
  writeFileSync(
    path.join(projectRoot, "output/stage3-desktop-crash.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await app?.close();
}
