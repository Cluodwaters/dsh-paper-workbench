"""Copy a deterministic, varied sample of existing papers; never write to originals."""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import shutil
import sys
from pathlib import Path

from pypdf import PdfReader

logging.getLogger("pypdf").setLevel(logging.ERROR)
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inspect(path: Path) -> dict:
    result = {"sourcePath": str(path.resolve()), "originalName": path.name,
              "bytes": path.stat().st_size, "sha256": sha256(path)}
    try:
        reader = PdfReader(path, strict=False)
        result["encrypted"] = reader.is_encrypted
        if reader.is_encrypted and not reader.decrypt(""):
            result.update(pages=None, inspectionError="Password required")
            return result
        result["pages"] = len(reader.pages)
        meta = reader.metadata or {}
        result["pdfTitle"] = str(meta.get("/Title", ""))
        sample_pages = sorted({0, min(1, len(reader.pages)-1), len(reader.pages)-1})
        summaries = []
        for index in sample_pages:
            page = reader.pages[index]
            text = page.extract_text() or ""
            annotations = page.get("/Annots", [])
            if hasattr(annotations, "get_object"):
                annotations = annotations.get_object()
            annotation_types = {}
            for reference in annotations or []:
                subtype = str(reference.get_object().get("/Subtype", "Unknown"))
                annotation_types[subtype] = annotation_types.get(subtype, 0) + 1
            user_annotations = sum(count for subtype, count in annotation_types.items()
                                   if subtype not in ("/Link", "/Widget"))
            summaries.append({"pageIndex": index, "textCharacters": len(text),
                "chineseCharacters": sum("\u4e00" <= char <= "\u9fff" for char in text),
                "width": float(page.mediabox.width), "height": float(page.mediabox.height),
                "rotation": page.rotation, "annotations": len(annotations or []),
                "annotationTypes": annotation_types, "userAnnotations": user_annotations})
        result["samplePages"] = summaries
        result["chinese"] = any(s["chineseCharacters"] > 30 for s in summaries)
        result["imageOnlyCandidate"] = all(s["textCharacters"] < 20 for s in summaries)
        result["existingAnnotationsOnSamplePages"] = sum(s["userAnnotations"] for s in summaries)
    except Exception as error:
        result["inspectionError"] = str(error)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--count", type=int, default=30)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    inventory = []
    for index, path in enumerate(sorted(args.source.glob("*.pdf"))):
        item = inspect(path)
        inventory.append(item)
        print(f"Inspected {index+1}: {item.get('pages')} pages; {path.name}", flush=True)
    (args.output / "source-inventory.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2), encoding="utf-8")
    valid = [x for x in inventory if not x.get("inspectionError")]
    unique = list({x["sha256"]: x for x in valid}.values())
    selected = []

    def add(items):
        for item in items:
            if len(selected) >= args.count:
                break
            if item not in selected:
                selected.append(item)

    add(sorted(unique, key=lambda x: x["pages"], reverse=True)[:3])
    add([x for x in unique if x["imageOnlyCandidate"]])
    add([x for x in unique if x["existingAnnotationsOnSamplePages"]][:5])
    add([x for x in unique if x["chinese"]][:8])
    add(sorted(unique, key=lambda x: x["bytes"], reverse=True)[:4])
    add(sorted(unique, key=lambda x: x["pages"])[:4])
    add(unique)
    samples = []
    for index, item in enumerate(selected, 1):
        sample_id = f"sample-{index:02d}"
        target = args.output / "originals" / f"{sample_id}.pdf"
        target.parent.mkdir(exist_ok=True)
        shutil.copyfile(item["sourcePath"], target)
        copied_hash = sha256(target)
        if copied_hash != item["sha256"]:
            raise RuntimeError(f"Copy hash mismatch: {target}")
        samples.append({**item, "id": sample_id, "copyPath": str(target.resolve()), "copyHashVerified": True})
    manifest = {"schemaVersion": 1, "sourceDirectory": str(args.source.resolve()),
        "sourceCount": len(inventory), "validUniqueCount": len(unique), "sampleCount": len(samples),
        "selection": "Long documents, image-only candidates, existing annotations, Chinese, large and short papers, then stable filename order", "samples": samples}
    (args.output / "samples.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"sourceCount":len(inventory), "sampleCount":len(samples),
        "pages":sum(x["pages"] for x in samples), "chinese":sum(x["chinese"] for x in samples),
        "imageOnlyCandidates":sum(x["imageOnlyCandidate"] for x in samples),
        "withExistingAnnotationsOnSamplePages":sum(bool(x["existingAnnotationsOnSamplePages"]) for x in samples)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
