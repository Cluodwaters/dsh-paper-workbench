#!/usr/bin/env node
// Read-only integration check against an installed dshmarket implementation.
// Uses the proposed catalog entry until it is merged; does not claim public indexing.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2]?.replace(/^--/, ''), process.argv[3 + i * 2]]))
for (const key of ['market', 'profile-dir', 'expect-current', 'expect-latest', 'expect-update']) {
  assert.ok(args[key], `Missing --${key}`)
}
assert.ok(['true', 'false'].includes(args['expect-update']), '--expect-update must be true or false')
const market = path.resolve(args.market)
const profile = path.resolve(args['profile-dir'])
const { setActiveRegion, activeRegion } = await import(pathToFileURL(path.join(market, 'lib/regions.js')))
if (args.region) {
  assert.ok(['global', 'china'].includes(args.region), '--region must be global or china')
  setActiveRegion(args.region)
}
const require = createRequire(path.join(market, 'package.json'))
const { load } = require('js-yaml')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const entry = load(readFileSync(path.join(root, 'docs/marketplace/Cluodwaters__dsh-paper-workbench--plugins-dsh-paper-workbench.yml'), 'utf8'))
const name = 'dsh-paper-workbench'
const desired = JSON.parse(readFileSync(path.join(profile, 'package.json'), 'utf8'))
const spec = desired.dependencies?.[name]
assert.equal(typeof spec, 'string', 'Profile must contain a real installed plugin')
const { catalogReleaseSourceOf, publishedReleaseUpdate } = await import(pathToFileURL(path.join(market, 'lib/release-updates.js')))
const { checkUpdates } = await import(pathToFileURL(path.join(market, 'lib/updates.js')))
const source = catalogReleaseSourceOf(spec, entry)
assert.ok(source, 'Installed source must match the catalog release channel')
assert.equal(source.manifest, 'plugins/dsh-paper-workbench/package.json', 'Monorepo root is not the plugin')
assert.equal(source.asset, 'dsh-paper-workbench-windows-x64.tgz')
// A wrong repo, an old version-specific filename, and a local file must not be adopted.
for (const invalid of [
  'https://github.com/someone-else/dsh-paper-workbench/releases/latest/download/dsh-paper-workbench-windows-x64.tgz',
  'https://github.com/Cluodwaters/dsh-paper-workbench/releases/download/v0.2.4/dsh-paper-workbench-0.2.4.tgz',
  'file:paper-workbench.tgz',
]) assert.equal(catalogReleaseSourceOf(invalid, entry), null)
const result = await checkUpdates('desktop', true, profile, new Map(), new Map(), new Map(), { releaseSources: new Map([[name, source]]) })
const actual = result[name]
assert.ok(actual, 'Market must report the plugin')
assert.equal(actual.version, args['expect-current'])
assert.equal(actual.latest, args['expect-latest'])
assert.equal(actual.updateAvailable, args['expect-update'] === 'true')
const release = await publishedReleaseUpdate(source, name)
assert.equal(release?.target, `https://github.com/Cluodwaters/dsh-paper-workbench/releases/download/v${args['expect-latest']}/${source.asset}`)
const report = {
  passed: true,
  marketVersion: JSON.parse(readFileSync(path.join(market, 'package.json'), 'utf8')).version,
  region: activeRegion(),
  catalog: 'proposed local entry, not evidence of public market indexing',
  installedSource: spec, releaseSource: source, release, update: actual,
}
if (args.out) writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
