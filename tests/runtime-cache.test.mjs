import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { parseRuntimeManifest, prepareRuntime, verifyRuntime } from '../plugins/dsh-paper-workbench/runtime-cache.js'

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'pw-runtime-test-'))
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()))
    assert.ok(path.basename(root).startsWith('pw-runtime-test-'))
    rmSync(root, { recursive: true, force: true })
  })
  const pluginRoot = path.join(root, 'plugin'), cacheRoot = path.join(root, 'cache')
  const bodies = { 'backend/src/server/main.mjs': 'export const fixture = 1', 'backend/node_modules/native/addon.node': 'synthetic native module', 'runtime/node.exe': 'synthetic executable' }
  function manifest() {
    const files = Object.entries(bodies).map(([relative, content]) => {
      const file = path.join(pluginRoot, 'resources', relative)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, content)
      return { path: relative, size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }
    }).sort((a, b) => a.path < b.path ? -1 : 1)
    return { schemaVersion: 1, key: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files }
  }
  return { root, pluginRoot, cacheRoot, bodies, manifest, options: { pluginRoot, cacheRoot, manifest: manifest() } }
}

test('execution files remain intact when pnpm replaces the entire source resources tree', async t => {
  const f = fixture(t), first = await prepareRuntime(f.options)
  assert.equal(first.reused, false)
  writeFileSync(path.join(f.pluginRoot, 'resources/runtime/node.exe'), 'changed source')
  assert.equal(readFileSync(first.nodeExecutable, 'utf8'), 'synthetic executable', 'must not use hard links')
  rmSync(path.join(f.pluginRoot, 'resources'), { recursive: true })
  const second = await prepareRuntime(f.options)
  assert.equal(second.root, first.root)
  assert.equal(second.reused, true)
  await verifyRuntime(second.root, f.options.manifest)
})

test('new resource generations publish alongside the running old generation', async t => {
  const f = fixture(t), first = await prepareRuntime(f.options)
  f.bodies['backend/src/server/main.mjs'] = 'export const fixture = 2'
  const second = await prepareRuntime({ ...f.options, manifest: f.manifest() })
  assert.notEqual(first.key, second.key)
  assert.notEqual(first.root, second.root)
  assert.equal(readFileSync(path.join(first.backendRoot, 'src/server/main.mjs'), 'utf8'), 'export const fixture = 1')
  assert.equal(readFileSync(path.join(second.backendRoot, 'src/server/main.mjs'), 'utf8'), 'export const fixture = 2')
})

test('corrupt or unexpectedly augmented caches are replaced without touching the existing generation', async t => {
  const f = fixture(t), first = await prepareRuntime(f.options)
  writeFileSync(first.nodeExecutable, 'damaged executable')
  const repaired = await prepareRuntime(f.options)
  assert.notEqual(repaired.root, first.root)
  assert.equal(readFileSync(first.nodeExecutable, 'utf8'), 'damaged executable')
  writeFileSync(path.join(repaired.backendRoot, 'extra.js'), 'unexpected')
  const clean = await prepareRuntime(f.options)
  assert.notEqual(clean.root, repaired.root)
  await verifyRuntime(clean.root, f.options.manifest)
})

test('bad source hashes and interrupted copies never publish a partial runtime, and retries work', async t => {
  const f = fixture(t)
  writeFileSync(path.join(f.pluginRoot, 'resources/runtime/node.exe'), 'bad source')
  await assert.rejects(prepareRuntime(f.options), /校验失败/)
  assert.deepEqual(readdirSync(f.cacheRoot), [])
  f.manifest()
  const controller = new AbortController()
  await assert.rejects(prepareRuntime({ ...f.options, signal: controller.signal, progress(value) { if (value.phase === 'copying') controller.abort() } }), { name: 'AbortError' })
  assert.deepEqual(readdirSync(f.cacheRoot), [])
  const result = await prepareRuntime(f.options)
  await verifyRuntime(result.root, f.options.manifest)
})

test('concurrent initializations only return complete generations', async t => {
  const f = fixture(t)
  const copies = await Promise.all([prepareRuntime(f.options), prepareRuntime(f.options)])
  for (const copy of copies) await verifyRuntime(copy.root, f.options.manifest)
  assert.equal(readdirSync(f.cacheRoot).some(name => name.startsWith('.staging-')), false)
})

test('manifest traversal, aliasing, and caches inside the package are rejected', async t => {
  const f = fixture(t)
  for (const relative of ['backend/../../escape', 'backend/C:/escape', 'backend/../escape', 'backend\\escape']) {
    const value = structuredClone(f.options.manifest)
    value.files[0].path = relative
    assert.throws(() => parseRuntimeManifest(value))
  }
  const duplicate = structuredClone(f.options.manifest)
  duplicate.files.push({ ...duplicate.files[0], path: duplicate.files[0].path.toUpperCase() })
  assert.throws(() => parseRuntimeManifest(duplicate))
  await assert.rejects(prepareRuntime({ ...f.options, cacheRoot: path.join(f.pluginRoot, 'cache') }), /目录之外/)
  const linked = path.join(f.root, 'linked-cache')
  symlinkSync(f.pluginRoot, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(prepareRuntime({ ...f.options, cacheRoot: linked }), /目录链接/)
})
