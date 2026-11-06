import { requireValue } from "./errors.mjs";

export const ITEM_TYPES = [
  "article-journal",
  "paper-conference",
  "thesis",
  "book",
  "chapter",
  "report",
  "article",
];
export const READING_STATUSES = ["unread", "reading", "read"];
export const REVIEW_STATUSES = ["unverified", "reviewed"];

export function cleanText(value, max = 2000) {
  requireValue(
    value === undefined || value === null || typeof value === "string",
    "METADATA_TEXT",
    "文本字段必须是字符串。",
  );
  const text = (value || "")
    .normalize("NFC")
    .replace(/\u200b/g, "")
    .trim();
  requireValue(
    text.length <= max,
    "METADATA_LENGTH",
    `字段长度不能超过 ${max} 个字符。`,
  );
  return text;
}
export function termKey(value) {
  return cleanText(value, 500000)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .toLowerCase();
}
export function searchKey(value) {
  return termKey(value).normalize("NFKD").replace(/\p{M}/gu, "");
}
export function normalizeDoi(value) {
  let doi = cleanText(value, 1000).replace(/^doi:\s*/i, "");
  if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(doi)) {
    try {
      doi = decodeURIComponent(new URL(doi).pathname.slice(1));
    } catch {
      requireValue(false, "DOI_FORMAT", "DOI 链接的编码无效。");
    }
  }
  doi = doi.toLowerCase();
  requireValue(
    !doi || /^10\.\d{4,9}\/\S+$/i.test(doi),
    "DOI_FORMAT",
    "DOI 格式应类似 10.1234/example，也可粘贴 doi.org 链接。",
  );
  return doi;
}
function dateValue(value) {
  const date = cleanText(value, 10);
  requireValue(
    !date || /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(date),
    "DATE_FORMAT",
    "日期请使用 YYYY、YYYY-MM 或 YYYY-MM-DD。",
  );
  if (date) {
    const [year, month = 1, day = 1] = date.split("-").map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    requireValue(
      year >= 1 &&
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= days[month - 1],
      "DATE_FORMAT",
      "日期不是有效的日历日期。",
    );
  }
  return date;
}
export function authorLabel(author) {
  return (
    author.literal || [author.family, author.given].filter(Boolean).join(", ")
  );
}
export function normalizeAuthors(input = []) {
  requireValue(
    Array.isArray(input) && input.length <= 500,
    "AUTHORS",
    "作者需要使用有序列表，最多 500 位。",
  );
  return input.map((author) => {
    requireValue(
      author && typeof author === "object",
      "AUTHORS",
      "作者格式不正确。",
    );
    const literal = cleanText(author.literal, 300),
      family = cleanText(author.family, 150),
      given = cleanText(author.given, 150);
    requireValue(
      Boolean(literal) !== Boolean(family || given),
      "AUTHORS",
      "每位作者使用完整名称，或分别填写姓和名，两种方式择一。",
    );
    const orcid = cleanText(author.orcid, 100)
      .replace(/^https?:\/\/orcid\.org\//i, "")
      .toUpperCase();
    requireValue(
      !orcid || /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(orcid),
      "ORCID_FORMAT",
      "ORCID 格式不正确。",
    );
    const extra = author.extra || {};
    requireValue(
      typeof extra === "object" &&
        !Array.isArray(extra) &&
        JSON.stringify(extra).length <= 5000,
      "AUTHOR_EXTRA",
      "作者扩展信息无效。",
    );
    return {
      ...(literal ? { literal } : { family, given }),
      ...(orcid ? { orcid } : {}),
      ...(Object.keys(extra).length
        ? { extra: JSON.parse(JSON.stringify(extra)) }
        : {}),
    };
  });
}
export function normalizeTags(input = []) {
  requireValue(
    Array.isArray(input) && input.length <= 100,
    "TAGS",
    "标签需要使用列表，最多 100 个。",
  );
  const tags = new Map();
  for (const value of input) {
    const tag = cleanText(value, 100);
    if (tag && !tags.has(termKey(tag))) tags.set(termKey(tag), tag);
  }
  return [...tags.values()];
}
export function effectiveYear(metadata) {
  if (metadata.year !== null)
    return { value: metadata.year, source: "specified" };
  if (metadata.printDate)
    return { value: Number(metadata.printDate.slice(0, 4)), source: "print" };
  if (metadata.onlineDate)
    return { value: Number(metadata.onlineDate.slice(0, 4)), source: "online" };
  return { value: null, source: null };
}
export function normalizeMetadata(input = {}) {
  requireValue(
    input && typeof input === "object" && !Array.isArray(input),
    "METADATA",
    "文献信息格式不正确。",
  );
  requireValue(
    input.schemaVersion === undefined || input.schemaVersion === 1,
    "METADATA_VERSION",
    "此文献信息使用更新的数据格式，请升级程序后再编辑。",
    409,
  );
  const title = cleanText(input.title, 4000);
  requireValue(title.length > 0, "TITLE_REQUIRED", "请填写文献题名。");
  const type = input.type || "article";
  requireValue(ITEM_TYPES.includes(type), "ITEM_TYPE", "不支持该文献类型。");
  const year =
    input.year === "" || input.year === null || input.year === undefined
      ? null
      : Number(input.year);
  requireValue(
    year === null || (Number.isInteger(year) && year >= 1 && year <= 9999),
    "YEAR",
    "年份应为 1—9999 的整数，或留空。",
  );
  const readingStatus = input.readingStatus || "unread",
    reviewStatus = input.reviewStatus || "unverified";
  requireValue(
    READING_STATUSES.includes(readingStatus) &&
      REVIEW_STATUSES.includes(reviewStatus),
    "STATUS",
    "阅读或核对状态无效。",
  );
  const url = cleanText(input.url, 2000);
  requireValue(
    !url || /^https?:\/\//i.test(url),
    "URL_FORMAT",
    "文献链接应使用 http 或 https。",
  );
  const extra = input.extra ?? {};
  requireValue(
    extra &&
      typeof extra === "object" &&
      !Array.isArray(extra) &&
      JSON.stringify(extra).length <= 100000,
    "METADATA_EXTRA",
    "扩展信息格式或长度不正确。",
  );
  return {
    schemaVersion: 1,
    title,
    type,
    authors: normalizeAuthors(input.authors),
    year,
    printDate: dateValue(input.printDate),
    onlineDate: dateValue(input.onlineDate),
    journal: cleanText(input.journal, 500),
    doi: normalizeDoi(input.doi),
    volume: cleanText(input.volume, 100),
    issue: cleanText(input.issue, 100),
    pages: cleanText(input.pages, 200),
    publisher: cleanText(input.publisher, 500),
    abstract: cleanText(input.abstract, 100000),
    url,
    tags: normalizeTags(input.tags),
    readingStatus,
    reviewStatus,
    favorite: Boolean(input.favorite),
    extra: JSON.parse(JSON.stringify(extra)),
  };
}
export function missingFields(metadata) {
  const fields = [];
  if (!metadata.authors.length) fields.push("authors");
  if (effectiveYear(metadata).value === null) fields.push("year");
  if (
    ["article-journal", "paper-conference"].includes(metadata.type) &&
    !metadata.journal
  )
    fields.push("journal");
  return fields;
}
function partsToDate(parts) {
  if (!Array.isArray(parts) || !parts.length) return "";
  return parts
    .slice(0, 3)
    .map((value, index) => String(value).padStart(index ? 2 : 4, "0"))
    .join("-");
}
export function metadataFromCsl(csl, reviewStatus = "unverified") {
  const date = partsToDate(csl.issued?.["date-parts"]?.[0]);
  return normalizeMetadata({
    title: csl.title || "未命名文献",
    type: ITEM_TYPES.includes(csl.type) ? csl.type : "article",
    authors: (csl.author || []).map((a) => {
      const { family, given, literal, ORCID, ...extra } = a;
      return {
        ...(literal
          ? { literal }
          : { family: family || "", given: given || "" }),
        orcid: ORCID || "",
        extra,
      };
    }),
    year: date ? Number(date.slice(0, 4)) : null,
    journal: csl["container-title"] || "",
    doi: csl.DOI || "",
    volume: csl.volume || "",
    issue: csl.issue || "",
    pages: csl.page || "",
    publisher: csl.publisher || "",
    abstract: csl.abstract || "",
    url: csl.URL || "",
    reviewStatus,
  });
}
export function metadataToCsl(existing, metadata, itemId) {
  const csl = {
    ...existing,
    id: itemId,
    title: metadata.title,
    type: metadata.type,
  };
  const mapping = {
    "container-title": metadata.journal,
    DOI: metadata.doi,
    volume: metadata.volume,
    issue: metadata.issue,
    page: metadata.pages,
    publisher: metadata.publisher,
    abstract: metadata.abstract,
    URL: metadata.url,
  };
  for (const [key, value] of Object.entries(mapping)) {
    if (value) csl[key] = value;
    else delete csl[key];
  }
  if (metadata.authors.length)
    csl.author = metadata.authors.map(({ orcid, extra = {}, ...author }) => ({
      ...extra,
      ...author,
      ...(orcid ? { ORCID: `https://orcid.org/${orcid}` } : {}),
    }));
  else delete csl.author;
  const year = effectiveYear(metadata);
  if (year.value !== null) {
    const date =
      year.source === "print"
        ? metadata.printDate
        : year.source === "online"
          ? metadata.onlineDate
          : String(year.value);
    csl.issued = { "date-parts": [date.split("-").map(Number)] };
  } else delete csl.issued;
  return csl;
}
