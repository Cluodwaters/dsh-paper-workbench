import { requireValue } from "./errors.mjs";

export const annotationFormat = "zotero-pdf-v1";
// Adapter capabilities, not database enum columns; a future adapter can register its own validator.
const supportedTypes = new Set([
  "highlight",
  "underline",
  "note",
  "text",
  "image",
  "ink",
]);
export function validateAnnotation(annotation, pageCount) {
  requireValue(
    annotation && /^[A-Za-z0-9_-]{1,128}$/.test(annotation.id),
    "ANNOTATION_ID",
    "Invalid annotation ID",
  );
  requireValue(
    supportedTypes.has(annotation.type),
    "ANNOTATION_TYPE",
    "Unsupported annotation type",
  );
  requireValue(
    /^#[a-fA-F0-9]{6}$/.test(annotation.color ?? ""),
    "ANNOTATION_COLOR",
    "Invalid annotation color",
  );
  const position = annotation.position;
  requireValue(
    position &&
      Number.isInteger(position.pageIndex) &&
      position.pageIndex >= 0 &&
      position.pageIndex < pageCount,
    "ANNOTATION_PAGE",
    "Annotation page lies outside this document",
  );
  if (annotation.type === "ink") {
    requireValue(
      Number.isFinite(position.width) &&
        position.width > 0 &&
        Array.isArray(position.paths) &&
        position.paths.length > 0,
      "ANNOTATION_POSITION",
      "Invalid ink geometry",
    );
    requireValue(
      position.paths.every(
        (p) =>
          Array.isArray(p) &&
          // A click with the ink tool is a valid one-point stroke (a dot).
          p.length >= 2 &&
          p.length % 2 === 0 &&
          p.every(Number.isFinite),
      ),
      "ANNOTATION_POSITION",
      "Invalid ink path",
    );
  } else {
    for (const rects of [
      position.rects,
      ...(position.nextPageRects ? [position.nextPageRects] : []),
    ]) {
      requireValue(
        Array.isArray(rects) &&
          rects.length > 0 &&
          rects.every(
            (r) =>
              Array.isArray(r) &&
              r.length === 4 &&
              r.every(Number.isFinite) &&
              r[2] >= r[0] &&
              r[3] >= r[1],
          ),
        "ANNOTATION_POSITION",
        "Invalid PDF-space annotation geometry",
      );
    }
    if (position.nextPageRects)
      requireValue(
        position.pageIndex + 1 < pageCount,
        "ANNOTATION_PAGE",
        "Cross-page annotation exceeds the document",
      );
  }
  requireValue(
    typeof annotation.comment === "string" &&
      typeof annotation.text === "string",
    "ANNOTATION_TEXT",
    "Annotation text and comment must be strings",
  );
  requireValue(
    typeof annotation.sortIndex === "string",
    "ANNOTATION_ORDER",
    "Missing annotation order",
  );
  requireValue(
    JSON.stringify(annotation).length < 2_000_000,
    "ANNOTATION_SIZE",
    "Annotation is too large",
  );
  return annotation;
}
