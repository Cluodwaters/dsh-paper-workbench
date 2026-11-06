"""Generate synthetic unit-test PDFs without using a personal paper or library.

Requires pypdf. Run in a clean checkout; refuses to overwrite existing fixtures.
Generated files stay in the gitignored data/validation directory.
"""
from pathlib import Path

from pypdf import PdfWriter
from pypdf.annotations import Highlight, Text
from pypdf.generic import (
    ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject,
)

root = Path(__file__).resolve().parents[1]
validation = root / "data" / "validation"
base = validation / "originals" / "sample-10.pdf"
existing = validation / "fixtures" / "fixture-existing.pdf"
password = validation / "fixtures" / "fixture-password.pdf"
truncated = validation / "fixtures" / "fixture-truncated.pdf"
targets = [base, existing, password, truncated]
if any(target.exists() for target in targets):
    raise SystemExit("Existing test PDFs found; use a clean checkout. No files changed.")
for target in targets:
    target.parent.mkdir(parents=True, exist_ok=True)

writer = PdfWriter()
writer.add_metadata({"/Title": "Synthetic Paper Workbench Fixture", "/Author": "Test Fixture"})
for number in range(1, 3):
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    })
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
    })
    content = DecodedStreamObject()
    content.set_data(
        (f"BT /F1 12 Tf 60 720 Td (Synthetic test paper - page {number}) Tj "
         "0 -24 Td (No personal papers or research data are used.) Tj ET").encode("ascii")
    )
    page[NameObject("/Contents")] = content
writer.write(base)

annotated = PdfWriter(clone_from=base)
annotated.add_annotation(0, Highlight(
    rect=(60, 660, 240, 682),
    quad_points=ArrayObject([FloatObject(n) for n in (60, 682, 240, 682, 60, 660, 240, 660)]),
    highlight_color="fff176",
))
annotated.add_annotation(0, Text(
    rect=(40, 610, 62, 632),
    text="已有批注兼容性测试 / Existing note 中文",
))
annotated.write(existing)
encrypted = PdfWriter(clone_from=base)
encrypted.encrypt("phase1-test-only")
encrypted.write(password)
truncated.write_bytes(base.read_bytes()[:256])
print("Created four synthetic unit-test PDFs in data/validation.")
