import { randomUUID } from "node:crypto";
import path from "node:path";
import { requireValue } from "../domain/errors.mjs";
import {
  encodeField,
  decodeField,
  portableCsl,
} from "../domain/citation-document.mjs";
import { CslFormatter, STYLES } from "../adapters/citation/csl-formatter.mjs";
import { OfficeConnector } from "../adapters/office/office-connector.mjs";

export class CitationService {
  constructor({ store, projectRoot, connector }) {
    this.store = store;
    this.connector = connector || new OfficeConnector(projectRoot);
    this.formatter = new CslFormatter(path.join(projectRoot, "resources/csl"));
    this.plans = new Map();
    this.inFlight = new Set();
  }
  async info() {
    return { styles: STYLES, applications: await this.connector.call("probe") };
  }
  async prepare(input) {
    requireValue(
      ["word", "wps"].includes(input.application),
      "OFFICE_APP",
      "请选择 Word 或 WPS。",
    );
    requireValue(
      ["insert", "bibliography", "refresh"].includes(input.action),
      "CITATION_ACTION",
      "引用操作无效。",
    );
    const snapshot = await this.connector.call("snapshot", {
      application: input.application,
    });
    const fields = snapshot.fields.map((field) => ({
      ...field,
      ...decodeField(field.code),
    }));
    const citations = fields.filter((f) => f.kind === "citation"),
      bibs = fields.filter((f) => f.kind === "bibliography");
    requireValue(
      bibs.length <= 1,
      "BIBLIOGRAPHY_DUPLICATE",
      "文档中有多份工作台参考文献表，请删除多余的一份后刷新。",
    );
    const style = input.style || fields[0]?.value.style || STYLES[0].id;
    const seen = new Set(),
      warnings = [];
    const clusters = citations.map((field) => {
      const value = structuredClone(field.value);
      if (seen.has(value.id)) value.id = randomUUID();
      seen.add(value.id);
      return { field, value };
    });
    let insertion = null;
    if (input.action === "insert") {
      requireValue(
        Array.isArray(input.items) &&
          input.items.length > 0 &&
          input.items.length <= 100,
        "CITATION_ITEMS",
        "请选择 1–100 条文献。",
      );
      const items = input.items.map((item) => {
        const record = this.store.library.get(item.id);
        for (const key of ["locator", "prefix", "suffix"])
          requireValue(
            !item[key] ||
              (typeof item[key] === "string" && item[key].length <= 200),
            "CITATION_LOCATOR",
            "页码或前后缀过长。",
          );
        requireValue(
          !item.label ||
            ["page", "chapter", "section", "figure", "volume"].includes(
              item.label,
            ),
          "CITATION_LABEL",
          "定位类型无效。",
        );
        return {
          id: record.id,
          csl: portableCsl(record.csl),
          locator: item.locator || "",
          label: item.label || "page",
          prefix: item.prefix || "",
          suffix: item.suffix || "",
        };
      });
      const value = { version: 1, id: randomUUID(), style, items };
      insertion = { kind: "citation", value };
      let index = clusters.findIndex(
        (c) => c.field.start >= snapshot.selection.end,
      );
      if (index < 0) index = clusters.length;
      clusters.splice(index, 0, { field: null, value });
    }
    for (const cluster of clusters) {
      cluster.value.style = style;
      for (const item of cluster.value.items) {
        try {
          const record = this.store.library.get(item.id);
          item.csl = portableCsl(record.csl);
          if (record.missingFields.length)
            warnings.push(
              `《${record.metadata.title}》缺少 ${record.missingFields.map((field) => ({ authors: "作者", year: "发表年份", journal: "期刊 / 会议" })[field] || field).join("、")}，请核对文献信息。`,
            );
        } catch (error) {
          if (error.code !== "NOT_FOUND") throw error;
          warnings.push(`《${item.csl.title}》使用文档内保存的文献信息。`);
        }
      }
    }
    const formatted = this.formatter.format(
      style,
      clusters.map((c) => c.value),
    );
    const updates = clusters
      .filter((c) => c.field)
      .map((c) => ({
        index: c.field.index,
        code: encodeField("citation", c.value),
        runs: formatted.citations.get(c.value.id),
        bibliography: false,
      }));
    const bib = { version: 1, style };
    if (bibs.length)
      updates.push({
        index: bibs[0].index,
        code: encodeField("bibliography", bib),
        runs: formatted.bibliography.length
          ? formatted.bibliography
          : [{ text: "（尚无引用）" }],
        bibliography: true,
      });
    if (input.action === "bibliography" && !bibs.length)
      insertion = { kind: "bibliography", value: bib };
    const insert = insertion
      ? {
          code: encodeField(insertion.kind, insertion.value),
          runs:
            insertion.kind === "citation"
              ? formatted.citations.get(insertion.value.id)
              : formatted.bibliography.length
                ? formatted.bibliography
                : [{ text: "（尚无引用）" }],
          bibliography: insertion.kind === "bibliography",
        }
      : null;
    const plan = {
      id: randomUUID(),
      createdAt: Date.now(),
      application: input.application,
      expected: snapshot.signature,
      updates,
      insert,
    };
    this.plans.set(plan.id, plan);
    for (const [id, value] of this.plans)
      if (value.createdAt < Date.now() - 600000) this.plans.delete(id);
    return {
      planId: plan.id,
      target: snapshot.target,
      style,
      citationCount: clusters.length,
      bibliographyCount: formatted.bibliographyCount,
      warnings: [...new Set(warnings)],
      citation:
        insert && !insert.bibliography
          ? insert.runs.map((r) => r.text).join("")
          : null,
      bibliography: formatted.bibliography.map((r) => r.text).join(""),
      selection: snapshot.selection,
    };
  }
  async apply(id) {
    const plan = this.plans.get(id);
    requireValue(
      plan && plan.createdAt > Date.now() - 300000,
      "CITATION_PLAN",
      "预览已过期，请重新预览。",
      409,
    );
    if (plan.result) return plan.result;
    requireValue(
      !this.inFlight.has(id),
      "CITATION_BUSY",
      "引用正在写入，请稍候。",
      409,
    );
    this.inFlight.add(id);
    try {
      plan.result = await this.connector.call("apply", plan);
      return plan.result;
    } finally {
      this.inFlight.delete(id);
    }
  }
}
