import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { writeFile } from 'node:fs/promises'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { lockLibrary } from '../src/storage/library-lock.mjs'
import { prepareStorageLocation, migrateStorageLocation } from '../plugins/dsh-paper-workbench/storage-location.js'
import { Config } from '../plugins/dsh-paper-workbench/index.js'

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'pw-location-test-'))
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()))
    assert.ok(path.basename(root).startsWith('pw-location-test-'))
    rmSync(root, { recursive:true, force:true })
  })
  const from = path.join(root, 'source'), to = path.join(root, 'destination')
  mkdirSync(path.join(from, 'files'), {recursive:true})
  mkdirSync(path.join(from, 'harness-conversations'), {recursive:true})
  const db = new DatabaseSync(path.join(from, 'library.sqlite'))
  db.exec("CREATE TABLE digests (id TEXT PRIMARY KEY, body TEXT); INSERT INTO digests VALUES ('stable-id', 'synthetic shared digest')")
  db.close()
  writeFileSync(path.join(from, 'files', 'stable-hash.pdf'), '%PDF-1.7\nSynthetic fixture bytes, not a research paper.')
  writeFileSync(path.join(from, 'harness-conversations', 'note.md'), 'Synthetic working file')
  writeFileSync(path.join(from, 'server-session.json'), '{"port":12345}')
  const original = readFileSync(path.join(from, 'library.sqlite'))
  return {root,from,to,original,plan:prepareStorageLocation(from,to)}
}
const options = {lockLibrary}

test('native settings schema keeps legacy plugin options and defaults to no migration', () => {
  const config = Config({dataRoot:'existing',autoRead:false})
  assert.equal(config.storageLocation.get() ?? null,null)
  const plan = {from:'source',to:'destination',id:'plan-id'}
  assert.deepEqual(Config({storageLocation:plan}).storageLocation.get(),plan)
  assert.equal(config.dataRoot,'existing')
  assert.equal(config.autoRead,false)
  assert.throws(()=>Config({storageLocation:{to:'incomplete'}}))
})

test('storage locations reject relative, nested and populated destinations; same path cancels a pending change', async t => {
  const f = fixture(t)
  for (const value of ['relative', path.join(f.from,'nested'), f.root]) assert.throws(()=>prepareStorageLocation(f.from,value))
  mkdirSync(f.to);writeFileSync(path.join(f.to,'keep.txt'),'keep')
  assert.throws(()=>prepareStorageLocation(f.from,f.to),/不是空/)
  const cancel = prepareStorageLocation(f.from, f.from)
  assert.equal(await migrateStorageLocation(cancel,options),f.from)
  assert.equal(readFileSync(path.join(f.to,'keep.txt'),'utf8'),'keep')
})

test('closed library, stable records, PDFs and Agent working files copy intact; retries preserve subsequent destination writes', async t => {
  const f = fixture(t), progress=[]
  await migrateStorageLocation(f.plan,{...options,progress:value=>progress.push(value)})
  assert.deepEqual(readFileSync(path.join(f.to,'library.sqlite')),f.original)
  assert.deepEqual(readFileSync(path.join(f.from,'library.sqlite')),f.original)
  assert.deepEqual(readFileSync(path.join(f.to,'files/stable-hash.pdf')),readFileSync(path.join(f.from,'files/stable-hash.pdf')))
  assert.equal(readFileSync(path.join(f.to,'harness-conversations/note.md'),'utf8'),'Synthetic working file')
  assert.equal(existsSync(path.join(f.to,'server-session.json')),false)
  assert.equal(existsSync(path.join(f.to,'.server.lock')),false)
  assert.equal(progress.at(-1).phase,'complete')
  const db = new DatabaseSync(path.join(f.to,'library.sqlite'))
  assert.equal(db.prepare('SELECT body FROM digests WHERE id=?').get('stable-id').body,'synthetic shared digest')
  db.exec("UPDATE digests SET body='new destination digest'");db.close()
  await migrateStorageLocation(f.plan,options)
  const after = new DatabaseSync(path.join(f.to,'library.sqlite'))
  assert.equal(after.prepare('SELECT body FROM digests').get().body,'new destination digest');after.close()
})

