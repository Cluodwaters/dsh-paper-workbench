#!/usr/bin/env node
/**
 * Isolated-profile verification for the Paper Workbench Harness plugin.
 *
 * Boots the plugin through the documented `--patch` development overlay against
 * a shipped Web profile (no profile installation is performed), then drives the
 * real Web GUI in headless Edge/Chromium over CDP. Every step asserts observable
 * DOM/HTTP state; nothing is mocked and no screenshot stands in for a passing
 * check.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchBrowser, evaluate, waitFor, waitForLoad, screenshot } from './cdp.mjs'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(toolsDir, '..')
const repoRoot = path.resolve(pluginRoot, '..', '..')
const BASE = '/paper-workbench'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true'
    args[key] = value
    if (value !== 'true') i += 1
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const outDir = path.resolve(args.out || path.join(pluginRoot, 'qa', 'artifacts'))
mkdirSync(outDir, { recursive: true })
for (const entry of readdirSync(outDir)) {
  if (entry.endsWith('.png')) rmSync(path.join(outDir, entry), { force: true })
}
const fixtureFile = path.resolve(args.fixture || path.join(repoRoot, 'data', 'validation', 'fixtures', 'fixture-existing.pdf'))

function tokenUrlFromLog(logFile) {
  const text = readFileSync(logFile, 'utf8')
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('dsh web: '))
  const last = lines[lines.length - 1]
  if (!last) throw new Error(`No "dsh web:" line in ${logFile}`)
  return last.slice('dsh web: '.length)
}

const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  failures: [],
  consoleErrors: [],
  failedRequests: [],
  screenshots: [],
  notes: [],
  passed: false,
}

const pass = (name) => {
  report.checks.push(name)
  console.log(`PASS ${name}`)
}
const fail = (name, error) => {
  report.failures.push({ check: name, error: error instanceof Error ? error.stack || error.message : String(error) })
  console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
}

async function step(name, fn) {
  try {
    const value = await fn()
    pass(name)
    return value
  } catch (error) {
    fail(name, error)
    throw error
  }
}

async function main() {
  const url = args.url || tokenUrlFromLog(args.log || path.join(pluginRoot, 'qa', 'web.log'))
  if (!existsSync(fixtureFile)) throw new Error(`Fixture PDF missing: ${fixtureFile}`)
  const attachmentSourceExpected = readFileSync(fixtureFile)
  console.log(`Verifying ${url.replace(/([?&]token=)[^&]+/g,'$1<redacted>')}`)

  const browser = await launchBrowser()
  const { session } = browser
  const consoleErrors = []
  const failedRequests = []
  const ignoreUrl = (target) =>
    /\/api\/remote|\/api\/stream|\/connect\?|deepseek|telemetry|\/plugins\/\?\?/u.test(String(target || ''))
  session.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails || {}
    consoleErrors.push(details.exception?.description || details.text || 'unknown exception')
  })
  session.on('Log.entryAdded', (params) => {
    const entry = params.entry || {}
    if (entry.level === 'error' && !ignoreUrl(entry.url)) consoleErrors.push(entry.text)
  })
  session.on('Network.responseReceived', (params) => {
    const response = params.response || {}
    if (Number(response.status) >= 400 && !ignoreUrl(response.url)) {
      failedRequests.push({ url: response.url, status: response.status })
    }
  })

  try {
    await session.send('Page.enable')
    await session.send('Runtime.enable')
    await session.send('Log.enable')
    await session.send('Network.enable')
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await session.send('Page.navigate', { url })
    await waitForLoad(session)
    await session.send('Page.bringToFront').catch(() => {})

    /**
     * A fresh profile shows the harness onboarding dialogs over the app. Dismiss
     * them through their own controls (the same thing a user does) before driving
     * the native panel.
     */
    async function dismissOnboarding() {
      for (const label of ['继续', '开始使用', '关闭', '稍后', '跳过']) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const clicked = await evaluate(
            session,
            `(() => {
              const nodes = [...document.querySelectorAll("button, [role=button], [role=menuitem]")].filter((n) => n.offsetParent !== null)
              const node = nodes.find((n) => (n.textContent || "").trim() === ${JSON.stringify(label)})
                || nodes.find((n) => (n.textContent || "").includes(${JSON.stringify(label)}))
              if (!node) return false
              node.click()
              return true
            })()`,
          ).catch(() => false)
          if (!clicked) break
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
      return evaluate(
        session,
        `[...document.querySelectorAll("dialog[open], [role=dialog]")].filter((node) => node.offsetParent !== null).length`,
      )
    }

    await step('Harness Web app boots and exposes the Paper Workbench sidebar entry', async () => {
      await waitFor(
        session,
        `(() => {
          const label = (node) => [node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent].filter(Boolean).join(' ')
          return [...document.querySelectorAll('button, a')].some((node) => /文献工作台|Paper Workbench/u.test(label(node)))
        })()`,
        { timeoutMs: 30000 },
      )
      // Page.load precedes the asynchronously mounted welcome dialog in a fresh
      // profile. Wait for app readiness before dismissing it, or it traps focus
      // later when the native composer is exercised.
      await waitFor(session, `[...document.querySelectorAll("button")].some(n => n.offsetParent !== null && (n.textContent || '').trim() === '继续')`, { timeoutMs: 5000 }).catch(() => {})
      await dismissOnboarding()
      await waitFor(session, `[...document.querySelectorAll("dialog[open], [role=dialog]")].every(n => n.offsetParent === null)`, { timeoutMs: 15000 })
      // Preparing/verifying the independent runtime is asynchronous. Readiness,
      // not the mounting of the shell UI, admits the first library operation.
      await waitFor(session, `(async () => { const r = await fetch('${BASE}/__workbench/status'); return r.ok && (await r.json()).ready })()`, { timeoutMs: 120000 })
    })

    const importedPaper = await step('Synthetic derived PDF imports and indexes through the host proxy', async () => {
      const base64 = attachmentSourceExpected.toString('base64')
      const imported = await evaluate(
        session,
        `(async () => {
          const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0))
          const response = await fetch('${BASE}/api/library/import-pdf', {
            method: 'POST',
            headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Harness 合成验证.pdf') },
            body: bytes,
          })
          return { status: response.status, body: await response.json() }
        })()`,
      )
      if (!imported || (imported.status !== 200 && imported.status !== 201)) {
        throw new Error(`import failed: ${JSON.stringify(imported)}`)
      }
      const documents = await evaluate(session, `(async () => { const r = await fetch('${BASE}/api/documents'); return r.json() })()`)
      const document = (Array.isArray(documents) ? documents : []).find((entry) => entry && entry.originalName === 'Harness 合成验证.pdf')
      if (!document) throw new Error('imported attachment is absent from /api/documents')
      await evaluate(
        session,
        `(async () => {
          const response = await fetch('${BASE}/api/index/queue', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids: [${JSON.stringify(document.id)}], mode: 'text' }),
          })
          return response.status
        })()`,
      )
      const deadline = Date.now() + 150000
      while (Date.now() < deadline) {
        const status = await evaluate(session, `(async () => { const r = await fetch('${BASE}/api/index/status'); return r.json() })()`)
        const entry = (status && status.documents ? status.documents : []).find((candidate) => candidate.id === document.id)
        if (entry && entry.indexedAt) return { id: document.id, sourceHash: document.sourceHash }
        await new Promise((resolve) => setTimeout(resolve, 700))
      }
      throw new Error('indexing did not finish in time')
    })

    const health = await evaluate(session, `(async () => { const r = await fetch('${BASE}/api/health'); return { status: r.status, body: await r.json() } })()`)
    if (health.status !== 200 || !health.body || !health.body.integration || health.body.integration.version !== 1) {
      throw new Error(`proxied health is not bridge v1: ${JSON.stringify(health)}`)
    }
    pass('same-origin proxy forwards authenticated health with bridge v1')

    const now = Date.now()
    const cookieInfo = await session.send('Network.getAllCookies')
    const cookies = (cookieInfo.cookies || []).filter((cookie) => cookie.name.startsWith('dsh-auth-'))
    const statusUrl = `${url.split('/?')[0]}${BASE}/__workbench/status`
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    const anonymous = await fetch(statusUrl)
    if (anonymous.status !== 401 && anonymous.status !== 403) throw new Error(`anonymous status route returned ${anonymous.status}`)
    const trusted = await fetch(statusUrl, { headers: { cookie: cookieHeader } })
    const trustedBody = await trusted.json()
    if (!trusted.ok || !trustedBody.ready) throw new Error(`authenticated status route not ready: ${JSON.stringify(trustedBody)}`)
    report.backendRoot = trustedBody.backendRoot
    report.node = trustedBody.node
    report.dataRoot = trustedBody.dataRoot
    const normalize = (value) => path.resolve(String(value || '')).toLowerCase()
    if (args['expect-backend-root'] && normalize(trustedBody.backendRoot) !== normalize(args['expect-backend-root'])) {
      throw new Error(`running backend is not the packaged copy: ${trustedBody.backendRoot} !== ${args['expect-backend-root']}`)
    }
    if (args['expect-runtime'] && normalize(trustedBody.node && trustedBody.node.executable) !== normalize(args['expect-runtime'])) {
      throw new Error(`running runtime is not the packaged copy: ${trustedBody.node && trustedBody.node.executable} !== ${args['expect-runtime']}`)
    }
    if (args['expect-data-root'] && normalize(trustedBody.dataRoot) !== normalize(args['expect-data-root'])) {
      throw new Error(`running data root is not the isolated directory: ${trustedBody.dataRoot}`)
    }
    const crossOrigin = await fetch(`${url.split('/?')[0]}${BASE}/api/library/search`, {
      method: 'POST',
      headers: { cookie: cookieHeader, origin: 'http://untrusted.invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ query: { text: '' }, page: { limit: 1, offset: 0 } }),
    })
    if (crossOrigin.status !== 403) throw new Error(`cross-origin write was not rejected: ${crossOrigin.status}`)
    const sameOrigin = await fetch(`${url.split('/?')[0]}${BASE}/api/library/search`, {
      method: 'POST',
      headers: { cookie: cookieHeader, origin: url.split('/?')[0], 'content-type': 'application/json' },
      body: JSON.stringify({ query: { text: '' }, page: { limit: 1, offset: 0 } }),
    })
    if (!sameOrigin.ok) throw new Error(`same-origin write failed: ${sameOrigin.status}`)
    pass('host route requires the browser session, rejects cross-origin writes and keeps loopback writes working')
    report.timingImportMs = Date.now() - now

    const attachmentId = importedPaper.id
    const sourceHash = importedPaper.sourceHash
    report.paper = { attachmentId, sourceHash }

    /** The plugin stores paper->Session bindings in localStorage; read the binding. */
    async function readPaperSessionId() {
      const expression = `(() => {
        try {
          const map = JSON.parse(localStorage.getItem('dsh.paper-workbench.sessions.v1') || '{}')
          const entry = map[${JSON.stringify(attachmentId)}]
          return entry && typeof entry.sessionId === 'string' ? entry.sessionId : null
        } catch { return null }
      })()`
      return evaluate(session, expression)
    }

    async function readPaperContextSnapshot(sessionId) {
      if (!sessionId) return null
      const expression = `(async () => {
        const response = await fetch('${BASE}/__workbench/paper-context?sessionId=' + encodeURIComponent(${JSON.stringify(sessionId)}))
        return { status: response.status, body: await response.json() }
      })()`
      const result = await evaluate(session, expression)
      if (!result || result.status !== 200) throw new Error(`paper-context route returned ${result && result.status}`)
      return result.body && result.body.context ? result.body.context : null
    }

    async function waitPaperContext(sessionId, predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      let last = null
      while (Date.now() < deadline) {
        last = await readPaperContextSnapshot(sessionId)
        if (last && predicate(last)) return last
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      throw new Error(`paper context did not reach the expected state: ${JSON.stringify(last)}`)
    }

    /**
     * A fresh isolated profile has no recorded per-Session model selection. Pick
     * the provider's first offered model through the host's own model menu so the
     * native composer is unlocked. This drives the real selector UI; it does not
     * bypass the host's model authorization.
     */
    async function selectModelIfNeeded() {
      const needed = await evaluate(
        session,
        `[...document.querySelectorAll("button")].some((node) => (node.textContent || "").trim() === "请选择模型")`,
      )
      if (!needed) return false
      await evaluate(
        session,
        `(() => { const node = [...document.querySelectorAll("button")].find((n) => (n.textContent || "").trim() === "请选择模型"); node.click(); return true })()`,
      )
      await waitFor(
        session,
        `[...document.querySelectorAll("[role=menuitem], [role=option], button")].some((node) => node.offsetParent !== null && /DeepSeek-V4|deepseek-flash/i.test(node.textContent || ""))`,
        { timeoutMs: 15000 },
      )
      await evaluate(
        session,
        `(() => {
          const node = [...document.querySelectorAll("[role=menuitem], [role=option], button")].find((n) => n.offsetParent !== null && /DeepSeek-V4|deepseek-flash/i.test(n.textContent || ""))
          node.click()
          return true
        })()`,
      )
      await waitFor(
        session,
        `![...document.querySelectorAll("button")].some((node) => (node.textContent || "").trim() === "请选择模型")`,
        { timeoutMs: 20000 },
      )
      return true
    }

    /** Stop the current turn through the composer's own Stop control. */
    async function stopRunningTurn() {
      const stopped = await evaluate(
        session,
        `(() => {
          const node = [...document.querySelectorAll("button")].find((n) =>
            /停止|Stop/u.test([n.getAttribute("aria-label"), n.textContent].filter(Boolean).join(" ")))
          if (!node || node.disabled) return false
          node.click()
          return true
        })()`,
      ).catch(() => false)
      if (stopped) await waitFor(session, `!!document.querySelector('.pw-conversation-host button[aria-label="发送消息"]')`, {timeoutMs:15000})
      return stopped
    }

    /** Submit one phrase through the native composer and observe the Host context injection. */
    async function nativeComposerSend(phrase) {
      const sessionId = await readPaperSessionId()
      if (!sessionId) throw new Error('paper Session binding is missing')
      const before = await readPaperContextSnapshot(sessionId)
      if (!before) throw new Error('paper context was not published before the native composer was used')
      const editorPoint = await evaluate(
        session,
        `(() => {
          const editor = document.querySelector(".pw-conversation-host [contenteditable=true]")
          const rect = editor.getBoundingClientRect()
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        })()`,
      )
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: editorPoint.x, y: editorPoint.y })
      await session.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: editorPoint.x,
        y: editorPoint.y,
        button: 'left',
        clickCount: 1,
      })
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: editorPoint.x,
        y: editorPoint.y,
        button: 'left',
        clickCount: 1,
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      const focused = await evaluate(
        session,
        `(() => {
          const editor = document.querySelector(".pw-conversation-host [contenteditable=true]")
          editor.focus()
          return document.activeElement === editor
        })()`,
      )
      if (!focused) throw new Error('the native composer editor did not take focus')
      const sendStartedAt = Date.now()
      await session.send('Input.insertText', { text: phrase })
      await new Promise((resolve) => setTimeout(resolve, 200))
      await waitFor(session, `(() => {const b=document.querySelector('.pw-conversation-host button[aria-label="发送消息"]');return b && !b.disabled && b.getAttribute('aria-busy')!=='true'})()`, {timeoutMs:15000})
      await evaluate(session, `document.querySelector('.pw-conversation-host button[aria-label="发送消息"]').click()`)
      await waitFor(session, `!(document.querySelector('.pw-conversation-host [contenteditable=true]')?.textContent||'').trim()`, {timeoutMs:15000})
      await waitFor(
        session,
        `(document.querySelector(".pw-panel")?.textContent || "").includes(${JSON.stringify(phrase)})`,
        { timeoutMs: 30000 },
      )
      const after = await waitPaperContext(sessionId, (value) => value.injections > before.injections, 60000)
      await stopRunningTurn()
      return { sessionId, before, after, sendStartedAt }
    }

    await step('Native panel opens with the embedded library UI', async () => {
      await evaluate(
        session,
        `(() => {
          const label = (node) => [node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent].filter(Boolean).join(' ')
          const button = [...document.querySelectorAll('button, a')].find((node) => /文献工作台|Paper Workbench/u.test(label(node)))
          button.click()
          return true
        })()`,
      )
      await waitFor(session, `!!document.querySelector('.pw-root')`, { timeoutMs: 20000 })
      await waitFor(
        session,
        `(() => {
          const frame = document.querySelector('.pw-frame')
          if (!frame || !frame.contentDocument) return false
          const total = frame.contentDocument.querySelector('#result-total')
          return Boolean(total && total.textContent === '1')
        })()`,
        { timeoutMs: 30000 },
      )
      const theme = await evaluate(
        session,
        `(() => {
          const frame = document.querySelector('.pw-frame')
          return frame.contentDocument.documentElement.dataset.theme || null
        })()`,
      )
      if (theme !== 'light' && theme !== 'dark') throw new Error(`iframe theme not initialized: ${JSON.stringify(theme)}`)
      report.screenshots.push(await screenshot(session, path.join(outDir, '01-library.png')))
    })

    await step('A single paper can be moved to the recycle bin and restored from its details', async () => {
      const library = "document.querySelector('.pw-frame').contentDocument"
      const selector = (name) => `${library}.querySelector(${JSON.stringify(name)})`
      const click = (name) => evaluate(session, `(() => {
        const control = ${selector(name)}
        if (!control?.getClientRects().length) throw new Error('Library control is missing or hidden')
        control.click()
      })()`)
      const waitText = (name, text) => waitFor(
        session,
        `${selector(name)}?.textContent.trim() === ${JSON.stringify(text)}`,
        { timeoutMs: 10000 },
      )
      const archive = '#details [data-action="change-archive"]'
      const confirm = 'dialog[open] [type="submit"]'
      await click('#table-body .paper-title')
      await waitText(archive, '移入回收站')
      await click(archive)
      await click('dialog[open] [data-close]')
      await waitText('#count-trash', '0')
      await click(archive)
      await click(confirm)
      await waitText('#count-trash', '1')
      await waitText('#result-total', '0')

      await click('[data-view="trash"]')
      await waitText('#view-title', '回收站')
      await click('#table-body .paper-title')
      await waitText(archive, '恢复到文献库')
      await click(archive)
      await click(confirm)
      await waitText('#empty-state h2', '回收站为空')
      await click('[data-view="all"]')
      await waitText('#result-total', '1')
      const restoredId = await evaluate(session, `new URL(${selector('.read-link')}.href).searchParams.get('id')`)
      if (restoredId !== attachmentId) throw new Error('The restored paper lost its original attachment')
    })

    await step('Library navigation switches the same panel to the native-bound reader', async () => {
      await evaluate(
        session,
        `(() => {
          const frame = document.querySelector('.pw-frame')
          const link = frame.contentDocument.querySelector('.read-link') || frame.contentDocument.querySelector('.attachment')
          link.click()
          return true
        })()`,
      )
      await waitFor(session, `String(document.querySelector('.pw-frame')?.contentWindow?.location?.pathname || '').includes('reader.html')`, {
        timeoutMs: 30000,
      })
      await waitFor(
        session,
        `(() => {
          const frame = document.querySelector('.pw-frame')
          const win = frame.contentWindow
          const tools = frame.contentDocument.querySelector('#reader-tools-toggle')
          const panel = frame.contentDocument.querySelector('#reader-tools')
          return Boolean(tools && panel && !panel.matches(':popover-open') && win.workbench && win.workbench.adapter && win.workbench.adapter.pdfApplication)
        })()`,
        { timeoutMs: 120000 },
      )
      await waitFor(
        session,
        `(() => { const win = document.querySelector('.pw-frame').contentWindow; return win.workbench.adapter.getSaveState() === 'saved' })()`,
        { timeoutMs: 60000 },
      )
      report.screenshots.push(await screenshot(session, path.join(outDir, '02-reader.png')))
    })

    await step('"Ask about this paper" opens the native AI panel with context but submits nothing', async () => {
      await evaluate(
        session,
        `(() => { const doc = document.querySelector('.pw-frame').contentDocument; doc.querySelector('#reader-tools-toggle').click(); if (!doc.querySelector('#reader-tools').matches(':popover-open')) throw Error('Reader tools did not open'); doc.querySelector('[data-ai-action="ask"]').click(); return true })()`,
      )
      await waitFor(session, `(() => { const panel = document.querySelector('.pw-panel'); return Boolean(panel && panel.getAttribute('data-collapsed') === 'false') })()`, {
        timeoutMs: 15000,
      })
      await waitFor(session, `!!document.querySelector('.pw-ask-row .pw-input')`, { timeoutMs: 15000 })
      await waitFor(
        session,
        `(() => {
          try {
            const map = JSON.parse(localStorage.getItem('dsh.paper-workbench.sessions.v1') || '{}')
            return Object.keys(map).length > 0
          } catch { return false }
        })()`,
        { timeoutMs: 40000 },
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      const focused = await waitFor(
        session,
        `document.activeElement === document.querySelector('.pw-ask-row .pw-input')`,
        { timeoutMs: 10000, intervalMs: 250 },
      ).then(() => true).catch(() => false)
      const autoSubmitted = await evaluate(
        session,
        `(() => {
          const host = document.querySelector('.pw-conversation-host')
          return Boolean(host && /任务：|用户问题/u.test(host.textContent || ''))
        })()`,
      )
      if (!focused) {
        // Headless synthetic clicks leave DOM focus on the iframe element; the
        // plugin keeps claiming the paper question field after the native composer
        // mounts. Record the environment limit instead of claiming the transfer.
        report.notes.push(
          'ask panel opened with context and no auto-submitted prompt; focus transfer to the paper question field was not observable under headless synthetic clicks',
        )
      }
      report.focusObserved = focused
      if (autoSubmitted) throw new Error('an ask action submitted a prompt without a user question')
      const chips = await evaluate(session, `[...document.querySelectorAll('.pw-chip')].map((node) => node.textContent).join(' | ')`)
      if (!/第 \d+ 页|Page \d+/u.test(chips)) throw new Error(`paper context chips are missing: ${chips}`)
      const askSessionId = await waitFor(
        session,
        `(() => {
          try {
            const map = JSON.parse(localStorage.getItem('dsh.paper-workbench.sessions.v1') || '{}')
            const entry = map[${JSON.stringify(attachmentId)}]
            return Boolean(entry && typeof entry.sessionId === 'string')
          } catch { return false }
        })()`,
        { timeoutMs: 40000 },
      ).then(() => readPaperSessionId())
      const askSnapshot = await waitPaperContext(askSessionId, (value) => value.attachmentId === attachmentId, 20000)
      if (askSnapshot.injections !== 0) throw new Error(`opening the ask panel already started a model step: ${askSnapshot.injections}`)
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const afterAsk = await readPaperContextSnapshot(askSessionId)
      if (!afterAsk || afterAsk.injections !== 0) {
        throw new Error(`ask panel opening triggered a model step without a submitted question: ${JSON.stringify(afterAsk)}`)
      }
      if (afterAsk.attachmentId !== attachmentId || afterAsk.sourceHash !== sourceHash) {
        throw new Error(`published paper context does not carry the stable source: ${JSON.stringify(afterAsk)}`)
      }
      report.askOpen = { sessionId: askSessionId, injections: afterAsk.injections, contextPublished: true }
      report.screenshots.push(await screenshot(session, path.join(outDir, '03-ask-panel.png')))
    })

    await step('Native chat composer request carries the same paper context; ask itself starts no model step', async () => {
      await waitFor(
        session,
        `!!document.querySelector('.pw-conversation-host [contenteditable="true"]')`,
        { timeoutMs: 40000 },
      )
      // Unlock the native composer through the host's own model selector.
      const modelSelected = await selectModelIfNeeded()
      const { sessionId, before, after, sendStartedAt } = await nativeComposerSend('请用一句话概括这篇合成验证论文的主题。')
      if (after.attachmentId !== attachmentId || after.sourceHash !== sourceHash) {
        throw new Error(`native composer context has the wrong source: ${JSON.stringify(after)}`)
      }
      if (!Number.isInteger(after.pageIndex) || after.pageIndex < 0) {
        throw new Error(`native composer context has no valid page index: ${JSON.stringify(after)}`)
      }
      if (!after.lastInjectedAt || after.lastInjectedAt < sendStartedAt - 1000) {
        throw new Error(`native composer context injection was not observed after send: ${JSON.stringify(after)}`)
      }
      report.nativeComposer = {
        sessionId,
        before: before.injections,
        after: after.injections,
        pageIndex: after.pageIndex,
        hasSelection: after.hasSelection,
        lastInjectedAt: after.lastInjectedAt,
        modelSelected,
      }
      report.screenshots.push(await screenshot(session, path.join(outDir, '04-native-composer.png')))
    })

    await step('Turning the PDF page and asking directly through the native composer publishes the new page', async () => {
      const pageTurned = await evaluate(
        session,
        `(async () => {
          const reader = document.querySelector(".pw-frame").contentWindow
          const adapter = reader.workbench && reader.workbench.adapter
          if (!adapter || typeof adapter.goToPage !== "function") return false
          await adapter.goToPage(1)
          return true
        })()`,
      )
      if (!pageTurned) throw new Error('the reader adapter could not turn the page')
      const sessionId = await readPaperSessionId()
      const updated = await waitPaperContext(sessionId, (value) => value.pageIndex === 1, 20000)
      if (updated.pageIndex !== 1) throw new Error(`page turn was not published: ${JSON.stringify(updated)}`)
      const { after } = await nativeComposerSend('这一页的结论是什么？请只依据当前页回答。')
      if (after.pageIndex !== 1) {
        throw new Error(`native composer after a page turn used a stale page: ${JSON.stringify(after)}`)
      }
      report.nativeComposerAfterPageTurn = {
        pageIndex: after.pageIndex,
        before: updated.pageIndex,
        afterInjection: after.injections,
      }
      report.screenshots.push(await screenshot(session, path.join(outDir, '05-native-composer-page2.png')))
    })

    await step('Translate submits an explicit prompt into the paper-bound native conversation', async () => {
      const sessionId = await readPaperSessionId()
      const before = sessionId ? await readPaperContextSnapshot(sessionId) : null
      await evaluate(
        session,
        `(() => { const doc = document.querySelector('.pw-frame').contentDocument; doc.querySelector('#reader-tools-toggle').click(); if (!doc.querySelector('#reader-tools').matches(':popover-open')) throw Error('Reader tools did not open'); doc.querySelector('[data-ai-action="translate"]').click(); return true })()`,
      )
      await waitFor(
        session,
        `(() => {
          const host = document.querySelector('.pw-conversation-host')
          const text = host ? host.textContent || '' : ''
          return Boolean(host && (text.includes('本轮任务在 Harness「文献工作台」中进行') || text.includes('你在 Harness 的「文献工作台」中协助阅读本地文献')))
        })()`,
        { timeoutMs: 45000 },
      )
      if (sessionId) {
        const base = before ? before.injections : 0
        const after = await waitPaperContext(sessionId, (value) => value.injections > base, 60000)
        if (after.attachmentId !== attachmentId || after.sourceHash !== sourceHash) {
          throw new Error(`custom action context has the wrong source: ${JSON.stringify(after)}`)
        }
        report.translate = { before: base, after: after.injections, pageIndex: after.pageIndex }
      }
      const title = await evaluate(session, `(document.querySelector('.pw-paper-title')?.textContent || '').trim()`)
      report.paperTitle = title
      await stopRunningTurn()
      report.screenshots.push(await screenshot(session, path.join(outDir, '05-translate.png')))
    })

    await step('Switching main panels and returning restores the reading view', async () => {
      // The visible return control flushes the reader before restoring DSH.
      await evaluate(
        session,
        `(() => {
          const button = document.querySelector('.pw-return')
          if (!button) return false
          button.click()
          return true
        })()`,
      )
      await waitFor(session, `!document.querySelector('.pw-root')`, { timeoutMs: 20000 })
      await evaluate(
        session,
        `(() => {
          const label = (node) => [node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent].filter(Boolean).join(' ')
          const button = [...document.querySelectorAll('button, a')].find((node) => /文献工作台|Paper Workbench/u.test(label(node)))
          button.click()
          return true
        })()`,
      )
      await waitFor(session, `!!document.querySelector('.pw-root')`, { timeoutMs: 20000 })
      await waitFor(session, `String(document.querySelector('.pw-frame')?.contentWindow?.location?.pathname || '').includes('reader.html')`, {
        timeoutMs: 40000,
      })
      await waitFor(
        session,
        `(() => {
          const frame = document.querySelector('.pw-frame')
          const win = frame && frame.contentWindow
          return Boolean(win && win.workbench && win.workbench.adapter && win.workbench.adapter.pdfApplication)
        })()`,
        { timeoutMs: 120000 },
      )
      const notice = await evaluate(
        session,
        `(() => { const node = document.querySelector('.pw-notice'); return node ? node.textContent : '' })()`,
      )
      if (/未确认|unconfirmed/u.test(notice)) throw new Error(`restored clean page reported an unconfirmed save: ${notice}`)
      report.screenshots.push(await screenshot(session, path.join(outDir, '06-restored-reader.png')))
    })

    if (args['ocr-fixture']) {
      await step('Packaged OCR model and worker pipeline index a scanned fixture', async () => {
        const ocrFixture = path.resolve(args['ocr-fixture'])
        if (!existsSync(ocrFixture)) throw new Error(`OCR fixture missing: ${ocrFixture}`)
        const base64 = readFileSync(ocrFixture).toString('base64')
        const imported = await evaluate(
          session,
          `(async () => {
            const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0))
            const response = await fetch('${BASE}/api/library/import-pdf', {
              method: 'POST',
              headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Harness OCR 合成验证.pdf') },
              body: bytes,
            })
            return { status: response.status, body: await response.json() }
          })()`,
        )
        if (!imported || (imported.status !== 200 && imported.status !== 201)) {
          throw new Error(`scanned import failed: ${JSON.stringify(imported)}`)
        }
        const documents = await evaluate(session, `(async () => { const r = await fetch('${BASE}/api/documents'); return r.json() })()`)
        const document = (Array.isArray(documents) ? documents : []).find((entry) => entry && entry.originalName === 'Harness OCR 合成验证.pdf')
        if (!document) throw new Error('scanned attachment is absent from /api/documents')
        // Import triggers the automatic text pass; wait for it before asking for OCR
        // so the explicit job is not folded into the automatic one.
        const settleDeadline = Date.now() + 120000
        while (Date.now() < settleDeadline) {
          const status = await evaluate(session, `(async () => { const r = await fetch('${BASE}/api/index/status'); return r.json() })()`)
          const entry = (status && status.documents ? status.documents : []).find((candidate) => candidate.id === document.id)
          const jobs = ((status && status.jobs) || []).filter((job) => job.attachment_id === document.id && ['queued', 'running'].includes(job.status))
          if (entry && entry.indexedAt && jobs.length === 0) break
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        await evaluate(
          session,
          `(async () => {
            const response = await fetch('${BASE}/api/index/queue', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ids: [${JSON.stringify(document.id)}], mode: 'ocr' }),
            })
            return response.status
          })()`,
        )
        const deadline = Date.now() + 300000
        while (Date.now() < deadline) {
          const status = await evaluate(session, `(async () => { const r = await fetch('${BASE}/api/index/status'); return r.json() })()`)
          const entry = (status && status.documents ? status.documents : []).find((candidate) => candidate.id === document.id)
          if (entry && entry.ocrPages > 0) {
            report.ocr = { attachmentId: document.id, nativePages: entry.nativePages, ocrPages: entry.ocrPages }
            return
          }
          const failed = ((status && status.jobs) || []).find((job) => job.attachment_id === document.id && job.status === 'failed')
          if (failed) throw new Error(`OCR indexing failed: ${failed.error || 'unknown'}`)
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
        const finalStatus = await evaluate(session, `(async () => { const r = await fetch('${BASE}/api/index/status'); return r.json() })()`)
        const diagnostics = {
          document: (finalStatus.documents || []).find((candidate) => candidate.id === document.id),
          jobs: (finalStatus.jobs || []).filter((job) => job.attachment_id === document.id),
        }
        throw new Error(`OCR indexing did not produce OCR pages in time: ${JSON.stringify(diagnostics)}`)
      })
    }

    report.passed = report.failures.length === 0
  } finally {
    report.consoleErrors = consoleErrors
    report.failedRequests = failedRequests
    report.finishedAt = new Date().toISOString()
    writeFileSync(path.join(outDir, 'isolated-report.json'), JSON.stringify(report, null, 2))
    await browser.close()
  }

  if (!report.passed) {
    console.error(`FAILED: ${report.failures.length} check(s) failed. Report: ${path.join(outDir, 'isolated-report.json')}`)
    process.exitCode = 1
  } else {
    console.log(`PASS all ${report.checks.length} checks. Report: ${path.join(outDir, 'isolated-report.json')}`)
  }
}

main().catch((error) => {
  report.failures.push({ check: 'verify', error: error instanceof Error ? error.stack || error.message : String(error) })
  report.finishedAt = new Date().toISOString()
  writeFileSync(path.join(outDir, 'isolated-report.json'), JSON.stringify(report, null, 2))
  console.error(error)
  process.exitCode = 1
})
