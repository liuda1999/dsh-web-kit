// Browser-backed search against live engines.
//
// These are the tests that matter for the browser backend, because the whole
// reason it exists is measured behaviour: over plain HTTP Baidu yields only
// redirect wrappers, and only a real browser resolves them. Everything here
// skips — loudly, with the reason printed — when Playwright or a browser is
// unavailable, so a machine without them is not a failure.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BrowserSearchProvider,
  browserEngine,
  BROWSER_ENGINES,
  isEngineLink,
} from '../dist/index.js'

/** Can Playwright actually launch a browser here? */
async function browserAvailable() {
  try {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] })
    await browser.close()
    return { ok: true }
  } catch (cause) {
    try {
      const { chromium } = await import('playwright')
      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
      await browser.close()
      return { ok: true }
    } catch (fallbackCause) {
      return { ok: false, reason: `${String(cause).split('\n')[0]} | ${String(fallbackCause).split('\n')[0]}` }
    }
  }
}

const availability = await browserAvailable()

/** Run a live query, or skip with the reason when no browser is available. */
function browserTest(name, fn) {
  test(name, { timeout: 120_000 }, async (t) => {
    if (!availability.ok) {
      t.skip(`no browser available: ${availability.reason}`)
      return
    }
    await fn(t)
  })
}

test('engines: built-in adapters are self-describing', () => {
  assert.deepEqual(Object.keys(BROWSER_ENGINES).sort(), ['baidu', 'bing'])
  assert.equal(browserEngine('bing').id, 'bing')
  assert.equal(browserEngine('baidu').buildUrl('a b'), 'https://www.baidu.com/s?wd=a%20b')
  assert.throws(() => browserEngine('nope'), /unknown browser engine/)
})

browserTest('browser:bing returns real, usable results', async () => {
  const provider = new BrowserSearchProvider({ engine: 'bing', timeoutMs: 90_000 })
  try {
    assert.equal(provider.id, 'browser:bing')
    assert.equal(provider.engineId, 'bing')

    const result = await provider.search({ query: 'deepseek 本地部署', maxResults: 5 })
    assert.ok(result.sources.length >= 5, `expected >=5 results, got ${result.sources.length}`)
    for (const source of result.sources) {
      assert.match(source.url, /^https?:\/\//)
      assert.ok((source.title ?? '').length > 0, 'every result needs a title')
      assert.equal(isEngineLink(source.url), false, `engine self-link leaked: ${source.url}`)
    }
    // Snippets are what make a result useful to a model without fetching it.
    assert.ok((result.sources[0]?.snippet ?? '').length > 20)
  } finally {
    await provider.dispose()
  }
})

browserTest('browser:baidu resolves real URLs that plain HTTP cannot', async () => {
  const provider = new BrowserSearchProvider({ engine: 'baidu', timeoutMs: 90_000 })
  try {
    assert.equal(provider.id, 'browser:baidu')
    const result = await provider.search({ query: 'deepseek 本地部署', maxResults: 5 })

    assert.ok(result.sources.length >= 3, `expected >=3 results, got ${result.sources.length}`)
    for (const source of result.sources) {
      // The entire point of the browser backend: these are real destinations,
      // not baidu.com/link?url=... interstitials.
      assert.equal(isEngineLink(source.url), false, `redirect wrapper leaked: ${source.url}`)
      assert.match(source.url, /^https?:\/\//)
    }
    // Baidu's own content host is legitimate; the parser must not throw it away.
    const hosts = new Set(result.sources.map(s => new URL(s.url).hostname))
    assert.ok(hosts.size >= 2, `expected several distinct hosts, got ${[...hosts].join(', ')}`)
  } finally {
    await provider.dispose()
  }
})

browserTest('browser: several queries in a row stay usable', async () => {
  const provider = new BrowserSearchProvider({ engine: 'bing', timeoutMs: 90_000 })
  try {
    for (const query of ['ollama 教程', '多智能体 架构设计', '上海 天气预报']) {
      const result = await provider.search({ query, maxResults: 5 })
      assert.ok(result.sources.length > 0, `"${query}" returned nothing`)
    }
  } finally {
    await provider.dispose()
  }
})

browserTest('browser: an empty query is rejected before launching', async () => {
  const provider = new BrowserSearchProvider({ engine: 'bing' })
  try {
    await assert.rejects(provider.search({ query: '   ' }), e => e.code === 'WEB_PROVIDER_ERROR')
  } finally {
    await provider.dispose()
  }
})

browserTest('browser: a shared pool is reused across providers', async () => {
  const { BrowserPool } = await import('../dist/index.js')
  const pool = new BrowserPool()
  try {
    const first = new BrowserSearchProvider({ engine: 'bing', pool, timeoutMs: 90_000 })
    const second = new BrowserSearchProvider({ engine: 'baidu', pool, timeoutMs: 90_000 })
    // Different engines must not collide in the registry.
    assert.notEqual(first.id, second.id)
    const result = await first.search({ query: 'ollama', maxResults: 3 })
    assert.ok(result.sources.length > 0)
  } finally {
    // The pool is externally owned, so provider disposal must not close it.
    await pool.close()
  }
})
