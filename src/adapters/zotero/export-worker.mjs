import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

// The only server-side module coupled to Zotero internals. It composes the exact
// upstream writer primitives, without importing unrelated ML/EPUB functionality.
const root = workerData.vendorRoot;
await import(pathToFileURL(path.join(root, "scripts/pdfjs-setup.js")));
const { PDFAssembler } = await import(
  pathToFileURL(path.join(root, "src/pdf/pdfassembler.js"))
);
const { writeRawAnnotations } = await import(
  pathToFileURL(path.join(root, "src/pdf/annotations/write.js"))
);
const { FontEmbedder } = await import(
  pathToFileURL(path.join(root, "src/pdf/font/font-embedder.js"))
);

try {
  const raw = await readFile(workerData.inputPath);
  const input = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength,
  );
  const pdf = new PDFAssembler();
  await pdf.init(input, workerData.password || "");
  const structure = await pdf.getPDFStructure();
  if (workerData.operation === "inspect") {
    const { readRawAnnotations } = await import(
      pathToFileURL(path.join(root, "src/pdf/annotations/read.js"))
    );
    const annotations = readRawAnnotations(structure).map((annotation) => {
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            annotation.type,
            annotation.position,
            annotation.comment,
          ]),
        )
        .digest("hex")
        .slice(0, 20);
      return {
        ...annotation,
        id: "EXT_" + key,
        text: annotation.text || "",
        comment: annotation.comment || "",
        tags: annotation.tags || [],
        color: annotation.color || "#ffd400",
        pageLabel: String(annotation.position.pageIndex + 1),
        sortIndex:
          String(annotation.position.pageIndex).padStart(5, "0") +
          "|000000|00000",
        authorName: annotation.authorName || "PDF 内嵌标注",
        readOnly: true,
        isExternal: true,
      };
    });
    parentPort.postMessage({ ok: true, annotations });
  } else {
    const fontEmbedder = new FontEmbedder({
      standardFontProvider: (filename) => {
        if (path.basename(filename) !== filename)
          throw new Error("Invalid font resource");
        return readFile(
          path.join(root, "pdf.js/external/standard_fonts", filename),
        );
      },
    });
    const annotations = workerData.annotations
      .filter((item) => !item.isExternal)
      .map((item) =>
        item.type === "ink"
          ? {
              ...item,
              position: {
                ...item.position,
                // A move-only PDF path has no visible stroke. A zero-length line
                // with the writer's round cap renders the original single-point dot.
                paths: item.position.paths.map((stroke) =>
                  stroke.length === 2 ? [...stroke, ...stroke] : stroke,
                ),
              },
            }
          : item,
      );
    await writeRawAnnotations(structure, annotations, fontEmbedder);
    const result = await pdf.assemblePdf("ArrayBuffer");
    parentPort.postMessage({ ok: true, buffer: result }, [result]);
  }
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: { name: error.name, message: error.message },
  });
}
