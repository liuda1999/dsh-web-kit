/**
 * Tool-layer argument validation — the boundary a model talks to first.
 *
 * A model that mis-names a field must get a message naming the right field and
 * a code the host can route on. Before this validation existed,
 * `handler({ query: 'x' })` threw `Cannot read properties of undefined
 * (reading 'length')`: still an error, but one the model cannot act on, so it
 * retries the same broken call. These cases pin the corrected behaviour.
 *
 * All offline: both providers are fakes, no network, no browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { WebRuntime, createWebFetchTool, createWebSearchTool } from '../dist/index.js'

const SEARCH_RESULT = {
  sources: [{ url: 'https://example.com/a', title: 'A' }],
  truncated: false,
}

function kit() {
  const web = new WebRuntime()
  web.registerSearchProvider({
    id: 'fake-search',
    available: () => true,
    async search(request) {
      seen.push(request.query)
      return SEARCH_RESULT
    },
  })
  web.registerFetchProvider({
    id: 'fake-fetch',
    available: () => true,
    async fetch(request) {
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: 'hello' }, truncated: false }
    },
  })
  return web
}

const seen = []
const search = createWebSearchTool({ web: kit(), maxQueries: 2 })
const fetch = createWebFetchTool({ web: kit() })

/** Assert a call was refused with a routed code and a message matching `re`. */
async function refused(name, call, re) {
  const out = await call()
  assert.equal(out.isError, true, `${name}: must be an error`)
  assert.equal(out.code, 'WEB_INVALID_ARGS', `${name}: must carry WEB_INVALID_ARGS, got ${out.code}`)
  assert.match(out.text, re, `${name}: message must explain the problem`)
}

test('web_search: the happy path still works after validation', async () => {
  const out = await search.handler({ queries: ['alpha'] })
  assert.equal(out.isError, false)
  assert.equal(out.value.sources.length, 1)
  assert.deepEqual(seen.at(-1), 'alpha')
})

test('web_search: missing queries is refused, not a TypeError', () =>
  refused('missing', () => search.handler({}), /queries must be an array of strings/))

test('web_search: the singular `query` mis-naming names the right field', async () => {
  const out = await search.handler({ query: 'alpha' })
  assert.equal(out.isError, true)
  assert.equal(out.code, 'WEB_INVALID_ARGS')
  assert.match(out.text, /"queries" \(plural\)/)
})

test('web_search: queries of the wrong type are refused', () =>
  refused('string', () => search.handler({ queries: 'alpha' }), /queries must be an array of strings/))

test('web_search: null and undefined arguments are refused', async () => {
  await refused('null args', () => search.handler(null), /queries must be an array of strings/)
  await refused('no args', () => search.handler(undefined), /queries must be an array of strings/)
})

test('web_search: empty and over-long query lists are refused', async () => {
  await refused('empty', () => search.handler({ queries: [] }), /at least one query/)
  await refused('too many', () => search.handler({ queries: ['a', 'b', 'c'] }), /at most 2 queries/)
})

test('web_search: non-string and blank entries are refused', async () => {
  await refused('non-string', () => search.handler({ queries: [1] }), /queries\[0\] must be a string/)
  await refused('blank', () => search.handler({ queries: ['  '] }), /non-empty string/)
})

test('web_fetch: missing or non-string url is refused, not a TypeError', async () => {
  await refused('missing', () => fetch.handler({}), /url must be a string/)
  await refused('null', () => fetch.handler({ url: null }), /url must be a string/)
  await refused('number', () => fetch.handler({ url: 42 }), /url must be a string/)
  await refused('blank', () => fetch.handler({ url: '   ' }), /url must be a non-empty string/)
})

test('web_fetch: the happy path still works after validation', async () => {
  const out = await fetch.handler({ url: 'https://example.com/a' })
  assert.equal(out.isError, false)
  assert.equal(out.value.statusCode, 200)
  assert.equal(out.value.url, 'https://example.com/a')
})