test('an open source library blocks migration without changing the destination', async t => {
  const f=fixture(t), release=lockLibrary(f.from)
  try {await assert.rejects(migrateStorageLocation(f.plan,options),/另一个本地服务/)} finally {release()}
  assert.equal(existsSync(f.to),false)
  assert.deepEqual(readFileSync(path.join(f.from,'library.sqlite')),f.original)
})

test('copy failure leaves the source usable, removes only the owned staging folder and allows retry', async t => {
  const f=fixture(t)
  await assert.rejects(migrateStorageLocation(f.plan,{...options,copy:async()=>{throw new Error('simulated disk full')}}),/disk full/)
  assert.equal(existsSync(f.to),false)
  assert.equal(readdirSync(f.root).filter(name=>name.includes('.paper-workbench-')).length,0)
  assert.deepEqual(readFileSync(path.join(f.from,'library.sqlite')),f.original)
  const release=lockLibrary(f.from);release()
  await migrateStorageLocation(f.plan,options)
  assert.deepEqual(readFileSync(path.join(f.to,'library.sqlite')),f.original)
})

test('corrupt copies are rejected before the new location becomes visible', async t => {
  const f=fixture(t)
  await assert.rejects(migrateStorageLocation(f.plan,{...options,copy:async(_,to)=>writeFile(to,'corrupt')}),/校验失败/)
  assert.equal(existsSync(f.to),false)
  assert.deepEqual(readFileSync(path.join(f.from,'library.sqlite')),f.original)
})

test('a destination populated during copying is never overwritten', async t => {
  const f=fixture(t)
  await assert.rejects(migrateStorageLocation(f.plan,{...options,progress(value){
    if(value.phase==='copying'&&value.copiedFiles===value.totalFiles){mkdirSync(f.to);writeFileSync(path.join(f.to,'keep.txt'),'keep')}
  }}))
  assert.equal(readFileSync(path.join(f.to,'keep.txt'),'utf8'),'keep')
  assert.deepEqual(readFileSync(path.join(f.from,'library.sqlite')),f.original)
})

test('interrupted owned staging can recover; foreign staging is preserved', async t => {
  const f=fixture(t), stage=path.join(f.root,`.destination.paper-workbench-${f.plan.id}`)
  mkdirSync(stage);writeFileSync(path.join(stage,'.paper-workbench-location.json'),JSON.stringify({...f.plan,complete:false}));writeFileSync(path.join(stage,'partial.bin'),'partial')
  await migrateStorageLocation(f.plan,options)
  assert.equal(existsSync(path.join(f.to,'partial.bin')),false)
  const other=prepareStorageLocation(f.from,path.join(f.root,'other')), foreign=path.join(f.root,`.other.paper-workbench-${other.id}`)
  mkdirSync(foreign);writeFileSync(path.join(foreign,'keep.txt'),'keep')
  await assert.rejects(migrateStorageLocation(other,options),/不属于本次/)
  assert.equal(readFileSync(path.join(foreign,'keep.txt'),'utf8'),'keep')
})

test('unexpected source changes abort the switch', async t => {
  const f=fixture(t)
  await assert.rejects(migrateStorageLocation(f.plan,{...options,progress(value){
    if(value.phase==='copying'&&value.copiedFiles===value.totalFiles)writeFileSync(path.join(f.from,'late.md'),'external edit')
  }}),/发生变化/)
  assert.equal(existsSync(f.to),false)
})

test('directory links are rejected and the linked files are untouched', async t => {
  const f=fixture(t), link=path.join(f.root,'link')
  try {symlinkSync(f.from,link,'junction')} catch(error){if(error.code==='EPERM'){t.skip('Directory link creation unavailable');return}throw error}
  assert.throws(()=>prepareStorageLocation(f.from,path.join(link,'nested')),/链接/)
  assert.deepEqual(readFileSync(path.join(f.from,'library.sqlite')),f.original)
})

test('shutdown aborts an unfinished migration and releases the original library', async t => {
  const f=fixture(t), controller=new AbortController()
  await assert.rejects(migrateStorageLocation(f.plan,{...options,signal:controller.signal,progress(){controller.abort()}}),/迁移已停止/)
  assert.equal(existsSync(f.to),false)
  const release=lockLibrary(f.from);release()
})
