#!/usr/bin/env node
// Minimal Chrome DevTools Protocol driver for isolated profile verification.
// It launches the locally installed Edge in headless mode, not a replacement
// browser for the product; the connected Harness GUI remains the primary UI.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const EDGE_CANDIDATES = [
  process.env.DSH_PAPER_WORKBENCH_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean)

export function findBrowser() {
  const found = EDGE_CANDIDATES.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`No headless browser found. Tried: ${EDGE_CANDIDATES.join(', ')}`)
  return found
}

function freePort() {
  // Pick a high port and let the browser retry-free bind; collisions are rare in
  // the isolated verification sandbox and reported if they happen.
  return 9300 + Math.floor(Math.random() * 400)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return await response.json()
    } catch {
      /* not up yet */
    }
    await sleep(150)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

export async function launchBrowser(options = {}) {
  const executablePath = options.executablePath || findBrowser()
  const port = options.port || freePort()
  const userDataDir = options.userDataDir || path.join(tmpdir(), `dsh-paper-workbench-edge-${process.pid}-${Date.now()}`)
  mkdirSync(userDataDir, { recursive: true })
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--window-size=1440,1000',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ]
  const child = spawn(executablePath, args, { stdio: 'ignore', windowsHide: true })
  const version = await waitForHttp(`http://127.0.0.1:${port}/json/version`, 20000)
  const list = await waitForHttp(`http://127.0.0.1:${port}/json/list`, 10000)
  const target = Array.isArray(list) ? list.find((entry) => entry.type === 'page') : undefined
  if (!target || !target.webSocketDebuggerUrl) throw new Error('No debuggable page target')
  const session = await CdpSession.connect(target.webSocketDebuggerUrl)
  return {
    child,
    port,
    session,
    userDataDir,
    async close() {
      try {
        session.close()
      } catch {
        /* already closed */
      }
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    },
  }
}

export class CdpSession {
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl)
      const session = new CdpSession(socket)
      socket.addEventListener('open', () => resolve(session))
      socket.addEventListener('error', (event) => reject(new Error(`CDP socket error: ${String(event?.message || event?.type)}`)))
    })
  }

  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
        else entry.resolve(message.result)
        return
      }
      const listeners = this.listeners.get(message.method)
      if (!listeners) return
      for (const listener of listeners) {
        try {
          listener(message.params)
        } catch {
          /* observer errors are not protocol errors */
        }
      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  on(method, listener) {
    const entries = this.listeners.get(method) || new Set()
    entries.add(listener)
    this.listeners.set(method, entries)
    return () => entries.delete(listener)
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* ignore */
    }
  }
}

export async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text
    throw new Error(`Evaluation failed: ${description}`)
  }
  return result.result.value
}

export async function waitFor(session, expression, options = {}) {
  const timeoutMs = options.timeoutMs || 20000
  const intervalMs = options.intervalMs || 120
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(session, expression)
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`Timed out (${timeoutMs}ms) waiting for ${expression}${lastError ? `; last error: ${lastError.message}` : ''}`)
}

export async function waitForLoad(session, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(session, 'document.readyState')
      if (state === 'complete') return
    } catch {
      /* navigation in progress */
    }
    await sleep(150)
  }
  throw new Error('Timed out waiting for document readyState')
}

export async function screenshot(session, file) {
  const { data } = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}
