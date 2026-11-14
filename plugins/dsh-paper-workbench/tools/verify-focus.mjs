// Drives an isolated Harness instance. The caption marker exercises Windows
// layout in headless Edge; native dragging/window buttons are checked on Desktop.
import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PAPER_WORKBENCH_PLAYWRIGHT || 'playwright')
const instance = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const fixture = readFileSync(process.argv[3])
const output = path.resolve(process.argv[4] || 'output/focus-shell/verification')
mkdirSync(output, { recursive: true })
const report = { checks: [], errors: [], captionSimulation: true }
const pass = name => { report.checks.push(name); console.log('PASS', name) }
const browser = await chromium.launch({ headless:true, executablePath:process.env.PAPER_WORKBENCH_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' })
const page = await browser.newPage({ viewport:{width:1440,height:1000} })
page.on('pageerror', e => report.errors.push(e.message))
await page.addInitScript(() => {
  if (window.top !== window) return
  const mark = () => {
    document.documentElement.setAttribute('data-windows-titlebar', '')
    document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px')
  }
  if (document.documentElement) mark()
  else document.addEventListener('DOMContentLoaded', mark, {once:true})
})
const workbenchEntry = () => page.getByRole('button', { name:'文献工作台', exact:true })
const openWorkbench = async () => {
  await workbenchEntry().click()
  await page.locator('.pw-return').waitFor()
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('[data-pw-host-sidebar]')
    return sidebar && getComputedStyle(sidebar).display === 'none'
  })
}
try {
  await page.goto(instance.url)
  await workbenchEntry().waitFor({timeout:40000})
  const welcome = page.getByRole('button', {name:'继续',exact:true})
  if (await welcome.waitFor({timeout:5000}).then(()=>true).catch(()=>false)) await welcome.click()
  await page.getByRole('button', {name:/^新建?会话$/}).first().click()
  const mainEditor = page.locator('[contenteditable=true]').first()
  await mainEditor.waitFor({timeout:30000})
  const draft = 'Focus shell acceptance: preserve this original DSH conversation draft.'
  await mainEditor.fill(draft)
  const mainTitle = await page.title()
  await page.evaluate(() => {
    const menu = document.createElement('div')
    menu.dataset.windowsMenu = ''
    menu.textContent = 'QA caption menu'
    menu.style.cssText = 'position:fixed;top:0;left:80px;height:40px;z-index:1100'
    document.body.append(menu)
  })
  const sidebarWidth = async () => page.locator('[data-shell-overlay]').evaluate(
    el => parseFloat(getComputedStyle(el.parentElement).gridTemplateColumns.split(' ')[0]),
  )
  const initialSidebarWidth = await sidebarWidth()
  await openWorkbench()
  assert.equal(await page.locator('[data-windows-menu]').isVisible(), false)
  assert.equal(await page.locator('[data-sidebar-toggle]').first().isVisible(), false)
  assert.equal((await page.locator('.pw-header').boundingBox()).y, 0)
  assert.equal((await page.locator('.pw-body').boundingBox()).y, 40)
  assert.equal(await sidebarWidth(), 0)
  pass('Entry hides Host controls and merges navigation into the caption')

  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({colorScheme:scheme})
    for (const width of [1440, 1000, 760, 640, 520]) {
      await page.setViewportSize({width,height:900})
      const box = await page.locator('.pw-header').boundingBox()
      const last = await page.locator('.pw-header > button').last().boundingBox()
      assert.equal(box.y, 0)
      assert.equal(box.height, 40)
      assert.ok(last.x + last.width <= width - 138, `caption controls overlap at ${width}`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    }
    await page.setViewportSize({width:1280,height:900})
    await page.screenshot({path:path.join(output,`caption-${scheme}.png`)})
  }
  await page.setViewportSize({width:1440,height:1000})
  pass('Both themes fit 520–1440px widths without overlapping the native caption buttons')

  let frame = page.frames().find(f => /paper-workbench\/\?/.test(f.url()))
  await frame.locator('#new-item').click()
  await frame.locator('[data-field="title"]').fill('Unsaved focus verification')
  await page.locator('.pw-return').click()
  await page.locator('.pw-root > .pw-notice').waitFor()
  assert.equal(await frame.locator('[data-field="title"]').inputValue(), 'Unsaved focus verification')
  assert.equal(await page.locator('.pw-root').count(), 1)
  await frame.getByRole('button', {name:'保存信息',exact:true}).click()
  await frame.waitForFunction(() => !document.querySelector('.metadata-form'))
  await page.locator('.pw-return').click()
  await page.waitForFunction(() => !document.querySelector('.pw-root'))
  await mainEditor.waitFor()
  assert.equal(await mainEditor.textContent(), draft)
  assert.equal(await page.title(), mainTitle)
  assert.equal(await page.locator('[data-windows-menu]').isVisible(), true)
  assert.equal(await page.locator('[data-pw-focus], [data-pw-shell], [data-pw-host-sidebar]').count(), 0)
  await page.waitForFunction(width => {
    const frame = document.querySelector('[data-shell-overlay]')?.parentElement
    return frame && parseFloat(getComputedStyle(frame).gridTemplateColumns.split(' ')[0]) === width
  }, initialSidebarWidth)
  pass('Unsaved forms block return; a successful return restores the original conversation, draft and Host controls')

  await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const r = await fetch('/paper-workbench/api/library/import-pdf', {method:'POST',headers:{'content-type':'application/pdf','x-file-name':'focus-fixture.pdf'},body:bytes})
    if (!r.ok) throw Error('Fixture import failed: '+r.status)
    return r.json()
  }, fixture.toString('base64'))
  await openWorkbench()
  frame = page.frames().find(f => /paper-workbench\/\?/.test(f.url()))
  await frame.locator('.read-link').first().click()
  await page.waitForFunction(() => document.querySelector('.pw-frame')?.contentDocument?.querySelector('#reader-tools-toggle'))
  frame = page.frames().find(f => /reader.html\?/.test(f.url()))
  await frame.waitForFunction(() => window.workbench?.adapter?.pdfApplication && window.workbench.adapter.getSaveState() === 'saved')
  await page.getByRole('button', {name:'AI 辅助',exact:true}).click()
  await page.locator('.pw-conversation-host [contenteditable=true]').waitFor({timeout:60000})
  await frame.evaluate(() => window.workbench.adapter.goToPage(1))
  await frame.waitForFunction(() => window.workbench.adapter.currentPage() === 1)
  await page.locator('.pw-return').click()
  await page.waitForFunction(() => !document.querySelector('.pw-root'))
  assert.equal(await mainEditor.textContent(), draft)
  assert.equal(await page.title(), mainTitle)
  await openWorkbench()
  await page.waitForFunction(() => {
    const adapter = document.querySelector('.pw-frame')?.contentWindow?.workbench?.adapter
    return adapter?.pdfApplication && adapter.currentPage() === 1
  }, null, {timeout:60000})
  pass('Opening a paper Agent preserves the main conversation; leaving/re-entering restores the paper and exact page')
  await page.getByRole('button', {name:'收起 AI',exact:true}).click()
  frame = page.frames().find(f => /reader.html\?/.test(f.url()))
  const reader = frame.frameLocator('#reader-frame')
  await reader.getByRole('button', {name:'Draw',exact:true}).click()
  const pdfFrame = await reader.locator('iframe').boundingBox()
  const paperPage = await reader.frameLocator('iframe').locator('.page[data-page-number="2"]').boundingBox()
  const failSave = route => route.fulfill({status:503,json:{error:{code:'QA_SAVE_FAILED',message:'Synthetic save failure'}}})
  await page.route('**/api/annotations/**', failSave)
  await page.mouse.click(paperPage.x + 100, Math.max(paperPage.y + 140, pdfFrame.y + 110))
  await frame.waitForFunction(() => window.workbench.adapter.getSaveState() === 'failed')
  await page.locator('.pw-return').click()
  await page.locator('.pw-root > .pw-notice').waitFor()
  assert.equal(await page.locator('.pw-root').count(), 1)
  assert.equal(await frame.locator('#retry').isVisible(), true)
  assert.equal(await page.locator('[data-windows-menu]').isVisible(), false)
  await page.unroute('**/api/annotations/**', failSave)
  await frame.locator('#retry').click()
  await frame.waitForFunction(() => window.workbench.adapter.getSaveState() === 'saved')
  await page.locator('.pw-return').click()
  await page.waitForFunction(() => !document.querySelector('.pw-root'))
  assert.equal(await mainEditor.textContent(), draft)
  pass('Unacknowledged annotations block return with AI closed; retry saves before restoring the original DSH draft')
  assert.deepEqual(report.errors, [])
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.stack
  report.dom = await page.evaluate(() => ({focus:document.documentElement.hasAttribute('data-pw-focus'), notice:document.querySelector('.pw-notice')?.textContent, buttons:[...document.querySelectorAll('.pw-header button')].map(b=>({text:b.textContent,disabled:b.disabled}))})).catch(()=>null)
  await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{})
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
  writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))
}
