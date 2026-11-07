import { constants, createReadStream, existsSync, lstatSync, readdirSync, realpathSync, readFileSync, mkdirSync, rmSync, rmdirSync, renameSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, lstat } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const MARKER = '.paper-workbench-location.json'
const TRANSIENT = new Set(['.server.lock', 'server-session.json', 'library.sqlite-shm', MARKER])
const key = value => process.platform === 'win32' ? value.toLowerCase() : value
export const sameLocation = (a, b) => Boolean(a && b) && key(path.resolve(a)) === key(path.resolve(b))

function absolute(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !path.isAbsolute(value.trim()))
    throw new Error('请输入本机的完整绝对路径，例如 D:\\PaperLibrary\\data。')
  const result = path.resolve(value.trim())
  if (result === path.parse(result).root || /^\\\\/.test(result))
    throw new Error('请选择本机磁盘中的专用文件夹，不能使用磁盘根目录或网络共享。')
  return result
}

// A path may contain missing parents, but no existing component may redirect
// into another directory. The same check is repeated at the publication boundary.
function noLinks(directory) {
  let current = directory
  while (true) {
    if (existsSync(current)) {
      const stat = lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('保存位置及其父目录必须是普通文件夹，不能是目录链接。')
      if (!sameLocation(realpathSync.native(current), current)) throw new Error('保存位置不能经过目录链接。')
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

function contains(parent, child) {
  const relative = path.relative(key(parent), key(child))
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function checkedPlan(input) {
  if (!input || typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.id)) throw new Error('保存位置迁移记录无效。')
  const from = absolute(input.from), to = absolute(input.to)
  noLinks(from)
  noLinks(to)
  if (!sameLocation(from, to) && (contains(from, to) || contains(to, from)))
    throw new Error('新旧资料目录不能互相包含，请选择其他位置。')
  return { id: input.id, from, to }
}

function markerAt(directory) {
  try { return JSON.parse(readFileSync(path.join(directory, MARKER), 'utf8')) } catch { return null }
}
const owns = (marker, plan) => marker?.id === plan.id && sameLocation(marker.from, plan.from) && sameLocation(marker.to, plan.to)
export function storageMigrationComplete(input) {
  if (!input) return false
  const marker = markerAt(input.to)
  return (sameLocation(input.from, input.to) || (owns(marker, input) && marker?.complete === true)) && existsSync(path.join(input.to, 'library.sqlite'))
}

export function prepareStorageLocation(from, requested) {
  const plan = checkedPlan({ from, to: requested, id: randomUUID() })
  if (!existsSync(path.join(plan.from, 'library.sqlite'))) throw new Error('当前资料库尚未就绪，请稍后再修改保存位置。')
  if (!sameLocation(plan.from, plan.to) && existsSync(plan.to) && readdirSync(plan.to).length)
    throw new Error('目标文件夹不是空的。请选择空文件夹，避免覆盖已有资料。')
  return plan
}

async function inventory(root, relative = '') {
  const result = []
  for (const name of readdirSync(path.join(root, relative))) {
    if (!relative && TRANSIENT.has(name)) continue
    const entry = path.join(relative, name), stat = await lstat(path.join(root, entry))
    if (stat.isSymbolicLink()) throw new Error(`资料目录中含有链接，未进行迁移：${entry}`)
    if (stat.isDirectory()) result.push(...await inventory(root, entry))
    else if (stat.isFile()) result.push({ entry, size: stat.size, modified: stat.mtimeMs })
    else throw new Error(`资料目录中含有不支持的文件：${entry}`)
  }
  return result.sort((a, b) => a.entry.localeCompare(b.entry))
}
async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Copy a closed library into a sibling staging directory, then publish it by
 * rename. The old library is retained. A completed marker makes restart retries
 * idempotent; an interrupted, owned staging directory can be safely rebuilt. */
export async function migrateStorageLocation(input, { lockLibrary, progress = () => {}, signal, copy = copyFile } = {}) {
  const plan = checkedPlan(input)
  if (storageMigrationComplete(plan)) return plan.to
  if (!existsSync(path.join(plan.from, 'library.sqlite'))) throw new Error('原资料库不存在；已停止切换，未创建空资料库。')
  if (existsSync(plan.to) && readdirSync(plan.to).length) throw new Error('目标文件夹已包含文件；原资料库保持不变。')
  const stage = path.join(path.dirname(plan.to), `.${path.basename(plan.to)}.paper-workbench-${plan.id}`)
  const checkAbort = () => { if (signal?.aborted) throw new Error('资料迁移已停止，原资料库保持不变。') }
  // Reuse the backend's actual writer lock, including stale-lock recovery.
  const release = lockLibrary(plan.from)
  let published = false
  function removeOwnedStage() {
    if (!existsSync(stage)) return
    noLinks(stage)
    if (!owns(markerAt(stage), plan) || path.dirname(stage) !== path.dirname(plan.to))
      throw new Error('迁移临时目录不属于本次操作，未删除其中的文件。')
    rmSync(stage, { recursive: true, force: true })
  }
  try {
    checkAbort()
    mkdirSync(path.dirname(plan.to), { recursive: true })
    noLinks(path.dirname(plan.to))
    removeOwnedStage()
    mkdirSync(stage)
    writeFileSync(path.join(stage, MARKER), JSON.stringify({ ...plan, complete: false }), { flag: 'wx' })
    const files = await inventory(plan.from)
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    let copiedBytes = 0, copiedFiles = 0
    progress({ phase: 'copying', copiedFiles, totalFiles: files.length, copiedBytes, totalBytes })
    for (const file of files) {
      checkAbort()
      const source = path.join(plan.from, file.entry), destination = path.join(stage, file.entry)
      await mkdir(path.dirname(destination), { recursive: true })
      await copy(source, destination, constants.COPYFILE_EXCL)
      const [sourceHash, destinationHash] = await Promise.all([digest(source), digest(destination)])
      if (sourceHash !== destinationHash) throw new Error(`迁移校验失败：${file.entry}`)
      copiedBytes += file.size
      copiedFiles += 1
      progress({ phase: 'copying', copiedFiles, totalFiles: files.length, copiedBytes, totalBytes })
    }
    checkAbort()
    if (JSON.stringify(files) !== JSON.stringify(await inventory(plan.from))) throw new Error('复制期间原资料目录发生变化，已停止切换。')
    writeFileSync(path.join(stage, MARKER), JSON.stringify({ ...plan, complete: true, files: copiedFiles, bytes: copiedBytes }))
    noLinks(plan.to)
    if (existsSync(plan.to)) rmdirSync(plan.to) // Only removes an empty directory; never merges or overwrites one.
    renameSync(stage, plan.to)
    published = true
    progress({ phase: 'complete', copiedFiles, totalFiles: files.length, copiedBytes, totalBytes })
    return plan.to
  } finally {
    try { if (!published) removeOwnedStage() } finally { release() }
  }
}
