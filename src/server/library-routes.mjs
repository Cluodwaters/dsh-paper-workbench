import { ImportService } from "../application/import-service.mjs";
import { CrossrefMetadataProvider } from "../adapters/metadata/crossref.mjs";
import { requireValue } from "../domain/errors.mjs";
import path from "node:path";

export function createLibraryRoutes({
  store,
  dataRoot,
  projectRoot,
  vendorRoot,
  json,
  body,
  profileLabel,
  maxPdfBytes,
  onImport,
}) {
  const library = store.library;
  const imports = new ImportService({
    store,
    dataRoot,
    vendorRoot,
    maxBytes: maxPdfBytes,
  });
  const metadata = new CrossrefMetadataProvider();
  return async function handle(request, response, route) {
    if (!route.startsWith("/api/library/")) return false;
    let result, match;
    if (route === "/api/library/info" && request.method === "GET")
      result = {
        libraryId: store.db
          .prepare("SELECT value FROM library_settings WHERE key='library_id'")
          .get().value,
        label: profileLabel || "我的文献库",
        counts: library.counts(),
        savedSearches: library.searches(),
        maxPdfBytes: imports.maxBytes,
        importExclusions: {
          projectFolder: path.basename(projectRoot),
          generatedFolders: [
            "data",
            "output",
            "third_party",
            ".cache",
            ".playwright-cli",
          ],
        },
      };
    else if (route === "/api/library/search" && request.method === "POST") {
      const input = await body(request);
      result = library.search(input.query, input.page);
    } else if (
      (match = route.match(/^\/api\/library\/items\/([a-f0-9-]+)$/)) &&
      request.method === "GET"
    )
      result = library.get(match[1]);
    else if (
      (match = route.match(/^\/api\/library\/items\/([a-f0-9-]+)$/)) &&
      request.method === "POST"
    )
      result = library.update(match[1], await body(request));
    else if (route === "/api/library/items" && request.method === "POST")
      result = library.create(await body(request));
    else if (route === "/api/library/batch" && request.method === "POST")
      result = library.batch(await body(request));
    else if (route === "/api/library/searches" && request.method === "GET")
      result = library.searches();
    else if (route === "/api/library/searches" && request.method === "POST")
      result = library.saveSearch(await body(request));
    else if (
      route === "/api/library/searches/delete" &&
      request.method === "POST"
    )
      result = library.deleteSearch(await body(request));
    else if (
      route === "/api/library/journal-aliases" &&
      request.method === "GET"
    )
      result = library.aliases();
    else if (
      route === "/api/library/journal-aliases" &&
      request.method === "POST"
    )
      result = library.setAlias(await body(request));
    else if (route === "/api/library/metadata/doi" && request.method === "POST")
      result = await metadata.lookup((await body(request)).doi);
    else if (route === "/api/library/import-pdf" && request.method === "POST") {
      let name;
      try {
        name = decodeURIComponent(request.headers["x-file-name"] || "");
      } catch {
        name = "";
      }
      result = await imports.import(request, name, {
        itemId: request.headers["x-item-id"] || undefined,
      });
      onImport?.();
    } else if (
      route === "/api/library/export-csl" &&
      request.method === "POST"
    ) {
      const input = await body(request);
      requireValue(
        Array.isArray(input.ids) && input.ids.length <= 200,
        "EXPORT_ITEMS",
        "请选择最多 200 条文献。",
      );
      result = input.ids.map((id) => library.get(id).csl);
    } else return false;
    json(response, 200, result);
    return true;
  };
}
