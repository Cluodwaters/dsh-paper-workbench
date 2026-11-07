/** Verified execution copies outside the package manager's mutable install tree. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'

export const RUNTIME_MANIFEST = 'RUNTIME-MANIFEST.json'
const COMPLETE = '.paper-workbench-runtime.json'

export function defaultRuntimeCacheRoot() {
  return path.join(path.resolve(process.env.DSH_HOME || path.join(homedir(), '.dsh')), 'cache', 'dsh-paper-workbench', 'runtimes')
}

export function inside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

export function parseRuntimeManifest(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.files) || !value.files.length) throw Error('运行文件清单无效')
  const names = new Set()
  const files = value.files.map(file => {
    const relative = file?.path
    if (typeof relative !== 'string' || !/^(backend|runtime)\//.test(relative) || /[\\:\x00-\x1f]/.test(relative)
      || relative.split('/').some(part => !part || part === '.' || part === '..')
      || names.has(relative.toLowerCase()) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size < 0) throw Error('运行文件清单包含无效路径或哈希')
    names.add(relative.toLowerCase())
    return { path: relative, size: file.size, sha256: file.sha256 }
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const key = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  if (key !== value.key || !names.has('backend/src/server/main.mjs') || !names.has('runtime/node.exe')) throw Error('运行文件清单不完整或校验失败')
  return { schemaVersion: 1, key, files }
}

// Capture this generation's manifest before an update can replace package files.
export function readRuntimeManifest(pluginRoot) {
  return parseRuntimeManifest(JSON.parse(readFileSync(path.join(pluginRoot, RUNTIME_MANIFEST), 'utf8')))
}

async function hashFile(file, signal) {
  signal?.throwIfAborted()
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

async function ordinaryDirectory(directory) {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(`运行目录不能是目录链接：${directory}`)
}

async function checkParents(root, relative, checked) {
  let directory = root
  for (const part of relative.split('/').slice(0, -1)) {
    directory = path.join(directory, part)
    if (!checked.has(directory)) {
      await ordinaryDirectory(directory)
      checked.add(directory)
    }
  }
}

async function checkFile(root, file, parents, signal) {
  await checkParents(root, file.path, parents)
  const target = path.join(root, file.path)
  const stat = await lstat(target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || await hashFile(target, signal) !== file.sha256) {
    throw Error(`运行文件校验失败：${file.path}`)
  }
}

async function eachFile(files, action, signal) {
  let next = 0
  // Join all workers before removing a failed staging directory.
  const results = await Promise.allSettled(Array.from({ length: Math.min(4, files.length) }, async () => {
    for (;;) {
      signal?.throwIfAborted()
      const file = files[next++]
      if (!file) return
      await action(file)
    }
  }))
  const failed = results.find(result => result.status === 'rejected')
  if (failed) throw failed.reason
}

export async function verifyRuntime(root, manifest, signal) {
  await ordinaryDirectory(root)
  const parents = new Set()
  await eachFile(manifest.files, file => checkFile(root, file, parents, signal), signal)
  // A previously injected or accidentally generated JS/native file must not be reused.
  const expected = new Set(manifest.files.map(file => file.path))
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted()
      const relative = prefix + entry.name
      if (entry.isSymbolicLink()) throw Error('运行缓存包含目录链接')
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative + '/')
      else if (!entry.isFile() || (!expected.has(relative) && relative !== COMPLETE)) throw Error(`运行缓存含额外文件：${relative}`)
    }
  }
  await walk(root)
}

export async function prepareRuntime({ pluginRoot, manifest = readRuntimeManifest(pluginRoot), cacheRoot = defaultRuntimeCacheRoot(), signal, progress = () => {} }) {
  manifest = parseRuntimeManifest(manifest)
  const source = path.join(pluginRoot, 'resources')
  cacheRoot = path.resolve(cacheRoot)
  if (inside(cacheRoot, pluginRoot)) throw Error('运行缓存必须位于插件安装目录之外')
  await mkdir(cacheRoot, { recursive: true })
  await ordinaryDirectory(cacheRoot)
  if (inside(await realpath(cacheRoot), await realpath(pluginRoot))) throw Error('运行缓存不能指回插件安装目录')
  signal?.throwIfAborted()
  // Keep Windows executable paths below legacy CreateProcess limits on ordinary
  // profile paths. The full digest remains in the marker and every file is hashed.
  const prefix = manifest.key.slice(0, 24)
  const finish = (root, reused) => ({ key: manifest.key, root, cacheRoot, reused, backendRoot: path.join(root, 'backend'), nodeExecutable: path.join(root, 'runtime', 'node.exe') })
  const candidates = (await readdir(cacheRoot)).filter(name => new RegExp(`^${prefix}-[a-f0-9]{16}$`).test(name)).sort()
  for (const candidate of candidates) {
    const directory = path.join(cacheRoot, candidate)
    try {
      const marker = JSON.parse(await readFile(path.join(directory, COMPLETE), 'utf8'))
      if (marker.key !== manifest.key || marker.schemaVersion !== 1) continue
      progress({ phase: 'checking', key: manifest.key })
      await verifyRuntime(directory, manifest, signal)
      progress({ phase: 'ready', key: manifest.key, reused: true })
      return finish(directory, true)
    } catch {
      signal?.throwIfAborted()
      // Never modify an invalid/older generation: a running process may still own it.
    }
  }
  const id = randomUUID().replaceAll('-', '').slice(0, 16)
  const staging = path.join(cacheRoot, `.staging-${prefix}-${id}`)
  const destination = path.join(cacheRoot, `${prefix}-${id}`)
  await mkdir(staging)
  try {
    await ordinaryDirectory(source)
    const parents = new Set()
    let copied = 0
    await eachFile(manifest.files, async file => {
      await checkParents(source, file.path, parents)
      const original = path.join(source, file.path)
      const stat = await lstat(original)
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`无效运行文件：${file.path}`)
      const target = path.join(staging, file.path)
      await mkdir(path.dirname(target), { recursive: true })
      // A real copy, never a hard link: pnpm may remove or replace the original.
      await copyFile(original, target)
      await checkFile(staging, file, new Set(), signal)
      progress({ phase: 'copying', key: manifest.key, completed: ++copied, total: manifest.files.length })
    }, signal)
    signal?.throwIfAborted()
    await writeFile(path.join(staging, COMPLETE), JSON.stringify({ schemaVersion: 1, key: manifest.key }) + '\n', { flag: 'wx' })
    await rename(staging, destination)
    progress({ phase: 'ready', key: manifest.key, reused: false })
    return finish(destination, false)
  } catch (error) {
    // The only recursively removed directory is this invocation's unique staging root.
    if (path.dirname(staging) === cacheRoot && path.basename(staging) === `.staging-${prefix}-${id}`) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
    }
    throw error
  }
}
