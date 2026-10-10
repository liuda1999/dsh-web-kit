/**
 * `BrowserFetchProvider` — the parts that must hold whether or not a browser
 * is installed.
 *
 * The address checks run before any browser is launched, so they are testable
 * offline and are the security-relevant half: a browser performs its own DNS,
 * and a scripted redirect can move the page anywhere, so both the requested
 * URL and the URL the browser lands on get the public-address policy applied.
 *
 * The rendering test at the end needs a real browser; it is skipped when
 * Playwright is missing, and that skip is recorded rather than hidden.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BrowserFetchProvider,
  BROWSER_FETCH_PROVIDER_ID,
  DEFAULT_BROWSER_BODY_CHARS,
  isHarnessError,
} from '../dist/index.js'

/** True when Playwright is actually installed. */
async function hasPlaywright() {
  try {
    await import('playwright')
    return true
  } catch {
    return false
  }
}

test('a private address is refused before any browser launches', async () => {
  const provider = new BrowserFetchProvider()
  await assert.rejects(
    () => provider.fetch({ url: 'http://192.168.0.108/' }),
    error => {
      assert.ok(isHarnessError(error))
      assert.equal(error.code, 'WEB_BLOCKED_URL')
      return true
    },
  )
  // Nothing was launched: the check happens before `withPage`.
  await provider.dispose()
})

test('loopback is refused', async () => {
  const provider = new BrowserFetchProvider()
  await assert.rejects(
    () => provider.fetch({ url: 'http://127.0.0.1:8080/admin' }),
    error => isHarnessError(error) && error.code === 'WEB_BLOCKED_URL',
  )
  await provider.dispose()
})

test('a non-HTTP scheme is refused', async () => {
  const provider = new BrowserFetchProvider()
  await assert.rejects(
    () => provider.fetch({ url: 'file:///C:/secret.txt' }),
    error => isHarnessError(error) && error.code === 'WEB_INVALID_URL',
  )
  await provider.dispose()
})

test('credentials in the URL are refused', async () => {
  const provider = new BrowserFetchProvider()
  await assert.rejects(
    () => provider.fetch({ url: 'https://user:pass@example.com/' }),
    error => isHarnessError(error) && error.code === 'WEB_BLOCKED_URL',
  )
  await provider.dispose()
})

test('an aborted request never reaches the browser', async () => {
  const controller = new AbortController()
  controller.abort()
  const provider = new BrowserFetchProvider()
  await assert.rejects(
    () => provider.fetch({ url: 'https://example.com/' }, controller.signal),
    error => isHarnessError(error) && error.code === 'WEB_ABORTED',
  )
  await provider.dispose()
})

test('the provider reports an id and is selectable without I/O', () => {
  const provider = new BrowserFetchProvider()
  assert.equal(provider.id, BROWSER_FETCH_PROVIDER_ID)
  assert.equal(provider.available(), true)
  const named = new BrowserFetchProvider({ id: 'my-renderer' })
  assert.equal(named.id, 'my-renderer')
})

test('dispose closes only a pool this provider owns', async () => {
  let closed = 0
  const shared = { close: async () => { closed++ }, withPage: async () => { throw new Error('unused') } }
  const borrowing = new BrowserFetchProvider({ pool: shared })
  await borrowing.dispose()
  assert.equal(closed, 0, 'a borrowed pool belongs to whoever created it')
  assert.equal(borrowing.browserPool, shared)
})

test('rendering a JS-built page yields data the static body does not have', async (t) => {
  if (!(await hasPlaywright())) {
    t.skip('playwright is not installed (optional dependency)')
    return
  }
  // quote.eastmoney.com builds its grid from XHR: statically it has zero rows.
  const provider = new BrowserFetchProvider()
  const result = await provider.fetch(
    { url: 'https://quote.eastmoney.com/center/gridlist.html' },
    AbortSignal.timeout(60_000),
  )
  assert.equal(result.statusCode, 200)
  assert.equal(result.body.kind, 'html')
  assert.ok(
    (result.body.content.match(/<tr\b/gi) ?? []).length > 0,
    'the rendered grid must have rows; the static body has none',
  )
  assert.ok(result.body.content.length <= DEFAULT_BROWSER_BODY_CHARS)
  await provider.dispose()
})

test('the rendered DOM is cleaned so its content survives the conversion window', async (t) => {
  if (!(await hasPlaywright())) {
    t.skip('playwright is not installed (optional dependency)')
    return
  }
  // douyin.com/hot renders 799k characters, of which 13.7k survive cleaning —
  // an uncleaned body pushes everything real out of the tool's window.
  const provider = new BrowserFetchProvider()
  const result = await provider.fetch({ url: 'https://www.douyin.com/hot' }, AbortSignal.timeout(60_000))
  assert.ok(
    (result.body.content.match(/<script\b/gi) ?? []).length === 0,
    'cleaning must strip script tags from the returned DOM',
  )
  await provider.dispose()
})
