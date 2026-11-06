import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  appendFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { PdfSourceService } from "../src/application/pdf-source-service.mjs";
import { projectRoot } from "../src/config.mjs";
const fixtures = path.join(projectRoot, "data/validation/fixtures");
const service = new PdfSourceService({
  dataRoot: fixtures,
  vendorRoot: path.join(projectRoot, "third_party/zotero-document-worker"),
});
function attachment(name) {
  return {
    id: name,
    managedPath: name,
    sourceHash: createHash("sha256")
      .update(readFileSync(path.join(fixtures, name)))
      .digest("hex"),
  };
}
test("existing embedded highlight and Chinese note are exposed read-only", async () => {
  const items = await service.inspect(attachment("fixture-existing.pdf"));
  assert.equal(items.length, 2);
  assert.ok(items.every((x) => x.readOnly && x.isExternal));
  assert.ok(items.some((x) => x.type === "highlight"));
  assert.ok(
    items.some((x) => x.comment === "已有批注兼容性测试 / Existing note 中文"),
  );
});
test("password-protected PDF is explicitly rejected instead of opening without annotations", async () => {
  await assert.rejects(service.inspect(attachment("fixture-password.pdf")), {
    code: "PASSWORD_REQUIRED",
  });
});
test("truncated PDF is rejected without producing a blank successful result", async () => {
  await assert.rejects(service.inspect(attachment("fixture-truncated.pdf")), {
    code: "PDF_INVALID",
  });
});
test("source replacement is rejected before displaying old annotations", async () => {
  const base = path.join(projectRoot, "output/source-tests");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, "run-"));
  copyFileSync(
    path.join(fixtures, "fixture-existing.pdf"),
    path.join(dir, "test.pdf"),
  );
  const info = {
    id: "changed",
    managedPath: "test.pdf",
    sourceHash: attachment("fixture-existing.pdf").sourceHash,
  };
  const local = new PdfSourceService({
    dataRoot: dir,
    vendorRoot: path.join(projectRoot, "third_party/zotero-document-worker"),
  });
  await local.inspect(info);
  appendFileSync(path.join(dir, "test.pdf"), "\nchanged");
  await assert.rejects(local.inspect(info), { code: "SOURCE_CHANGED" });
});
