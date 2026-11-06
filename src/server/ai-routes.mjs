export function createAiRoutes({ context, json, body }) {
  return async (request, response, route, url) => {
    if (route === "/api/ai/context" && request.method === "POST") {
      json(response, 200, await context.context(await body(request)));
      return true;
    }
    const match = route.match(/^\/api\/ai\/annotations\/([a-f0-9-]+)$/);
    if (match && request.method === "GET") {
      json(
        response,
        200,
        await context.annotations(match[1], url.searchParams.get("sourceHash")),
      );
      return true;
    }
    return false;
  };
}
