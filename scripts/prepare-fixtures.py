"""Derived compatibility fixtures made exclusively from a copied sample PDF."""
from pathlib import Path
import hashlib
import json
import sys
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Highlight, Text
from pypdf.generic import ArrayObject, FloatObject, RectangleObject
import pypdfium2 as pdfium

sys.stdout.reconfigure(encoding='utf-8')
root=Path(__file__).resolve().parents[1]
folder=root/'data/validation/fixtures'
folder.mkdir(parents=True,exist_ok=True)
manifest=json.loads((root/'data/validation/samples.json').read_text(encoding='utf-8'))
base=next(x for x in manifest['samples'] if x['id']=='sample-10')
source=Path(base['copyPath'])
fixtures=[]
def record(key,name,pages,notes):
    target=folder/f'{key}.pdf'
    fixtures.append(dict(id=key,originalName=name,copyPath=str(target),sourcePath=base['sourcePath'],
        sourceParentHash=base['sha256'],sha256=hashlib.sha256(target.read_bytes()).hexdigest(),
        bytes=target.stat().st_size,pages=pages,pdfTitle=name,derived=True,notes=notes))

writer=PdfWriter(clone_from=source)
height=float(writer.pages[0].mediabox.height)
rect=(60,height-130,240,height-110)
highlight=Highlight(rect=rect,quad_points=ArrayObject([FloatObject(n) for n in (rect[0],rect[3],rect[2],rect[3],rect[0],rect[1],rect[2],rect[1])]),highlight_color='fff176')
writer.add_annotation(0,highlight)
writer.add_annotation(0,Text(rect=(40,height-180,62,height-158),text='已有批注兼容性测试 / Existing note 中文'))
writer.write(folder/'fixture-existing.pdf')
record('fixture-existing','已有高亮与中文批注（由副本制作）.pdf',len(writer.pages),'Independent pypdf Highlight and Text annotations; original annotations must survive export')

writer=PdfWriter(clone_from=source)
page=writer.pages[0]
page.cropbox=RectangleObject([24,30,float(page.mediabox.width)-24,float(page.mediabox.height)-30])
page.rotate(90)
writer.write(folder/'fixture-rotated.pdf')
record('fixture-rotated','旋转90度与裁剪框（由副本制作）.pdf',len(writer.pages),'First page rotated 90 degrees with non-zero CropBox')

document=pdfium.PdfDocument(source)
images=[]
for index in range(min(2,len(document))):
    page=document[index]
    image=page.render(scale=1.2).to_pil().convert('RGB')
    images.append(image)
images[0].save(folder/'fixture-scanned.pdf',save_all=True,append_images=images[1:],resolution=86.4)
record('fixture-scanned','纯图像扫描页面（由副本制作）.pdf',len(images),'Rasterized copied pages; no OCR text layer; text selection is not expected')
for image in images:image.close()
document.close()

writer=PdfWriter(clone_from=source)
writer.encrypt('phase1-test-only')
writer.write(folder/'fixture-password.pdf')
record('fixture-password','密码保护兼容性（由副本制作）.pdf',len(writer.pages),'Test-only password phase1-test-only; export without password must fail explicitly')

(folder/'fixture-truncated.pdf').write_bytes(source.read_bytes()[:256])
(root/'data/validation/fixtures.json').write_text(json.dumps({'schemaVersion':1,'samples':fixtures,'negativeFixture':str(folder/'fixture-truncated.pdf')},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'fixtures':len(fixtures),'negative':1,'sourceCopyUntouched':hashlib.sha256(source.read_bytes()).hexdigest()==base['sha256']},ensure_ascii=False))
