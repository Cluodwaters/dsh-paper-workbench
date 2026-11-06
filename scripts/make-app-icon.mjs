import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { projectRoot } from "../src/config.mjs";
const image = await loadImage(
    readFileSync(path.join(projectRoot, "resources/icon.svg")),
  ),
  sizes = [16, 24, 32, 48, 64, 128, 256],
  pngs = [];
for (const size of sizes) {
  const canvas = createCanvas(size, size);
  canvas.getContext("2d").drawImage(image, 0, 0, size, size);
  pngs.push(canvas.toBuffer("image/png"));
}
writeFileSync(path.join(projectRoot, "resources/icon.png"), pngs.at(-1));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const base = 6 + i * 16;
  header[base] = size === 256 ? 0 : size;
  header[base + 1] = header[base];
  header.writeUInt16LE(1, base + 4);
  header.writeUInt16LE(32, base + 6);
  header.writeUInt32LE(pngs[i].length, base + 8);
  header.writeUInt32LE(offset, base + 12);
  offset += pngs[i].length;
});
writeFileSync(
  path.join(projectRoot, "resources/icon.ico"),
  Buffer.concat([header, ...pngs]),
);
