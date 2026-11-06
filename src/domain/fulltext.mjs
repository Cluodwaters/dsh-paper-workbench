import { searchKey } from "./bibliography.mjs";

// One token per Han character supports Chinese phrases of any length, including
// two-character words. Latin words keep their boundaries. Both sides use this
// same tokenizer; user input is never interpreted as FTS query syntax.
export function textTokens(text) {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
  return (normalized.match(/\p{Script=Han}|[\p{L}\p{N}]+/gu) || [])
    .flatMap((word) => word.match(/\p{Script=Han}|[^\p{Script=Han}]+/gu) || [])
    .map((word) =>
      /^\p{Script=Han}$/u.test(word)
        ? "han" + word.codePointAt(0).toString(16)
        : word,
    );
}
export function fulltextPhrase(text) {
  const tokens = textTokens(text);
  return tokens.length
    ? '"' + tokens.join(" ").replaceAll('"', '""') + '"'
    : null;
}
export function searchPieces(text) {
  return [
    ...new Set(
      (text.match(/"[^"]+"|\S+/g) || [])
        .map((value) => searchKey(value.replace(/^"|"$/g, "")))
        .filter(Boolean),
    ),
  ];
}
export function excerpt(text, pieces, length = 240) {
  const compact = text.replace(/\s+/g, " ").trim();
  const normalized = searchKey(compact);
  const positions = pieces
    .map((piece) => normalized.indexOf(piece))
    .filter((i) => i >= 0);
  const start = positions.length ? Math.max(0, Math.min(...positions) - 70) : 0;
  return (
    (start ? "…" : "") +
    compact.slice(start, start + length) +
    (compact.length > start + length ? "…" : "")
  );
}
