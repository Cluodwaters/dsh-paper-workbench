from pathlib import Path
import json
import numpy as np
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, NameObject
import pypdfium2 as pdfium

root=Path(__file__).resolve().parents[1]/'output/save-fix-qa'
reader=PdfReader(root/'ink-dot-export.pdf')
page=reader.pages[0]
dots=[]
for ref in page.get('/Annots',[]):
    ann=ref.get_object()
    if ann.get('/Subtype')=='/Ink' and any(len(stroke)==4 and list(stroke[:2])==list(stroke[2:]) for stroke in ann.get('/InkList',[])):
        dots.append(ref)
assert dots, 'No exported single-point ink annotation found'
page[NameObject('/Annots')]=ArrayObject(dots)
writer=PdfWriter();writer.add_page(page)
isolated=root/'ink-dot-isolated.pdf'
with isolated.open('wb') as target:writer.write(target)
pdf=pdfium.PdfDocument(str(isolated));rendered=pdf[0]
with_ink=rendered.render(scale=3,draw_annots=True).to_numpy()
without_ink=rendered.render(scale=3,draw_annots=False).to_numpy()
changed=int(np.count_nonzero(np.any(with_ink!=without_ink,axis=2)))
assert changed>0, 'The exported dot is invisible to independent PDFium rendering'
result={'passed':True,'pages':len(reader.pages),'dotAnnotations':len(dots),'visibleChangedPixels':changed,'renderer':'PDFium'}
(root/'independent-export-check.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(result))
