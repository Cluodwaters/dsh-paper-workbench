export function createAgentRoutes({ service, json, body }) {
  return async (request, response, route) => {
    if (route === "/api/agents/status" && request.method === "GET") {
      json(response, 200, service.status());
      return true;
    }
    const match = route.match(/^\/api\/agents\/internal\/([a-z-]+)$/);
    if (match && request.method === "POST") {
      json(response, 200, await service.handle(match[1], await body(request)));
      return true;
    }
    return false;
  };
}
