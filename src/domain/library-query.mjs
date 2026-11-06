import { requireValue } from "./errors.mjs";
import {
  cleanText,
  termKey,
  READING_STATUSES,
  REVIEW_STATUSES,
} from "./bibliography.mjs";

const unique = (values) => [...new Set(values)].sort();
export function normalizeLibraryQuery(input = {}) {
  requireValue(
    input && typeof input === "object" && !Array.isArray(input),
    "QUERY",
    "检索条件格式不正确。",
  );
  requireValue(
    input.version === undefined || input.version === 1,
    "QUERY_VERSION",
    "不支持该检索条件版本。",
  );
  function terms(key) {
    const values = input[key] || [];
    requireValue(
      Array.isArray(values) && values.length <= 100,
      "QUERY_TERMS",
      "单个筛选维度最多选择 100 项。",
    );
    return unique(
      values.map((v) => termKey(cleanText(v, 500))).filter(Boolean),
    );
  }
  const year = input.year || {};
  const from = year.from === "" || year.from == null ? null : Number(year.from);
  const to = year.to === "" || year.to == null ? null : Number(year.to);
  requireValue(
    [from, to].every(
      (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 9999),
    ),
    "QUERY_YEAR",
    "筛选年份必须为有效整数。",
  );
  requireValue(
    from === null || to === null || from <= to,
    "QUERY_YEAR_RANGE",
    "起始年份不能晚于结束年份。",
  );
  requireValue(
    Array.isArray(input.readingStatuses || []) &&
      Array.isArray(input.reviewStatuses || []),
    "QUERY_STATUS",
    "检索状态应为列表。",
  );
  const readingStatuses = unique(input.readingStatuses || []),
    reviewStatuses = unique(input.reviewStatuses || []);
  requireValue(
    readingStatuses.every((v) => READING_STATUSES.includes(v)) &&
      reviewStatuses.every((v) => REVIEW_STATUSES.includes(v)),
    "QUERY_STATUS",
    "检索状态无效。",
  );
  const sort = input.sort || { field: "added", direction: "desc" };
  requireValue(
    ["added", "updated", "year", "title"].includes(sort.field) &&
      ["asc", "desc"].includes(sort.direction),
    "QUERY_SORT",
    "排序方式无效。",
  );
  const authorMatch = input.authorMatch || "any",
    tagMatch = input.tagMatch || "any";
  requireValue(
    ["any", "all"].includes(authorMatch) && ["any", "all"].includes(tagMatch),
    "QUERY_MATCH",
    "筛选匹配方式无效。",
  );
  const scope = input.scope || "metadata";
  requireValue(
    ["metadata", "fulltext", "all"].includes(scope),
    "QUERY_SCOPE",
    "检索范围无效。",
  );
  return {
    version: 1,
    scope,
    text: cleanText(input.text, 500),
    authors: terms("authors"),
    authorMatch,
    journals: terms("journals"),
    tags: terms("tags"),
    tagMatch,
    year: { from, to, undatedOnly: Boolean(year.undatedOnly) },
    readingStatuses,
    reviewStatuses,
    needsMetadata: Boolean(input.needsMetadata),
    favoriteOnly: Boolean(input.favoriteOnly),
    archived: Boolean(input.archived),
    sort: { field: sort.field, direction: sort.direction },
  };
}
