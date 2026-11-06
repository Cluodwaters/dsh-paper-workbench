import path from "node:path";
import { fileURLToPath } from "node:url";
export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const dataRoot = path.resolve(
  process.env.PAPER_WORKBENCH_DATA ||
    path.join(projectRoot, "data", "workspace"),
);
export const databasePath = path.join(dataRoot, "library.sqlite");
export const port = Number(process.env.PAPER_WORKBENCH_PORT || 4178);
