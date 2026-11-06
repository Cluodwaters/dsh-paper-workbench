"""Independent verification with pypdf, PDFium and Poppler; no Zotero code imported."""
from __future__ import annotations
import collections
import gc
import hashlib
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import sqlite3
import shutil
import subprocess
import sys
import time

from PIL import Image, ImageChops
from pypdf import PdfReader
import pypdfium2 as pdfium

sys.stdout.reconfigure(encoding='utf-8',errors='replace')
logging.getLogger('pypdf').setLevel(logging.ERROR)
root=Path(__file__).resolve().parents[1]
data=root/'data/workspace'
out=root/'output'
evidence=out/'evidence'
evidence.mkdir(exist_ok=True)
temp=root/'.cache/render-checks'
temp.mkdir(parents=True,exist_ok=True)
poppler_path=os.environ.get('PAPER_WORKBENCH_PDFTOPPM') or shutil.which('pdftoppm')
if not poppler_path:raise RuntimeError('Set PAPER_WORKBENCH_PDFTOPPM or add Poppler pdftoppm to PATH')
poppler=Path(poppler_path)
poppler_version=subprocess.run([str(poppler),'-v'],capture_output=True,text=True).stderr.splitlines()[0]
connection=sqlite3.connect(data/'library.sqlite')
connection.row_factory=sqlite3.Row
records=connection.execute('''SELECT e.*,a.sample_key,a.managed_path,a.page_count,a.original_name FROM exports e
JOIN attachments a ON a.id=e.attachment_id WHERE e.id=(SELECT e2.id FROM exports e2 WHERE e2.attachment_id=e.attachment_id ORDER BY e2.created_at DESC LIMIT 1)
ORDER BY a.sample_key''').fetchall()

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def rendered(document,index,annotations=False):
    page=document[index]
    bitmap=page.render(scale=1,draw_annots=annotations)
    image=bitmap.to_pil().convert('RGB').copy()
    bitmap.close();page.close()
    return image
def difference(left,right):
    if left.size!=right.size:return {'equal':False,'sizeMismatch':[left.size,right.size]}
    diff=ImageChops.difference(left,right)
    histogram=diff.convert('L').histogram()
    pixels=left.width*left.height
    changed=pixels-histogram[0]
    exact=diff.getbbox() is None
    result={'equal':exact,'changedPixels':changed,'totalPixels':pixels,'changedFraction':changed/pixels}
    diff.close()
    return result
def poppler_render(pdf,prefix,annotations=False):
    command=[str(poppler),'-f','1','-l','1','-singlefile','-scale-to','1000','-cropbox','-png']
    if not annotations:command.append('-hide-annotations')
    result=subprocess.run(command+[str(pdf),str(prefix)],capture_output=True,timeout=90)
    if result.returncode:raise RuntimeError(result.stderr.decode('utf-8',errors='replace')[:700])
    with Image.open(prefix.with_suffix('.png')) as image:return image.convert('RGB').copy(),result.stderr.decode('utf-8',errors='replace')[:1000]
def raw_annotations(reader):
    result=[]
    for index,page in enumerate(reader.pages):
        for ref in page.get('/Annots',[]):
            item=ref.get_object()
            result.append((index,item))
    return result
def close_values(a,b,tolerance=.02):return len(a)==len(b) and all(abs(float(x)-float(y))<=tolerance for x,y in zip(a,b))
def native_signature(page,item):
    return json.dumps([page,str(item.get('/Subtype')),str(item.get('/Contents','')),
        [float(x) for x in item.get('/Rect',[])],[float(x) for x in item.get('/QuadPoints',[])]],ensure_ascii=False,sort_keys=True)

