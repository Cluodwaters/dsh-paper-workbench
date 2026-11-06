import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

try {
  await import(
    pathToFileURL(path.join(workerData.vendorRoot, "scripts/pdfjs-setup.js"))
  );
  const { PDFAssembler } = await import(
    pathToFileURL(path.join(workerData.vendorRoot, "src/pdf/pdfassembler.js"))
  );
  const { stringToPDFString } = await import(
    pathToFileURL(path.join(workerData.vendorRoot, "pdf.js/src/shared/util.js"))
  );
  const bytes = await readFile(workerData.inputPath);
  const pdf = new PDFAssembler();
  await pdf.init(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    "",
  );
  const structure = await pdf.getPDFStructure();
  const pages = structure["/Root"]["/Pages"]["/Kids"].length;
  const rawTitle = structure["/Info"]?.["/Title"];
  const title = typeof rawTitle === "string" ? stringToPDFString(rawTitle) : "";
  parentPort.postMessage({ ok: true, pages, pdfTitle: title });
} catch (error) {
  parentPort.postMessage({ ok: false, name: error.name, error: error.message });
}
