/**
 * `withRenderFallback` — the shell test, the comparison, and the two ways it
 * can refuse to use what the renderer produced.
 *
 * These use fake providers so they run offline and deterministically. The one
 * assertion that matters most is "rendering loses, keep the static body":
 * measured on music.163.com and MDN, rendering genuinely produces less, so a
 * chain that swapped unconditionally would be a silent regression.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  contentSignals,
  withRenderFallback,
  WebError,
  DEFAULT_ROW_WEIGHT,
} from '../dist/index.js'

/** A provider that returns a fixed body, or throws. */
function fakeProvider(id, body, options = {}) {
  return {
    id,
    calls: 0,
    available: () => options.available ?? true,
    async fetch(request) {
      this.calls++
      if (options.throws !== undefined) throw options.throws
      return {
        url: request.url,
        statusCode: options.statusCode ?? 200,
        body: { kind: 'html', content: body },
        truncated: false,
      }
    },
  }
}

/** A body whose extracted main text is roughly `n` characters. */
function bodyWithText(n, tables = 0, rows = 0) {
  const p = `<p>${'x'.repeat(Math.max(n, 0))}</p>`
  const table = tables > 0
    ? `<table>${'<tr><td>1</td></tr>'.repeat(rows)}</table>`
    : ''
  return `<html><body>${p}${table}</body></html>`
}

test('contentSignals counts text, tables, rows and images without a DOM', () => {
  const html = '<html><head><script>var a=1;</script><style>p{}</style></head>'
    + '<body><table><tr><td>a</td></tr><tr><td>b</td></tr></table><img src="x"></body></html>'
  const signals = contentSignals(html)
  // "a b" is the visible text; the script and style bodies are not. Tags
  // collapse to a single space each, so the two cells measure three characters.
  assert.equal(signals.textChars, 3)
  assert.equal(signals.tableCount, 1)
  assert.equal(signals.rowCount, 2)
  assert.equal(signals.imageCount, 1)
})

test('a body with plenty of main text never launches the renderer', async () => {
  const primary = fakeProvider('http', bodyWithText(5000))
  const renderer = fakeProvider('browser', bodyWithText(9000))
  const decisions = []
  const chain = withRenderFallback(primary, renderer, { onDecision: d => decisions.push(d) })

  const result = await chain.fetch({ url: 'https://example.com/' })

  assert.equal(renderer.calls, 0, 'renderer must not run for a healthy body')
  assert.equal(result.body.content, bodyWithText(5000))
  assert.equal(result.rendered, undefined)
  assert.equal(decisions[0]?.reason, 'not-needed')
})

test('a short body renders, and the richer rendered body replaces it', async () => {
  const primary = fakeProvider('http', bodyWithText(50))
  const renderer = fakeProvider('browser', bodyWithText(9000, 2, 20))
  const decisions = []
  const chain = withRenderFallback(primary, renderer, { onDecision: d => decisions.push(d) })

  const result = await chain.fetch({ url: 'https://example.com/' })

  assert.equal(renderer.calls, 1)
  assert.equal(result.rendered, true, 'the rendered body must be flagged as rendered')
  assert.equal(result.body.content, bodyWithText(9000, 2, 20))
  assert.equal(decisions[0]?.reason, 'shell')
  assert.equal(decisions[0]?.usedRendered, true)
})

test('a table skeleton with no filled rows counts as a shell', async () => {
  // 5000 chars of chrome around an empty grid: long enough to pass any
  // text-only test, and still a page whose data has not loaded.
  const primary = fakeProvider('http', bodyWithText(5000, 1, 1))
  const renderer = fakeProvider('browser', bodyWithText(5000, 1, 40))
  const chain = withRenderFallback(primary, renderer)

  const result = await chain.fetch({ url: 'https://example.com/' })

  assert.equal(renderer.calls, 1, 'an unfilled table must trigger a render')
  assert.equal(result.rendered, true)
})

