export function createIndexRoutes({ indexer, store, json, body }) {
  return async (request, response, route, url) => {
    if (!route.startsWith("/api/index/")) return false;
    let result, match;
    if (route === "/api/index/status" && request.method === "GET")
      result = indexer.status();
    else if (route === "/api/index/queue" && request.method === "POST") {
      const input = await body(request);
      const ids =
        input.ids ||
        store.db
          .prepare(
            "SELECT a.id FROM attachments a JOIN item_metadata m ON m.item_id=a.item_id WHERE m.archived_at IS NULL",
          )
          .all()
          .map((r) => r.id);
      result = indexer.enqueue(ids, input.mode || "text");
    } else if (route === "/api/index/pause" && request.method === "POST")
      result = indexer.setPaused((await body(request)).paused);
    else if (route === "/api/index/cancel" && request.method === "POST")
      result = indexer.cancel((await body(request)).id);
    else if (route === "/api/index/retry" && request.method === "POST")
      result = indexer.retry((await body(request)).id);
    else if (
      (match = route.match(/^\/api\/index\/text\/([a-f0-9-]+)$/)) &&
      request.method === "GET"
    ) {
      const pages = store.fulltext.pages(match[1]);
      if (url.searchParams.get("download") === "1") {
        response.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="paper-text.txt"',
        });
        response.end(
          "\ufeff" +
            pages
              .map(
                (p) =>
                  `--- 第 ${p.pageIndex + 1} 页 ---\n${p.nativeText}\n${p.ocrText ? "[OCR 识别文本，请对照原页核对]\n" + p.ocrText : ""}`,
              )
              .join("\n\n"),
        );
        return true;
      }
      result = pages;
    } else return false;
    json(response, 200, result);
    return true;
  };
}
