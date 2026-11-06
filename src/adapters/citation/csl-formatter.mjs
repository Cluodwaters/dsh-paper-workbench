import CSL from "citeproc";
import he from "he";
import { readFileSync } from "node:fs";
import path from "node:path";
import { requireValue } from "../../domain/errors.mjs";

export const STYLES = [
  { id: "gb-t-7714-2015", label: "GB/T 7714—2015 · 顺序编码" },
  { id: "gb-t-7714-2025", label: "GB/T 7714—2025 · 顺序编码" },
  { id: "apa", label: "APA · 第七版 · 作者年份" },
  { id: "ieee", label: "IEEE · 顺序编码" },
];
// citeproc emits a small HTML vocabulary. Convert it to explicit formatting
// runs, never HTML execution or clipboard data. Unknown tags have no effect.
export function formattedRuns(html) {
  const runs = [],
    stack = [{}];
  for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
    if (token[0] !== "<") {
      if (token.includes("\n") && !token.trim()) continue;
      const text = he.decode(token).replace(/\n/g, "");
      if (text) runs.push({ text, ...stack.at(-1) });
      continue;
    }
    if (/^<\//.test(token)) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const style = { ...stack.at(-1) };
    if (/class="csl-right-inline"/.test(token)) runs.push({ text: "\t" });
    if (/^<(i|em)(\s|>)/i.test(token)) style.italic = true;
    if (/^<(b|strong)(\s|>)/i.test(token)) style.bold = true;
    if (/^<sup(\s|>)/i.test(token)) style.superscript = true;
    if (/^<sub(\s|>)/i.test(token)) style.subscript = true;
    if (/font-variant:\s*small-caps/.test(token)) style.smallCaps = true;
    if (/font-style:\s*normal/.test(token)) style.italic = false;
    if (/^<br\s*\/?\s*>/i.test(token)) runs.push({ text: "\r" });
    else stack.push(style);
  }
  return runs;
}
export class CslFormatter {
  constructor(root) {
    this.root = root;
  }
  format(styleId, clusters) {
    requireValue(
      STYLES.some((s) => s.id === styleId),
      "CSL_STYLE",
      "请选择已安装的引用格式。",
    );
    const records = new Map(
      clusters.flatMap((c) => c.items.map((item) => [item.id, item.csl])),
    );
    const engine = new CSL.Engine(
      {
        retrieveLocale: (lang) => {
          const locale = lang === "zh-CN" ? "zh-CN" : "en-US";
          return readFileSync(
            path.join(this.root, `locales-${locale}.xml`),
            "utf8",
          );
        },
        retrieveItem: (id) => structuredClone(records.get(id)),
      },
      readFileSync(path.join(this.root, styleId + ".csl"), "utf8"),
      "en-US",
    );
    engine.setOutputFormat("html");
    const inputs = clusters.map((c) => ({
      citationID: c.id,
      properties: { noteIndex: 0 },
      citationItems: c.items.map((item) => ({
        id: item.id,
        ...(item.locator
          ? { locator: item.locator, label: item.label || "page" }
          : {}),
        ...(item.prefix ? { prefix: item.prefix } : {}),
        ...(item.suffix ? { suffix: item.suffix } : {}),
      })),
    }));
    const citations = inputs.length
      ? engine.rebuildProcessorState(inputs, "html")
      : [];
    const bibliography = inputs.length ? engine.makeBibliography() : null;
    const bibRuns = [];
    if (bibliography)
      bibliography[1].forEach((entry, i) => {
        if (i) bibRuns.push({ text: "\r" });
        bibRuns.push(...formattedRuns(entry));
      });
    return {
      citations: new Map(
        citations.map((row) => [row[0], formattedRuns(row[2])]),
      ),
      bibliography: bibRuns,
      bibliographyCount: bibliography ? bibliography[1].length : 0,
    };
  }
}
