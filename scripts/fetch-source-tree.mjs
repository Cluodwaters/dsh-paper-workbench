import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// Download build-relevant source at pinned commits, excluding upstream PDF fixtures.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const specs = JSON.parse(
  await readFile(path.join(root, "sources.download.json"), "utf8"),
);
const cache = path.join(root, ".cache", "source-blobs");
await mkdir(cache, { recursive: true });
let done = 0;
const failures = [];
// Optional ML models are outside the phase-1 PDF writer path and are not needed.
const jobs = specs.flatMap((spec) =>
  spec.files
    .filter((file) => !file.path.endsWith(".onnx"))
    .map((file) => ({ spec, file })),
);
const inFlight = new Map();

function gitHash(data) {
  return createHash("sha1")
    .update(`blob ${data.length}\0`)
    .update(data)
    .digest("hex");
}
async function blob(spec, file) {
  if (inFlight.has(file.sha)) return inFlight.get(file.sha);
  const promise = (async () => {
    const cachePath = path.join(cache, file.sha);
    try {
      const local = await readFile(
        path.join(root, spec.destination, file.path),
      );
      if (gitHash(local) === file.sha) {
        await writeFile(cachePath, local);
        return local;
      }
    } catch {}
    try {
      const data = await readFile(cachePath);
      if (gitHash(data) === file.sha) return data;
    } catch {}
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const url = `https://raw.githubusercontent.com/${spec.repo}/${spec.commit}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
        const response = await fetch(url, {
          signal: AbortSignal.timeout(90000),
        });
        if (!response.ok) throw new Error(`${response.status} ${url}`);
        const data = Buffer.from(await response.arrayBuffer());
        if (gitHash(data) !== file.sha)
          throw new Error(`Git blob integrity mismatch: ${file.path}`);
        await writeFile(cachePath, data);
        return data;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  })();
  inFlight.set(file.sha, promise);
  return promise;
}
async function run() {
  while (jobs.length) {
    const { spec, file } = jobs.shift();
    try {
      const destRoot = path.resolve(root, spec.destination);
      const target = path.resolve(destRoot, file.path);
      if (
        !destRoot.startsWith(path.join(root, "third_party") + path.sep) ||
        !target.startsWith(destRoot + path.sep)
      )
        throw new Error("Unsafe source destination");
      const data = await blob(spec, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
      done++;
      if (done % 100 === 0)
        console.log(`Verified ${done} source files; ${jobs.length} queued`);
    } catch (error) {
      failures.push({ repo: spec.repo, path: file.path, error: String(error) });
    }
  }
}
await Promise.all(Array.from({ length: 16 }, run));
await writeFile(
  path.join(root, "output", "source-download-results.json"),
  JSON.stringify({ done, failures }, null, 2),
);
console.log(JSON.stringify({ done, failures }));
if (failures.length) process.exitCode = 1;
