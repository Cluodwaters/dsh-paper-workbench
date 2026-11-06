import { timingSafeEqual } from "node:crypto";
import { requireValue } from "../domain/errors.mjs";

/** The browser talks only to the authenticated Harness proxy, never this token. */
export function integrationConfig(env = process.env) {
  const basePath = (env.PAPER_WORKBENCH_BASE_PATH || "").replace(/\/$/, "");
  requireValue(
    !basePath || /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(basePath),
    "BASE_PATH",
    "Invalid application mount path",
    500,
  );
  const token = env.PAPER_WORKBENCH_BRIDGE_TOKEN || "";
  requireValue(
    !token || Buffer.byteLength(token) >= 32,
    "BRIDGE_TOKEN",
    "Bridge token must contain at least 32 bytes",
    500,
  );
  return {
    basePath,
    info: { version: 1, basePath, authenticated: Boolean(token) },
    authorize(request) {
      if (!token) return;
      const actual = Buffer.from(request.headers.authorization || "");
      const expected = Buffer.from(`Bearer ${token}`);
      requireValue(
        actual.length === expected.length && timingSafeEqual(actual, expected),
        "AUTH_REQUIRED",
        "Authenticated host bridge required",
        401,
      );
    },
    route(pathname) {
      requireValue(
        !basePath ||
          pathname === basePath ||
          pathname.startsWith(basePath + "/"),
        "NOT_FOUND",
        "Unknown application mount",
        404,
      );
      return pathname.slice(basePath.length) || "/";
    },
  };
}
