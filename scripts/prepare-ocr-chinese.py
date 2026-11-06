from pathlib import Path
import json
import pypdfium2 as pdfium
root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'data/validation/samples.json').read_text(encoding='utf-8'))
source=next(x for x in manifest['samples'] if x['id']=='sample-06')
doc=pdfium.PdfDocument(source['copyPath'])
image=doc[0].render(scale=2.5).to_pil().convert('RGB')
target=root/'data/stage3-chinese-scanned.pdf'
image.save(target,resolution=180)
image.close();doc.close()
print(str(target))
