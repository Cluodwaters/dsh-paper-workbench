#!/usr/bin/env node
/**
 * Independent verification of the packaged bundle.
 *
 * Copies `dist/` to a temporary directory outside the source checkout, verifies
 * the packaged bridge files against the provenance record and the checkout
 * source, boots an isolated Web profile whose row points at the copied bundle,
 * and runs the full browser verification with assertions that the running
 * backend and runtime are the packaged copies. Optionally exercises the packaged
 * OCR model pipeline.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, cpSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(toolsDir, '..')
const repoRoot = path.resolve(pluginRoot, '..', '..')
const qaDir = path.join(pluginRoot, 'qa')
const outDir = path.join(qaDir, 'artifacts-package')

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i]
  if (!token.startsWith('--')) continue
  const value = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : 'true'
  args[token.slice(2)] = value
  if (value !== 'true') i += 1
}

const distInput = path.resolve(args.dist || path.join(pluginRoot, 'dist'))
if (!existsSync(path.join(distInput, 'package.json'))) throw new Error(`No packaged bundle at ${distInput}; run tools/package.mjs first`)
// pnpm installations expose a junction/symlink. Copy the actual package so the
// outside-checkout verification cannot accidentally depend on that installation.
const distRoot = realpathSync(distInput)
mkdirSync(outDir, { recursive: true })

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const tempRoot = args['work-dir']
  ? path.resolve(args['work-dir'])
  : path.join(tmpdir(), `dsh-paper-workbench-package-${stamp}`)
const packageRoot = path.join(tempRoot, 'dsh-paper-workbench')
const dataRoot = path.join(tempRoot, 'data')
mkdirSync(tempRoot, { recursive: true })
console.log(`Copying package to ${packageRoot}`)
cpSync(distRoot, packageRoot, { recursive: true })
mkdirSync(dataRoot, { recursive: true })

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const report = { distRoot, packageRoot, checks: [], failures: [], startedAt: new Date().toISOString() }
/** Never persist the temporary login URL: its `token` query authenticates a browser. */
function redactToken(value) {
  return String(value).replace(/([?&]token=)[^&\s"']+/gu, '$1<redacted>')
}
function check(name, fn) {
  try {
    const value = fn()
    report.checks.push(name)
    console.log(`PASS ${name}`)
    return value
  } catch (error) {
    report.failures.push({ check: name, error: error instanceof Error ? error.message : String(error) })
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

check('packaged bundle carries a plugin manifest without source-checkout paths', () => {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.name !== 'dsh-paper-workbench') throw new Error('unexpected package name')
  if (!manifest.dsh || !manifest.dsh.bundle || !manifest.dsh.client) throw new Error('bundle/client declarations missing')
  const text = JSON.stringify(manifest)
  if (/[A-Za-z]:\\\\/u.test(text) || /\\\\plugins\\\\/u.test(text)) throw new Error('absolute local path leaked into manifest')
})

check('packaged bridge files match the recorded provenance and the current checkout src', () => {
  const provenance = JSON.parse(readFileSync(path.join(packageRoot, 'RESOURCES.json'), 'utf8'))
  for (const [relative, expected] of Object.entries(provenance.backend.files)) {
    const packaged = path.join(packageRoot, 'resources', 'backend', relative)
    if (!existsSync(packaged)) throw new Error(`packaged bridge file missing: ${relative}`)
    const packagedHash = sha256(packaged)
    if (packagedHash !== expected) throw new Error(`packaged provenance mismatch: ${relative}`)
    const sourcePath = path.join(repoRoot, relative)
    if (existsSync(sourcePath) && sha256(sourcePath) !== packagedHash) {
      throw new Error(`packaged copy differs from current checkout src: ${relative}`)
    }
  }
  report.provenance = { runtime: provenance.runtime.version, builtAt: provenance.builtAt }
})

check('packaged bundle includes backend production dependencies, Reader build and OCR assets', () => {
  const required = [
    'resources/backend/node_modules/he/package.json',
    'resources/backend/node_modules/tesseract.js/package.json',
    'resources/backend/node_modules/@napi-rs/canvas/package.json',
    'resources/backend/node_modules/citeproc/package.json',
    'resources/backend/third_party/zotero-reader/build/web/reader.html',
    'resources/backend/third_party/zotero-reader/build/web/reader.js',
    'resources/backend/third_party/zotero-document-worker',
    'resources/backend/resources/ocr/chi_sim.traineddata',
    'resources/backend/resources/ocr/eng.traineddata',
    'resources/backend/resources/csl/apa.csl',
    'resources/backend/resources/licenses/tessdata-fast.txt',
    'resources/runtime/node.exe',
    'index.js',
    'agents.js',
    'client.js',
    'cordis.patch.yml',
    'locale/zh.json',
    'icon.svg',
    'LICENSE',
  ]
  for (const relative of required) {
    if (!existsSync(path.join(packageRoot, relative))) throw new Error(`missing packaged resource: ${relative}`)
  }
  report.resourcesChecked = required.length
})

const port = 43400 + Math.floor(Math.random() * 300)
console.log(`Booting isolated instance from the packaged copy on port ${port}`)
const startOutput = execFileSync(
  process.execPath,
  [
    path.join(toolsDir, 'run-isolated.mjs'),
    '--bundle',
    packageRoot,
    '--port',
    String(port),
    '--data-root',
    dataRoot,
    '--no-auto-read',
    '--unlock-llm',
  ],
  // Exercise composer admission in a clean profile without borrowing credentials.
  { encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: 'sk-isolated-qa-invalid' } },
)
const startLine = startOutput
  .trim()
  .split(/\r?\n/)
  .filter((line) => line.trim().startsWith('{'))
  .pop()
const started = JSON.parse(startLine)
report.url = redactToken(started.url)
report.hostPid = started.hostPid

let passed = false
try {
  const verifierArgs = [
    path.join(toolsDir, 'verify-isolated.mjs'),
    '--url',
    started.url,
    '--out',
    outDir,
    '--expect-backend-root',
    path.join(packageRoot, 'resources', 'backend'),
    '--expect-runtime',
    path.join(packageRoot, 'resources', 'runtime', 'node.exe'),
    '--expect-data-root',
    dataRoot,
  ]
  if (args['ocr-fixture']) verifierArgs.push('--ocr-fixture', path.resolve(args['ocr-fixture']))
  if (args.fixture) verifierArgs.push('--fixture',path.resolve(args.fixture))
  try {
    const verifierOutput = execFileSync(process.execPath, verifierArgs, { encoding: 'utf8' })
    console.log(verifierOutput)
    passed = true
    for (const line of verifierOutput.split(/\r?\n/)) {
      if (line.startsWith('PASS ')) report.checks.push(line.slice(5))
    }
  } catch (error) {
    report.failures.push({ check: 'packaged-browser-verification', error: redactToken(String(error.stdout || error.message).slice(-6000)) })
    console.error(String(error.stdout || error.message))
  }
  if (existsSync(path.join(outDir, 'isolated-report.json'))) {
    report.isolated = JSON.parse(readFileSync(path.join(outDir, 'isolated-report.json'), 'utf8'))
  }
} finally {
  try {
    execFileSync(process.execPath, [path.join(toolsDir, 'stop-isolated.mjs'), '--pid', String(started.hostPid)], { encoding: 'utf8' })
  } catch {
    console.log('isolated packaged instance already stopped')
  }
  report.passed = passed && report.failures.length === 0
  report.finishedAt = new Date().toISOString()
  writeFileSync(path.join(outDir, 'package-report.json'), JSON.stringify(report, null, 2))
  console.log(`Package verification ${report.passed ? 'PASSED' : 'FAILED'}: ${path.join(outDir, 'package-report.json')}`)
  if (!report.passed) process.exitCode = 1
  if (!args.keep) {
    try {
      const relative=path.relative(path.resolve(tmpdir()),path.resolve(tempRoot))
      if(args['work-dir'] || !relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(tempRoot).startsWith('dsh-paper-workbench-package-')) throw Error('preserve caller-provided or non-QA directory')
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      console.log(`Left temporary package at ${tempRoot}`)
    }
  } else {
    console.log(`Kept temporary package at ${tempRoot}`)
  }
}
