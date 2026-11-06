/** Exclude this application's own generated folders only during directory import.
 * Explicitly selected files have no relative path and are always respected. */
export function selectPdfImports(files, policy) {
  const pdfs = [...files].filter((file) => /\.pdf$/i.test(file.name));
  const ignored = [],
    selected = [];
  for (const file of pdfs) {
    const parts = (file.webkitRelativePath || "")
      .replaceAll("\\", "/")
      .split("/")
      .filter(Boolean)
      .map((value) => value.toLowerCase());
    const project = (policy?.projectFolder || "").toLowerCase();
    const folders = (policy?.generatedFolders || []).map((value) =>
      value.toLowerCase(),
    );
    const excluded =
      project &&
      parts.some(
        (part, index) => part === project && folders.includes(parts[index + 1]),
      );
    (excluded ? ignored : selected).push(file);
  }
  return { selected, ignored, nonPdf: [...files].length - pdfs.length };
}
