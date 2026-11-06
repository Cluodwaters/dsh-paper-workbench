import { AppError, requireValue } from "../../domain/errors.mjs";
import { normalizeDoi } from "../../domain/bibliography.mjs";

const first = (value) => (Array.isArray(value) ? value[0] || "" : value || "");
const date = (value) =>
  (value?.["date-parts"]?.[0] || [])
    .slice(0, 3)
    .map((part, index) => String(part).padStart(index ? 2 : 4, "0"))
    .join("-");
export function crossrefCandidate(message) {
  const authors = (message.author || []).flatMap((author) =>
    author.name
      ? [{ literal: author.name }]
      : author.family || author.given
        ? [
            {
              family: author.family || "",
              given: author.given || "",
              ...(author.ORCID
                ? {
                    orcid: author.ORCID.replace(/^https?:\/\/orcid\.org\//, ""),
                  }
                : {}),
            },
          ]
        : [],
  );
  const types = {
    "journal-article": "article-journal",
    "proceedings-article": "paper-conference",
    book: "book",
    "book-chapter": "chapter",
    dissertation: "thesis",
    report: "report",
  };
  const printDate = date(message["published-print"]),
    onlineDate = date(message["published-online"]);
  const fallbackYear = message.issued?.["date-parts"]?.[0]?.[0] ?? null;
  return {
    title: first(message.title),
    authors,
    journal: first(message["container-title"]),
    doi: message.DOI || "",
    type: types[message.type] || "article",
    year: printDate || onlineDate ? null : fallbackYear,
    printDate,
    onlineDate,
    volume: message.volume || "",
    issue: message.issue || "",
    pages: message.page || "",
    publisher: message.publisher || "",
    url: message.URL || "",
  };
}
export class CrossrefMetadataProvider {
  constructor({ fetcher = fetch } = {}) {
    this.fetcher = fetcher;
    this.cache = new Map();
  }
  async lookup(value) {
    const doi = normalizeDoi(value);
    requireValue(doi, "DOI_REQUIRED", "请先填写 DOI。");
    if (this.cache.has(doi)) return this.cache.get(doi);
    let response;
    try {
      response = await this.fetcher(
        "https://api.crossref.org/works/" + encodeURIComponent(doi),
        {
          headers: {
            Accept: "application/json",
            "User-Agent":
              "PersonalPaperWorkbench/0.2 (manual DOI metadata lookup)",
          },
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      throw new AppError(
        "METADATA_OFFLINE",
        "无法连接 Crossref。可继续离线编辑，稍后重试。",
        502,
      );
    }
    if (response.status === 404)
      throw new AppError(
        "DOI_NOT_FOUND",
        "Crossref 未找到该 DOI；可核对 DOI 或手动填写。",
        404,
      );
    if (response.status === 429)
      throw new AppError(
        "METADATA_RATE_LIMIT",
        "Crossref 暂时限制请求，请稍后重试。",
        429,
      );
    requireValue(
      response.ok,
      "METADATA_PROVIDER",
      "Crossref 暂时不可用，请稍后重试。",
      502,
    );
    const length = Number(response.headers?.get("content-length") || 0);
    requireValue(length <= 2000000, "METADATA_SIZE", "元数据响应过大。", 502);
    const text = await response.text();
    requireValue(
      text.length <= 2000000,
      "METADATA_SIZE",
      "元数据响应过大。",
      502,
    );
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new AppError(
        "METADATA_PROVIDER",
        "Crossref 返回了无法识别的数据。",
        502,
      );
    }
    requireValue(
      data.message && normalizeDoi(data.message.DOI || "") === doi,
      "DOI_MISMATCH",
      "返回的 DOI 不匹配，未应用信息。",
      502,
    );
    const result = {
      provider: "Crossref",
      doi,
      fetchedAt: new Date().toISOString(),
      sourceUrl: "https://doi.org/" + encodeURIComponent(doi),
      metadata: crossrefCandidate(data.message),
    };
    if (this.cache.size >= 100)
      this.cache.delete(this.cache.keys().next().value);
    this.cache.set(doi, result);
    return result;
  }
}
