const moduleUrl = new URL(import.meta.url);
export const basePath =
  moduleUrl.protocol === "file:"
    ? ""
    : new URL(".", moduleUrl).pathname.replace(/\/$/, "");
export function appUrl(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  )
    return value;
  return basePath && !(value === basePath || value.startsWith(basePath + "/"))
    ? basePath + value
    : value;
}
