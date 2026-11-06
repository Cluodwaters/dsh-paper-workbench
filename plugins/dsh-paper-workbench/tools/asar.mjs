#!/usr/bin/env node
// Minimal read-only ASAR archive reader used to inspect the installed DeepSeek
// Harness package sources while developing this plugin. It never writes the
// archive; extraction targets a caller-provided directory.
import { readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

export function openAsar(file) {
  const buffer = readFileSync(file)
  if (buffer.length < 16) throw new Error('not an asar archive')
  // This Electron/asar variant encodes two size pickles before the header
  // string: [u32 pickle=4][u32 header+8][u32 header+4][u32 header].
  const headerPickleSize = buffer.readUInt32LE(0)
  if (headerPickleSize !== 4) throw new Error(`unexpected asar header: ${headerPickleSize}`)
  const headerSize = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + headerSize).toString('utf8'))
  const dataOffset = 16 + headerSize
  return { buffer, header, dataOffset }
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const rel = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, rel, out)
    else out.push({ rel, size: entry.size ?? 0, offset: entry.offset, unpacked: entry.unpacked })
  }
  return out
}

export function listAsar(file) {
  const { header } = openAsar(file)
  return walk(header, '', [])
}

export function readAsarFile(archive, rel) {
  const { buffer, dataOffset } = archive
  let node = archive.header
  for (const part of rel.split('/')) {
    node = node.files?.[part]
    if (!node) throw new Error(`no such entry: ${rel}`)
  }
  if (node.files) throw new Error(`entry is a directory: ${rel}`)
  const start = dataOffset + Number(node.offset || 0)
  return buffer.subarray(start, start + Number(node.size || 0))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , command, file, ...rest] = process.argv
  if (!file) {
    console.error('usage: node asar.mjs <list|extract|cat> <archive> [filter] [outDir]')
    process.exit(2)
  }
  const archive = openAsar(file)
  const entries = listAsar(file)
  if (command === 'list') {
    const filter = rest[0]
    for (const entry of entries) {
      if (filter && !entry.rel.includes(filter.replaceAll('\\', '/'))) continue
      console.log(`${entry.size}\t${entry.rel}`)
    }
  } else if (command === 'cat') {
    process.stdout.write(readAsarFile(archive, rest[0]))
  } else if (command === 'extract') {
    const filter = rest[0] || ''
    const outDir = rest[1]
    if (!outDir) {
      console.error('usage: node asar.mjs extract <archive> <filter> <outDir>')
      process.exit(2)
    }
    let count = 0
    for (const entry of entries) {
      if (filter && !entry.rel.includes(filter.replaceAll('\\', '/'))) continue
      if (entry.unpacked) continue
      const target = path.join(outDir, entry.rel)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, readAsarFile(archive, entry.rel))
      count += 1
    }
    console.log(`extracted ${count} files to ${outDir}`)
  } else if (command === 'extract-regex') {
    const [, , , , filterSource, outDir] = process.argv
    if (!filterSource || !outDir) {
      console.error('usage: node asar.mjs extract-regex <archive> <filterRegex> <outDir>')
      process.exit(2)
    }
    const filter = new RegExp(filterSource)
    let count = 0
    for (const entry of entries) {
      if (!filter.test(entry.rel)) continue
      if (entry.unpacked) continue
      const target = path.join(outDir, entry.rel)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, readAsarFile(archive, entry.rel))
      count += 1
    }
    console.log(`extracted ${count} files to ${outDir}`)
  } else {
    console.error(`unknown command: ${command}`)
    process.exit(2)
  }
}

export function findEntries(archive, entries, filter) {
  return entries.filter((entry) => !filter || entry.rel.includes(filter.replaceAll('\\', '/')))
}

export function statSafe(file) {
  try {
    return statSync(file)
  } catch {
    return undefined
  }
}

export function readDirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
