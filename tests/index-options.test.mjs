/**
 * What gets indexed, and especially what gets skipped.
 *
 * {@link CachingFetchProvider} refuses pages shorter than `minChars` and non-2xx
 * responses. Those thresholds decide whether a page can ever be found again, so
 * they are asserted in both directions: below the threshold nothing lands, above
 * it everything does, and `0` disables the filter entirely. For years these were
 * reachable only by constructing the provider directly — the kit builder did not
 * forward them — so this also pins the behaviour that forwarding now exposes.
 *
 * Runs offline against `dist/`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const DIST = new URL('../dist/', import.meta.url).href
const { CachingFetchProvider } = await import(DIST + 'local/caching-fetch.js')
const { DocStore } = await import(DIST + 'local/store.js')
const { LocalIndexSearchProvider } = await import(DIST + 'local/provider.js')

/** A fetch provider that always answers with a fixed result. */
function stub(result) {
  return {
    id: 'stub',
    available: () => true,
    fetch: async () => result,
  }
}

/** Wrap HTML into the shape a fetch result carries. */
function htmlResult(url, content, statusCode = 200) {
  return { url, statusCode, body: { kind: 'html', content }, truncated: false }
}

/** Build a fresh index in a throwaway directory. */
function scratchIndex() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-kit-opts-'))
  const store = new DocStore(dir)
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Body long enough to clear the default threshold comfortably. */
const LONG_PAGE = `<!DOCTYPE html><html><head><title>Long reference page</title></head><body>
  <main><h1>Long reference page</h1><p>A ${'paragraph about anchovy fisheries and their regulation '.repeat(12)}</p></main>
</body></html>`

/** Genuinely answer-sized content that the default threshold would discard. */
const SHORT_PAGE = `<!DOCTYPE html><html><head><title>Example Domain</title></head><body>
  <main><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents.</p></main>
</body></html>`

test('default threshold drops pages whose extracted body is under 200 chars', async () => {
  const { store, cleanup } = scratchIndex()
  try {
    await new CachingFetchProvider(stub(htmlResult('https://a.example/short', SHORT_PAGE)), store)
      .fetch({ url: 'https://a.example/short' })
    await new CachingFetchProvider(stub(htmlResult('https://a.example/long', LONG_PAGE)), store)
      .fetch({ url: 'https://a.example/long' })

    const hit = await new LocalIndexSearchProvider({ store }).search({ query: 'anchovy' })
    assert.equal(hit.sources.length, 1, 'the long page indexed, the short one did not')

    const missing = await new LocalIndexSearchProvider({ store }).search({ query: 'illustrative' })
    assert.equal(missing.sources.length, 0, 'short page should not be retrievable by default')
  } finally {
    cleanup()
  }
})

test('minChars: 0 indexes the short page that the default would lose', async () => {
  const { store, cleanup } = scratchIndex()
  try {
    await new CachingFetchProvider(
      stub(htmlResult('https://a.example/short', SHORT_PAGE)),
      store,
      { minChars: 0 },
    ).fetch({ url: 'https://a.example/short' })

    const hit = await new LocalIndexSearchProvider({ store }).search({ query: 'illustrative' })
    assert.equal(hit.sources.length, 1, 'minChars: 0 must let short pages in')
    assert.equal(new URL(hit.sources[0].url).href, 'https://a.example/short')
    assert.match(hit.sources[0].title, /Example Domain/, 'title indexed with the body')
  } finally {
    cleanup()
  }
})

test('onlySuccessful: false keeps non-2xx responses the caller wanted', async () => {
  const { store, cleanup } = scratchIndex()
  try {
    const errorPage = htmlResult('https://a.example/limited', LONG_PAGE.replace(/anchovy/g, 'anchovy'), 429)
    await new CachingFetchProvider(stub(errorPage), store, { onlySuccessful: true })
      .fetch({ url: 'https://a.example/limited' })
    assert.equal((await new LocalIndexSearchProvider({ store }).search({ query: 'anchovy' })).sources.length, 0,
      'a 429 is not indexed when onlySuccessful is on')

    await new CachingFetchProvider(stub(errorPage), store, { onlySuccessful: false })
      .fetch({ url: 'https://a.example/limited' })
    assert.equal((await new LocalIndexSearchProvider({ store }).search({ query: 'anchovy' })).sources.length, 1,
      'and is indexed when it is off')
  } finally {
    cleanup()
  }
})

test('a storage failure never fails the fetch', async () => {
  const { store, dir, cleanup } = scratchIndex()
  cleanup() // Remove the directory first; writes must now fail.
  const provider = new CachingFetchProvider(stub(htmlResult('https://a.example/x', LONG_PAGE)), store)
  const result = await provider.fetch({ url: 'https://a.example/x' })
  assert.equal(result.statusCode, 200, 'the caller still gets their page even though indexing failed')
  rmSync(dir, { recursive: true, force: true })
})
