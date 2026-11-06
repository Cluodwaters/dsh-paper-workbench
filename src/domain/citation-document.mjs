import { requireValue } from "./errors.mjs";

export const CITATION_PREFIX = "ADDIN PW_CITE_V1 ";
export const BIBLIOGRAPHY_PREFIX = "ADDIN PW_BIB_V1 ";
const cslFields = [
  "id",
  "type",
  "title",
  "author",
  "editor",
  "translator",
  "issued",
  "accessed",
  "container-title",
  "container-title-short",
  "collection-title",
  "publisher",
  "publisher-place",
  "volume",
  "issue",
  "page",
  "edition",
  "DOI",
  "ISBN",
  "ISSN",
  "URL",
  "language",
  "number",
  "event-title",
  "event-place",
  "genre",
];
export function portableCsl(csl) {
  return Object.fromEntries(
    cslFields
      .filter((key) => csl[key] !== undefined)
      .map((key) => [key, structuredClone(csl[key])]),
  );
}
export function encodeField(kind, payload) {
  const json = JSON.stringify(payload);
  requireValue(
    Buffer.byteLength(json) <= 180000,
    "CITATION_TOO_LARGE",
    "单处引用数据过大，请拆分引用组。",
  );
  return (
    (kind === "citation" ? CITATION_PREFIX : BIBLIOGRAPHY_PREFIX) +
    Buffer.from(json, "utf8").toString("base64")
  );
}
export function decodeField(code) {
  const clean = code.trim();
  const kind = clean.startsWith(CITATION_PREFIX)
    ? "citation"
    : clean.startsWith(BIBLIOGRAPHY_PREFIX)
      ? "bibliography"
      : null;
  if (!kind) {
    requireValue(
      !/^ADDIN PW_(?:CITE|BIB)_/.test(clean),
      "CITATION_VERSION",
      "文档中的引用来自更新版本，请先升级文献工作台。",
    );
    return null;
  }
  try {
    const encoded = clean
      .slice(
        (kind === "citation" ? CITATION_PREFIX : BIBLIOGRAPHY_PREFIX).length,
      )
      .trim();
    requireValue(
      encoded.length <= 250000 && /^[a-zA-Z0-9+/]+=*$/.test(encoded),
      "CITATION_FIELD",
      "引用标记损坏。",
    );
    const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    requireValue(
      value.version === 1 && typeof value.style === "string",
      "CITATION_FIELD",
      "引用标记版本不受支持。",
    );
    if (kind === "citation") {
      requireValue(
        typeof value.id === "string" &&
          value.items?.length > 0 &&
          value.items.length <= 100,
        "CITATION_FIELD",
        "引用组无效。",
      );
      for (const item of value.items)
        requireValue(
          typeof item.id === "string" &&
            item.id.length <= 128 &&
            item.csl?.id === item.id,
          "CITATION_FIELD",
          "引用文献数据无效。",
        );
    }
    return { kind, value };
  } catch (error) {
    throw new Error(
      "文档中有无法读取的工作台引用，请先撤销最近修改或恢复文档备份。" +
        error.message,
    );
  }
}