test('rendering keeps a table-rich body even when its text is shorter', async () => {
  // 40 data rows are worth more than the 600 characters they cost.
  const primary = fakeProvider('http', bodyWithText(1200))
  const renderer = fakeProvider('browser', bodyWithText(600, 1, 40))
  const chain = withRenderFallback(primary, renderer)

  const result = await chain.fetch({ url: 'https://example.com/' })

  assert.equal(result.rendered, true)
  assert.ok(600 + 40 * DEFAULT_ROW_WEIGHT > 1200, 'rows must be weighted to win')
})

test('when rendering loses, the static body is kept', async () => {
  // music.163.com, in miniature: the static body is a shell, so the renderer
  // runs — and what it produces is worse than what HTTP already had.
  const shell = bodyWithText(100)
  const primary = fakeProvider('http', shell)
  const renderer = fakeProvider('browser', bodyWithText(50))
  const decisions = []
  const chain = withRenderFallback(primary, renderer, { onDecision: d => decisions.push(d) })

  const result = await chain.fetch({ url: 'https://example.com/' })

  assert.equal(renderer.calls, 1, 'the static body is a shell, so the renderer runs')
  assert.equal(result.rendered, undefined, 'a losing render must not replace the static body')
  assert.equal(result.body.content, shell)
  assert.equal(decisions[0]?.reason, 'render-lost')
  assert.equal(decisions[0]?.usedRendered, false)
})

test('a renderer that throws leaves the static body alone', async () => {
  const primary = fakeProvider('http', bodyWithText(50))
  const renderer = fakeProvider('browser', bodyWithText(9000), { throws: new Error('no browser') })
  const decisions = []
  const chain = withRenderFallback(primary, renderer, { onDecision: d => decisions.push(d) })

  const result = await chain.fetch({ url: 'https://example.com/' })

  assert.equal(result.body.content, bodyWithText(50))
  assert.equal(result.rendered, undefined)
  assert.equal(decisions[0]?.reason, 'render-failed')
})

test('a failed primary fetch falls through to the renderer', async () => {
  const primary = fakeProvider('http', '', { throws: new Error('connection refused') })
  const renderer = fakeProvider('browser', bodyWithText(3000))
  const decisions = []
  const chain = withRenderFallback(primary, renderer, { onDecision: d => decisions.push(d) })

  const result = await chain.fetch({ url: 'https://example.com/' })

  assert.equal(result.rendered, true)
  assert.equal(decisions[0]?.reason, 'primary-error')
})

test('a policy refusal is never retried through the renderer', async () => {
  // www.rust-lang.org redirects cross-origin; the HTTP provider refuses on
  // purpose and a browser follows redirects by definition. Falling back here
  // would reverse a security decision and return the refused page.
  for (const code of ['WEB_BLOCKED_URL', 'WEB_REDIRECT_BLOCKED', 'WEB_INVALID_URL']) {
    const refusal = new WebError('refused', code)
    const primary = fakeProvider('http', '', { throws: refusal })
    const renderer = fakeProvider('browser', bodyWithText(9000))
    const chain = withRenderFallback(primary, renderer)

    await assert.rejects(() => chain.fetch({ url: 'https://example.com/' }), /refused/)
    assert.equal(renderer.calls, 0, `${code} must not be worked around by a browser`)
  }
})

test('a capability failure is retried through the renderer', async () => {
  // Contrast with the policy case: a timeout or a refused content type is
  // something a browser can genuinely do better at.
  const primary = fakeProvider('http', '', { throws: Object.assign(new Error('timeout'), { code: 'WEB_FETCH_TIMEOUT' }) })
  const renderer = fakeProvider('browser', bodyWithText(9000))
  const chain = withRenderFallback(primary, renderer)

  const result = await chain.fetch({ url: 'https://example.com/' })

  assert.equal(renderer.calls, 1)
  assert.equal(result.rendered, true)
})

