#!/usr/bin/env node
/**
 * Assemble the distributable Paper Workbench Harness bundle.
 *
 * The bundle ships:
 *  - the plugin halves, manifest, locale and icon;
 *  - the current root `src/` backend (including this round's Harness bridge);
 *  - the backend's external production dependencies, Zotero Reader build and
 *    OCR/CSL resources taken from the project's verified desktop staging;
 *  - the project-verified standalone Node 25.8.1 runtime.
 *
 * The output lives in plugins/dsh-paper-workbench/dist (gitignored) and is meant
 * to be installed from a directory outside the source checkout; the build writes
 * a provenance record with file hashes so the packaged bridge can be verified
 * independently.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(toolsDir, '..')
const repoRoot = path.resolve(pluginRoot, '..', '..')
const distRoot = path.join(pluginRoot, 'dist')
const staging = path.join(repoRoot, 'output', 'desktop-stage')
const stagedBackend = path.join(staging, 'backend')
const stagedRuntime = path.join(staging, 'runtime')

function assertInside(child, parent, label) {
  const relative = path.relative(parent, child)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} escapes ${parent}`)
}

function requireFile(file, label) {
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`missing ${label}: ${file}`)
  return file
}

function requireDir(dir, label) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`missing ${label}: ${dir}`)
  return dir
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function directorySize(dir) {
  let total = 0
  let files = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = directorySize(full)
      total += nested.total
      files += nested.files
    } else if (entry.isFile()) {
      total += statSync(full).size
      files += 1
    }
  }
  return { total, files }
}

assertInside(distRoot, pluginRoot, 'dist root')
if (existsSync(distRoot)) rmSync(distRoot, { recursive: true, force: true })
mkdirSync(distRoot, { recursive: true })

// 1. Plugin halves and display resources.
for (const file of ['index.js', 'agents.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md']) {
  const source = path.join(pluginRoot, file)
  if (!existsSync(source)) throw new Error(`missing plugin file: ${source}`)
  cpSync(source, path.join(distRoot, file))
}
const licenseSource = existsSync(path.join(pluginRoot, 'LICENSE'))
  ? path.join(pluginRoot, 'LICENSE')
  : requireFile(path.join(repoRoot, 'LICENSE'), 'project LICENSE')
cpSync(licenseSource, path.join(distRoot, 'LICENSE'))
cpSync(path.join(pluginRoot, 'locale'), path.join(distRoot, 'locale'), { recursive: true })

const manifest = JSON.parse(readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'))
manifest.files = [
  'index.js',
  'agents.js',
  'client.js',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'locale/*.json',
  'icon.svg',
  'resources/backend/**',
  'resources/runtime/**',
  'RESOURCES.json',
]
writeFileSync(path.join(distRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

// 2. Backend: fresh source from the checkout plus verified staged production
//    assets. The plugin does not modify the checked-in src.
const backendRoot = path.join(distRoot, 'resources', 'backend')
mkdirSync(backendRoot, { recursive: true })
cpSync(requireDir(path.join(repoRoot, 'src'), 'root src'), path.join(backendRoot, 'src'), { recursive: true })
cpSync(requireFile(path.join(stagedBackend, 'package.json'), 'staged backend package.json'), path.join(backendRoot, 'package.json'))
cpSync(requireFile(path.join(stagedBackend, 'package-lock.json'), 'staged lockfile'), path.join(backendRoot, 'package-lock.json'))
for (const directory of ['third_party', 'resources', 'node_modules']) {
  cpSync(requireDir(path.join(stagedBackend, directory), `staged backend ${directory}`), path.join(backendRoot, directory), {
    recursive: true,
  })
}
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'phase3-assets.lock.json', 'sources.lock.json', 'ARCHITECTURE.md', 'README.md']) {
  const source = path.join(stagedBackend, file)
  if (existsSync(source)) cpSync(source, path.join(backendRoot, file))
}

// 3. Standalone Node runtime verified by the project.
const runtimeRoot = path.join(distRoot, 'resources', 'runtime')
mkdirSync(runtimeRoot, { recursive: true })
cpSync(requireFile(path.join(stagedRuntime, 'node.exe'), 'staged Node runtime'), path.join(runtimeRoot, 'node.exe'))
if (existsSync(path.join(stagedRuntime, 'LICENSE.txt'))) cpSync(path.join(stagedRuntime, 'LICENSE.txt'), path.join(runtimeRoot, 'LICENSE.txt'))

// 4. Provenance record: packaged bridge files must match the checkout source.
const bridgeFiles = [
  'src/server/main.mjs',
  'src/server/integration.mjs',
  'src/server/ai-routes.mjs',
  'src/server/agent-routes.mjs',
  'src/server/index-routes.mjs',
  'src/application/ai-context-service.mjs',
  'src/application/paper-agent-service.mjs',
  'src/storage/agent-repository.mjs',
  'src/storage/migrations.mjs',
  'src/storage/migrations/004_agents.sql',
  'src/storage/migrations/005_agent_topics.sql',
  'src/domain/paper-agents.mjs',
  'src/adapters/zotero/ai-context.mjs',
  'src/web/harness-bridge.js',
  'src/web/url.js',
  'src/web/theme-init.js',
  'src/web/harness.css',
  'src/web/app.js',
  'src/web/reader-shell.css',
  'src/web/reader-toolbar.js',
]
const provenance = {
  schemaVersion: 1,
  builtAt: new Date().toISOString(),
  plugin: { name: manifest.name, version: manifest.version, files:Object.fromEntries(['index.js','agents.js','client.js'].map(file=>[file,sha256(path.join(distRoot,file))])) },
  backend: {
    sourceRoot: 'src/',
    files: Object.fromEntries(bridgeFiles.map((relative) => [relative, sha256(path.join(backendRoot, relative))])),
    packageVersion: JSON.parse(readFileSync(path.join(backendRoot, 'package.json'), 'utf8')).version,
  },
  runtime: {
    file: 'node.exe',
    version: execFileSync(path.join(runtimeRoot, 'node.exe'), ['--version'], { encoding: 'utf8' }).trim(),
    sha256: sha256(path.join(runtimeRoot, 'node.exe')),
  },
  resources: {
    readerBuild: 'third_party/zotero-reader/build/web',
    documentWorker: 'third_party/zotero-document-worker',
    ocr: 'resources/ocr',
    csl: 'resources/csl',
  },
}
writeFileSync(path.join(distRoot, 'RESOURCES.json'), `${JSON.stringify(provenance, null, 2)}\n`)
writeFileSync(path.join(backendRoot, 'HARNESS-PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`)

// 5. Report.
const backendSize = directorySize(backendRoot)
const runtimeSize = directorySize(runtimeRoot)
const totalSize = directorySize(distRoot)
console.log(JSON.stringify({
  distRoot,
  backendFiles: backendSize.files,
  backendMB: Number((backendSize.total / 1048576).toFixed(1)),
  runtimeMB: Number((runtimeSize.total / 1048576).toFixed(1)),
  totalFiles: totalSize.files,
  totalMB: Number((totalSize.total / 1048576).toFixed(1)),
  bridgeFiles: provenance.backend.files,
}, null, 2))
