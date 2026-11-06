import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {projectRoot} from '../src/config.mjs';
const lockPath=path.join(projectRoot,'phase3-assets.lock.json');
const lock=existsSync(lockPath)?JSON.parse(await readFile(lockPath,'utf8')):{version:1,sources:{},files:[]};
async function download(url) {
  for(let attempt=0;attempt<4;attempt++) {
    try {const r=await fetch(url,{headers:{'User-Agent':'Paper-Workbench-build'},signal:AbortSignal.timeout(90000)});if(!r.ok)throw new Error(`${r.status} ${url}`);return Buffer.from(await r.arrayBuffer());}
    catch(error){if(attempt===3)throw error;}
  }
}
for(const [repo,branch,files] of [
  ['tesseract-ocr/tessdata_fast','main',[['eng.traineddata','ocr/eng.traineddata'],['chi_sim.traineddata','ocr/chi_sim.traineddata'],['LICENSE','licenses/tessdata-fast.txt']]],
  ['citation-style-language/styles','master',[['china-national-standard-gb-t-7714-2015-numeric.csl','csl/gb-t-7714-2015.csl'],['china-national-standard-gb-t-7714-2025-numeric.csl','csl/gb-t-7714-2025.csl'],['apa.csl','csl/apa.csl'],['ieee.csl','csl/ieee.csl']]],
  ['citation-style-language/locales','master',[['locales-en-US.xml','csl/locales-en-US.xml'],['locales-zh-CN.xml','csl/locales-zh-CN.xml'],['README.md','licenses/csl-locales.txt']]],
  ['nodejs/node','v25.8.1',[['LICENSE','licenses/node.txt']]],
]) {
  if(!lock.sources[repo]) lock.sources[repo]=JSON.parse((await download(`https://api.github.com/repos/${repo}/commits/${branch}`)).toString()).sha;
  await writeFile(lockPath,JSON.stringify(lock,null,2)+'\n');
  const tree=JSON.parse((await download(`https://api.github.com/repos/${repo}/git/trees/${lock.sources[repo]}`)).toString()).tree;
  for(const [source,target] of files) {
    const dest=path.join(projectRoot,'resources',target),known=lock.files.find(f=>f.target===target);
    if(existsSync(dest)&&known&&createHash('sha256').update(await readFile(dest)).digest('hex')===known.sha256)continue;
    const url=`https://raw.githubusercontent.com/${repo}/${lock.sources[repo]}/${source}`;
    const cdn=`https://cdn.jsdelivr.net/gh/${repo}@${lock.sources[repo]}/${source}`;
    const blob=tree.find(file=>file.path===source);if(!blob)throw new Error('Missing upstream resource '+source);
    const bytes=blob.size<1000000?Buffer.from(JSON.parse((await download(blob.url)).toString()).content,'base64'):await download(cdn);
    const gitHash=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if(gitHash!==blob.sha)throw new Error('Upstream blob verification failed: '+source);
    const sha256=createHash('sha256').update(bytes).digest('hex');
    if(known&&known.sha256!==sha256)throw new Error('Resource integrity mismatch: '+target);
    await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,bytes);
    if(!known)lock.files.push({target,url,sha256,bytes:bytes.length});
    await writeFile(lockPath,JSON.stringify(lock,null,2)+'\n');console.log(target,bytes.length);
  }
}