results=[]
start=time.time()
for record in records:
    source=data/record['managed_path'];target=data/record['relative_path']
    snapshot=json.loads(record['snapshot_json'])
    if not snapshot['annotations']:continue
    key=record['sample_key']
    result={'sampleKey':key,'exportId':record['id'],'exportPath':str(target),'revision':record['annotation_revision'],'issues':[]}
    try:
        result['sourceHashUnchanged']=sha(source)==record['source_hash']
        result['exportHashValid']=sha(target)==record['sha256']
        before=PdfReader(source,strict=False);after=PdfReader(target,strict=False)
        result['pageCountPreserved']=len(before.pages)==len(after.pages)==record['page_count']
        source_annotations=raw_annotations(before);export_annotations=raw_annotations(after)
        lookup={str(a.get('/Zotero:Key')):(page,a) for page,a in export_annotations if a.get('/Zotero:Key')}
        expected_types={'highlight':'/Highlight','underline':'/Underline','note':'/Text','image':'/Square','text':'/FreeText','ink':'/Ink'}
        matches=[]
        for item in snapshot['annotations']:
            if item.get('isExternal'):continue
            entry=lookup.get(item['id']);checks={}
            if entry:
                page,raw=entry
                checks={'type':raw.get('/Subtype')==expected_types[item['type']],
                    'page':page==item['position']['pageIndex'],
                    'comment':str(raw.get('/Contents',''))==item['comment']}
                rgb=[int(item['color'][n:n+2],16)/255 for n in (1,3,5)]
                checks['color']=close_values(raw.get('/C',[]),rgb,1e-5)
                if item['type'] in ('highlight','underline'):
                    quads=[]
                    for x0,y0,x1,y1 in item['position']['rects']:quads.extend([x0,y1,x1,y1,x0,y0,x1,y0])
                    checks['geometry']=close_values(raw.get('/QuadPoints',[]),quads)
                elif item['type'] in ('note','image','text'):
                    checks['geometry']=close_values(raw.get('/Rect',[]),item['position']['rects'][0],.05)
            matches.append({'id':item['id'],'type':item['type'],'passed':bool(checks) and all(checks.values()),'checks':checks})
        result['annotationChecks']=matches
        original_set=collections.Counter(native_signature(p,a) for p,a in source_annotations)
        exported_set=collections.Counter(native_signature(p,a) for p,a in export_annotations)
        result['originalAnnotationsPreserved']=not bool(original_set-exported_set)
        result['originalAnnotationCount']=len(source_annotations)
        pdf_source=pdfium.PdfDocument(source);pdf_export=pdfium.PdfDocument(target)
        result['pdfiumPages']=[]
        for index in sorted({0,len(before.pages)//2,len(before.pages)-1}):
            left=rendered(pdf_source,index);right=rendered(pdf_export,index)
            delta=difference(left,right);result['pdfiumPages'].append({'pageIndex':index,**delta})
            if not delta['equal']:
                left.save(evidence/f'{key}-page{index+1}-original.png');right.save(evidence/f'{key}-page{index+1}-export-base.png')
            left.close();right.close()
        base=rendered(pdf_export,0);annotated=rendered(pdf_export,0,True)
        result['pdfiumAnnotationsVisible']=not difference(base,annotated)['equal']
        if key in ('sample-01','sample-06','sample-10') or key.startswith('fixture-'):annotated.save(evidence/f'{key}-pdfium.png')
        base.close();annotated.close();pdf_source.close();pdf_export.close()
        p_source,warnings_source=poppler_render(source,temp/f'{key}-source')
        p_export,warnings_export=poppler_render(target,temp/f'{key}-export')
        result['popplerBasePage']=difference(p_source,p_export)
        p_annotated,warnings_annotated=poppler_render(target,temp/f'{key}-annotated',True)
        result['popplerAnnotationsVisible']=not difference(p_export,p_annotated)['equal']
        if key in ('sample-01','sample-06','sample-10') or key.startswith('fixture-'):p_annotated.save(evidence/f'{key}-poppler.png')
        result['popplerWarnings']=warnings_source or warnings_export or warnings_annotated
        p_source.close();p_export.close();p_annotated.close()
        checks=[result['sourceHashUnchanged'],result['exportHashValid'],result['pageCountPreserved'],result['originalAnnotationsPreserved'],
            all(x['passed'] for x in matches),all(x['equal'] for x in result['pdfiumPages']),result['pdfiumAnnotationsVisible'],
            result['popplerBasePage']['equal'],result['popplerAnnotationsVisible']]
        result['status']='passed' if all(checks) else 'failed'
    except Exception as error:result['status']='failed';result['issues'].append(str(error))
    results.append(result)
    print(json.dumps({'sample':key,'status':result['status'],'issues':result['issues']},ensure_ascii=False),flush=True)
    (out/'independent-export-checks.json').write_text(json.dumps({'results':results,'elapsedSeconds':round(time.time()-start,2),
        'engines':{'pypdf':importlib.metadata.version('pypdf'),'pypdfium2':importlib.metadata.version('pypdfium2'),'pdfium':str(pdfium.PDFIUM_INFO),'poppler':poppler_version}},ensure_ascii=False,indent=2),encoding='utf-8')
    gc.collect()
print(json.dumps({'checked':len(results),'passed':sum(x['status']=='passed' for x in results),'failed':sum(x['status']=='failed' for x in results)},ensure_ascii=False))
if any(x['status']=='failed' for x in results):sys.exit(1)
