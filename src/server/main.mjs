import http from "node:http";
import {
  createReadStream,
  readFileSync,
  existsSync,
  statSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { SqliteStore } from "../storage/sqlite-store.mjs";
import { ExportService } from "../application/export-service.mjs";
import { PdfSourceService } from "../application/pdf-source-service.mjs";
import { AppError, requireValue } from "../domain/errors.mjs";
import { projectRoot, dataRoot, databasePath, port } from "../config.mjs";
import { createLibraryRoutes } from "./library-routes.mjs";
import { SCHEMA_VERSION } from "../storage/migrations.mjs";
import { IndexService } from "../application/index-service.mjs";
import { createIndexRoutes } from "./index-routes.mjs";
import { CitationService } from "../application/citation-service.mjs";
import { createCitationRoutes } from "./citation-routes.mjs";
import { lockLibrary } from "../storage/library-lock.mjs";
import { integrationConfig } from "./integration.mjs";
import { AiContextService } from "../application/ai-context-service.mjs";
import { createAiRoutes } from "./ai-routes.mjs";
import { PaperAgentService } from "../application/paper-agent-service.mjs";
import { createAgentRoutes } from "./agent-routes.mjs";

const integration = integrationConfig();
const releaseLibrary = lockLibrary(dataRoot);
process.on("exit", releaseLibrary);
const store = new SqliteStore(databasePath, { autoRead: Boolean(integration.info.authenticated) && process.env.PAPER_WORKBENCH_AUTO_READ === '1' });
const indexer = new IndexService({ store, projectRoot, dataRoot });
const exporter = new ExportService({
  store,
  dataRoot,
  vendorRoot: path.join(projectRoot, "third_party/zotero-document-worker"),
});
const sources = new PdfSourceService({
  dataRoot,
  vendorRoot: path.join(projectRoot, "third_party/zotero-document-worker"),
});
const publicRoot = path.join(projectRoot, "src/web");
const vendorRoot = path.join(
  projectRoot,
  "third_party/zotero-reader/build/web",
);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".ftl": "text/plain; charset=utf-8",
};
function json(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}
function safePath(root, relative) {
  const full = path.resolve(root, relative);
  requireValue(
    full.startsWith(path.resolve(root) + path.sep),
    "PATH",
    "Invalid path",
    403,
  );
  return full;
}
function serveFile(response, filename, downloadName) {
  requireValue(
    existsSync(filename) && statSync(filename).isFile(),
    "NOT_FOUND",
    "File not found",
    404,
  );
  const headers = {
    "Content-Type": mime[path.extname(filename)] || "application/octet-stream",
    "Content-Length": statSync(filename).size,
    "Cache-Control": "no-store",
  };
  if (downloadName)
    headers["Content-Disposition"] =
      `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  response.writeHead(200, headers);
  createReadStream(filename).pipe(response);
}
async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    requireValue(
      size <= 12_000_000,
      "BODY_TOO_LARGE",
      "Request body too large",
      413,
    );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("INVALID_JSON", "Invalid JSON body");
  }
}
const libraryRoutes = createLibraryRoutes({
  store,
  dataRoot,
  projectRoot,
  vendorRoot: path.join(projectRoot, "third_party/zotero-document-worker"),
  json,
  body,
  profileLabel: process.env.PAPER_WORKBENCH_LABEL,
  maxPdfBytes: Number(process.env.PAPER_WORKBENCH_MAX_PDF_MB || 200) * 1048576,
  onImport: () => indexer.enqueueMissing(),
});
const indexRoutes = createIndexRoutes({ indexer, store, json, body });
const aiRoutes = createAiRoutes({
  context: new AiContextService({ store, dataRoot }),
  json,
  body,
});
const agentRoutes = createAgentRoutes({ service: new PaperAgentService({store,indexer,context:new AiContextService({store,dataRoot})}),json,body });
const citationRoutes = createCitationRoutes({
  citations: new CitationService({ store, projectRoot }),
  json,
  body,
});
const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  );
  try {
    integration.authorize(request);
    requireValue(
      [`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host),
      "HOST",
      "Invalid local host",
      403,
    );
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const route = integration.route(decodeURIComponent(url.pathname));
    if (request.method === "POST") {
      requireValue(
        request.headers["x-paper-workbench"] === "1",
        "LOCAL_REQUEST",
        "Missing local application header",
        403,
      );
      if (request.headers.origin)
        requireValue(
          [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(
            request.headers.origin,
          ),
          "ORIGIN",
          "Cross-origin writes are not allowed",
          403,
        );
      if (route !== "/api/library/import-pdf")
        requireValue(
          (request.headers["content-type"] || "").startsWith(
            "application/json",
          ),
          "CONTENT_TYPE",
          "JSON request required",
          415,
        );
    }
    if (route === "/api/health")
      return json(response, 200, {
        status: "ok",
        application: "paper-workbench",
        phase: 3,
        pid: process.pid,
        schemaVersion: SCHEMA_VERSION,
        reader: "zotero-reader@293d7e1",
        integration: integration.info,
        dataRoot,
        desktopParentPid:
          Number(process.env.PAPER_WORKBENCH_PARENT_PID) || null,
      });
    if (route === "/api/shutdown" && request.method === "POST") {
      const input = await body(request);
      requireValue(
        input.expectedPid === process.pid,
        "PROCESS_CHANGED",
        "Server process changed",
        409,
      );
      json(response, 200, { stopping: true });
      setImmediate(stop);
      return;
    }
    if (await libraryRoutes(request, response, route)) return;
    if (await indexRoutes(request, response, route, url)) return;
    if (await aiRoutes(request, response, route, url)) return;
    if (await agentRoutes(request, response, route, url)) return;
    if (await citationRoutes(request, response, route)) return;
    if (route === "/api/documents" && request.method === "GET")
      return json(response, 200, store.list());
    let match;
    if (
      (match = route.match(/^\/api\/documents\/([a-f0-9-]+)$/)) &&
      request.method === "GET"
    )
      return json(response, 200, {
        attachment: store.document(match[1]),
        snapshot: store.snapshot(match[1]),
        readingState: store.readingState(match[1]),
        embeddedAnnotations: await sources.inspect(store.attachment(match[1])),
      });
    if (
      (match = route.match(/^\/api\/pdf\/([a-f0-9-]+)$/)) &&
      request.method === "GET"
    )
      return serveFile(
        response,
        safePath(dataRoot, store.attachment(match[1]).managedPath),
      );
    if (
      (match = route.match(/^\/api\/annotations\/([a-f0-9-]+)$/)) &&
      request.method === "POST"
    )
      return json(response, 200, store.apply(match[1], await body(request)));
    if (
      (match = route.match(/^\/api\/state\/([a-f0-9-]+)$/)) &&
      request.method === "POST"
    ) {
      const input = await body(request);
      store.saveReadingState(match[1], input.view, input.state);
      return json(response, 200, { saved: true });
    }
    if (
      (match = route.match(/^\/api\/export\/([a-f0-9-]+)$/)) &&
      request.method === "POST"
    ) {
      const input = await body(request);
      return json(
        response,
        200,
        await exporter.export(match[1], input.expectedRevision),
      );
    }
    if (
      (match = route.match(/^\/api\/exports\/([a-f0-9-]+)$/)) &&
      request.method === "GET"
    ) {
      const record = store.getExport(match[1]);
      return serveFile(
        response,
        safePath(dataRoot, record.relative_path),
        url.searchParams.get("inline") === "1"
          ? undefined
          : path.basename(record.relative_path),
      );
    }
    if (route === "/favicon.ico") {
      response.writeHead(204);
      return response.end();
    }
    requireValue(request.method === "GET", "METHOD", "Unsupported method", 405);
    if (route.startsWith("/vendor/"))
      return serveFile(
        response,
        safePath(vendorRoot, route.slice("/vendor/".length)),
      );
    if (route.startsWith("/shared/")) {
      const name = route.slice("/shared/".length);
      requireValue(
        [
          "bibliography.mjs",
          "library-query.mjs",
          "metadata-candidates.mjs",
          "import-selection.mjs",
          "errors.mjs",
        ].includes(name),
        "NOT_FOUND",
        "File not found",
        404,
      );
      return serveFile(
        response,
        safePath(path.join(projectRoot, "src/domain"), name),
      );
    }
    return serveFile(
      response,
      safePath(publicRoot, route === "/" ? "index.html" : route.slice(1)),
    );
  } catch (error) {
    if (!response.headersSent)
      json(response, error.status || 500, {
        error: { code: error.code || "INTERNAL", message: error.message },
      });
    else response.destroy();
  }
});
server.listen(port, "127.0.0.1", () => {
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(
    path.join(dataRoot, "server-session.json"),
    JSON.stringify(
      { pid: process.pid, port, dataRoot, startedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log(
    `Paper Workbench: http://127.0.0.1:${port} (${store.list().length} documents; schema ${SCHEMA_VERSION})`,
  );
  if (process.env.PAPER_WORKBENCH_AUTO_INDEX !== "0") indexer.enqueueMissing();
});
let stopping = false;
let parentWatcher;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(parentWatcher);
  await indexer.close();
  server.close(() => {
    store.close();
    process.exitCode = 0;
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const parentPid = Number(process.env.PAPER_WORKBENCH_PARENT_PID);
if (Number.isInteger(parentPid) && parentPid > 0) {
  parentWatcher = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      if (error.code === "ESRCH") stop();
    }
  }, 2000);
  parentWatcher.unref();
}
