export function createCitationRoutes({ citations, json, body }) {
  return async (request, response, route) => {
    if (!route.startsWith("/api/citations/")) return false;
    let result;
    if (route === "/api/citations/info" && request.method === "GET")
      result = await citations.info();
    else if (route === "/api/citations/prepare" && request.method === "POST")
      result = await citations.prepare(await body(request));
    else if (route === "/api/citations/apply" && request.method === "POST")
      result = await citations.apply((await body(request)).planId);
    else return false;
    json(response, 200, result);
    return true;
  };
}
