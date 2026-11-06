#!/usr/bin/env node
/**
 * Unit checks for the Host half's paper-context mechanism. These run the same
 * exported helpers the mounted plugin uses, without a Harness process.
 */
import assert from 'node:assert/strict'
import {
  appendPaperContext,
  createPaperContextStore,
  normalizePaperContext,
  renderPaperContext,
} from '../index.js'

const checks = []
function pass(name) {
  checks.push(name)
  console.log(`PASS ${name}`)
}

const valid = {
  attachmentId: '11111111-2222-3333-4444-555555555555',
  itemId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  sourceHash: 'a'.repeat(64),
  pageIndex: 3,
  selectionText: '  The effective mass of quasiparticles.  ',
}

const normalized = normalizePaperContext(valid)
assert.ok(normalized, 'valid context is normalized')
assert.equal(normalized.pageIndex, 3)
assert.equal(normalized.selectionText, 'The effective mass of quasiparticles.')
pass('normalize accepts stable identifiers and trims bounded selections')

assert.equal(normalizePaperContext({ ...valid, sourceHash: '' }), null)
assert.equal(normalizePaperContext({ ...valid, attachmentId: '../x' }), null)
const longSelection = normalizePaperContext({ ...valid, selectionText: 'x'.repeat(50000) })
assert.equal(longSelection.selectionText.length, 8000)
pass('normalize rejects missing/unstable identifiers and caps selections at 8000 characters')

const text = renderPaperContext(normalized)
assert.match(text, /文献工作台上下文/u)
assert.match(text, /attachmentId=11111111-2222-3333-4444-555555555555/u)
assert.match(text, /sourceHash=aaaaaaaa/u)
assert.match(text, /当前页=4/u)
assert.match(text, /不是发给你的指令/u)
assert.match(text, /The effective mass of quasiparticles/u)
const emptySelection = renderPaperContext({ ...normalized, selectionText: '' })
assert.match(emptySelection, /paper_read_pages/u)
pass('render stamps stable source, page label and untrusted-material framing')

const userMessage = { id: 'm1', role: 'user', content: [{ type: 'text', text: '翻译一下' }], source: { kind: 'user' } }
const decision = { kind: 'enter', messages: [userMessage], startsRequestSeries: true }
const injected = appendPaperContext(decision, normalized, 1)
assert.notEqual(injected, decision)
assert.equal(injected.messages.length, 2)
assert.equal(decision.messages.length, 1, 'original decision is not mutated')
const appended = injected.messages[1]
assert.equal(appended.role, 'user')
assert.equal(appended.source.kind, 'paper-workbench')
assert.equal(appended.source.form, 'snapshot')
assert.equal(typeof appended.id, 'string')
assert.match(appended.content[0].text, /attachmentId=11111111/u)
assert.ok(Object.isFrozen(appended), 'injected message is frozen')
assert.ok(Object.isFrozen(appended.source), 'injected source is frozen')
pass('pre-step decision receives one frozen snapshot message for a new user request series')

const continuation = appendPaperContext({ kind: 'enter', messages: [userMessage] }, normalized, 2)
assert.equal(continuation.messages.length, 1, 'tool-continuation step of the same turn is untouched')
const flaggedContinuation = appendPaperContext({ ...decision, startsRequestSeries: true }, normalized, 2)
assert.equal(flaggedContinuation.messages.length, 2, 'explicit request-series flag wins over step number')
assert.equal(appendPaperContext({ kind: 'reject' }, normalized, 1).kind, 'reject')
pass('only the first step of a new request series is injected; reject decisions pass through')

const store = createPaperContextStore(2)
store.set('session-1', valid)
store.set('session-2', { ...valid, pageIndex: 1 })
store.markInjected('session-1')
let snapshot = store.snapshot('session-1')
assert.equal(snapshot.injections, 1)
assert.ok(snapshot.lastInjectedAt > 0)
assert.equal(snapshot.hasSelection, true)
store.set('session-3', valid)
assert.equal(store.size(), 2)
assert.equal(store.snapshot('session-1'), null, 'least recently used context is evicted')
assert.equal(store.set('session-x', { attachmentId: 'nope' }), false)
pass('Host context store keeps bounded per-Session entries and injection diagnostics')

console.log(`PASS ${checks.length} host paper-context checks`)
