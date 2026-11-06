#!/usr/bin/env node
// Stop one isolated verification instance started by tools/run-isolated.mjs.
// Only process ids from the QA run record are accepted; the user's Desktop
// Harness and its backend are never targeted.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(toolsDir, '..')
const qaDir = path.join(pluginRoot, 'qa')

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i]
  if (!token.startsWith('--')) continue
  const value = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : 'true'
  args[token.slice(2)] = value
  if (value !== 'true') i += 1
}

let pid = Number(args.pid)
if (!pid) {
  const record = JSON.parse(readFileSync(path.join(qaDir, 'last-run.json'), 'utf8'))
  pid = record.hostPid
}
if (!Number.isInteger(pid) || pid <= 0) throw new Error('No isolated host pid')
if (process.platform === 'win32') {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    console.log(`stopped isolated host tree ${pid}`)
  } catch (error) {
    console.log(`isolated host ${pid} was already stopped`)
  }
} else {
  try {
    process.kill(pid, 'SIGTERM')
    console.log(`stopped isolated host ${pid}`)
  } catch {
    console.log(`isolated host ${pid} was already stopped`)
  }
}
