from pathlib import Path
import sqlite3, hashlib, json
from pypdf import PdfReader
import pypdfium2 as pdfium

root = Path(__file__).resolve().parents[1]
output = root / 'output/desktop-qa/packaged-export.pdf'
library = root / 'data/stage3-qa'
db = sqlite3.connect(f'file:{(library / "library.sqlite").as_posix()}?mode=ro', uri=True)
managed, expected_hash = db.execute('SELECT managed_path,sha256 FROM attachments WHERE id=?', ('b0884063-dd0a-4090-bde7-32f106df268d',)).fetchone()
db.close()
source = library / managed
reader = PdfReader(output)
annotations = [ref.get_object() for page in reader.pages for ref in page.get('/Annots', [])]
visible = [a for a in annotations if a.get('/Subtype') != '/Popup']
assert len(reader.pages) == 3 and len(visible) == 6
assert any('第一阶段真实界面批注' in str(a.get('/Contents', '')) for a in visible)
assert hashlib.sha256(source.read_bytes()).hexdigest() == expected_hash
before, after = pdfium.PdfDocument(source), pdfium.PdfDocument(output)
same_pages = []
for index in range(3):
    a = before[index].render(scale=1, draw_annots=False).to_pil().convert('RGB')
    b = after[index].render(scale=1, draw_annots=False).to_pil().convert('RGB')
    same_pages.append(a.size == b.size and a.tobytes() == b.tobytes())
    a.close(); b.close()
before.close(); after.close()
assert all(same_pages)
result = dict(passed=True, pages=3, annotations=6, popupHelpers=len(annotations)-6,
              types=[str(a.get('/Subtype')) for a in visible], chineseCommentPreserved=True,
              originalPagePixelsUnchanged=same_pages, sourceHashUnchanged=True)
(root/'output/stage3-packaged-pdf-check.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result))