test('when both fail, the primary error is the one thrown', async () => {
  const primary = fakeProvider('http', '', { throws: new Error('primary down') })
  const renderer = fakeProvider('browser', '', { throws: new Error('browser down') })
  const chain = withRenderFallback(primary, renderer)

  await assert.rejects(
    () => chain.fetch({ url: 'https://example.com/' }),
    /primary down/,
    'the primary failure explains the page; the renderer is only a fallback',
  )
})

test('a challenge status retries through the renderer', async () => {
  const primary = fakeProvider('http', bodyWithText(5000), { statusCode: 403 })
  const renderer = fakeProvider('browser', bodyWithText(6000))
  const decisions = []
  const chain = withRenderFallback(primary, renderer, { onDecision: d => decisions.push(d) })

  const result = await chain.fetch({ url: 'https://example.com/' })

  assert.equal(renderer.calls, 1, '403 is often a JS challenge, not a real refusal')
  assert.equal(decisions[0]?.reason, 'status')
})

test('retryOnStatus can be switched off', async () => {
  const primary = fakeProvider('http', bodyWithText(5000), { statusCode: 403 })
  const renderer = fakeProvider('browser', bodyWithText(6000))
  const chain = withRenderFallback(primary, renderer, { retryOnStatus: [] })

  await chain.fetch({ url: 'https://example.com/' })

  assert.equal(renderer.calls, 0)
})

test('cancellation is never retried through the renderer', async () => {
  const controller = new AbortController()
  controller.abort()
  const primary = fakeProvider('http', bodyWithText(50), { throws: new Error('aborted') })
  const renderer = fakeProvider('browser', bodyWithText(9000))
  const chain = withRenderFallback(primary, renderer)

  await assert.rejects(() => chain.fetch({ url: 'https://example.com/' }, controller.signal))
  assert.equal(renderer.calls, 0, 'a cancelled fetch must not launch a browser')
})

test('a custom judge replaces the shell test', async () => {
  const primary = fakeProvider('http', bodyWithText(5000))
  const renderer = fakeProvider('browser', bodyWithText(9000))
  const chain = withRenderFallback(primary, renderer, {
    judge: result => result.body.content.includes('render-me'),
  })

  await chain.fetch({ url: 'https://example.com/' })
  assert.equal(renderer.calls, 0, 'the custom judge said no')

  const forcing = fakeProvider('http', bodyWithText(5000) + '<!-- render-me -->')
  const chain2 = withRenderFallback(forcing, fakeProvider('browser', bodyWithText(9000)), {
    judge: result => result.body.content.includes('render-me'),
  })
  const result = await chain2.fetch({ url: 'https://example.com/' })
  assert.equal(result.rendered, true)
})

test('the chain exposes its providers and disposes both', async () => {
  let disposed = 0
  const primary = fakeProvider('http', bodyWithText(5000))
  const renderer = fakeProvider('browser', bodyWithText(5000))
  primary.dispose = async () => { disposed++ }
  renderer.dispose = async () => { disposed++ }
  const chain = withRenderFallback(primary, renderer)

  assert.deepEqual(chain.providers.map(p => p.id), ['http', 'browser'])
  await chain.dispose()
  assert.equal(disposed, 2, 'both providers own resources that must be released')
})

test('a non-HTML body is never rendered', async () => {
  const primary = {
    id: 'http',
    available: () => true,
    async fetch(request) {
      return {
        url: request.url,
        statusCode: 200,
        body: { kind: 'text', content: '{"a":1}' },
        truncated: false,
      }
    },
  }
  const renderer = fakeProvider('browser', bodyWithText(9000))
  const chain = withRenderFallback(primary, renderer)

  await chain.fetch({ url: 'https://example.com/api' })

  assert.equal(renderer.calls, 0, 'JSON has nothing for a browser to add')
})
