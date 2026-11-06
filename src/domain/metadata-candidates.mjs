import { requireValue } from "./errors.mjs";

const groups = [
  ["title", ["title"]],
  ["authors", ["authors"]],
  ["type", ["type"]],
  ["year", ["year", "printDate", "onlineDate"]],
  ["journal", ["journal"]],
  ["doi", ["doi"]],
  ["volume", ["volume"]],
  ["issue", ["issue"]],
  ["pages", ["pages"]],
  ["publisher", ["publisher"]],
  ["url", ["url"]],
];
const present = (value) =>
  Array.isArray(value)
    ? value.length > 0
    : value !== null && value !== undefined && value !== "";
export function candidateFields(current, proposed) {
  return groups
    .filter(([, fields]) => fields.some((field) => present(proposed[field])))
    .map(([key, fields]) => ({
      key,
      fields,
      defaultChecked: fields.every((field) => !present(current[field])),
    }));
}
export function applyMetadataCandidate(current, candidate, selected) {
  const available = candidateFields(current, candidate.metadata);
  requireValue(
    Array.isArray(selected) &&
      selected.every((key) => available.some((group) => group.key === key)),
    "CANDIDATE_FIELDS",
    "候选字段选择无效。",
  );
  const result = structuredClone(current),
    fields = [];
  for (const group of available.filter((group) => selected.includes(group.key)))
    for (const field of group.fields) {
      result[field] = structuredClone(
        candidate.metadata[field] ?? (field === "year" ? null : ""),
      );
      fields.push(field);
    }
  if (fields.length) {
    result.reviewStatus = "unverified";
    result.extra = {
      ...result.extra,
      metadataLookup: {
        provider: candidate.provider,
        doi: candidate.doi,
        fetchedAt: candidate.fetchedAt,
        fields,
      },
    };
  }
  return result;
}
