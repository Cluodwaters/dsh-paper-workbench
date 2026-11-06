import he from "he";

function plain(value, limit) {
  return he
    .decode(
      String(value || "")
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
        .replace(/<[^>]+>/g, " "),
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** Portable excerpt only. Upstream coordinates and formatting never cross the AI port. */
export function annotationExcerpts(annotations, pageCount) {
  return annotations.slice(0, 100).map((annotation) => {
    const pageIndex = annotation.position?.pageIndex;
    return {
      id: String(annotation.id),
      type: String(annotation.type || "note"),
      pageIndex:
        Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pageCount
          ? pageIndex
          : null,
      text: plain(annotation.text, 1500),
      comment: plain(annotation.comment, 1500),
    };
  });
}
