import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  WebRuntime,
  WebError,
  HttpFetchProvider,
  createWebFetchTool,
  createWebSearchTool,
  validateFetchUrl,
  parseFetchUrl,
  classifyContentType,
  isPublicIpAddress,
  parseDuckDuckGoHtml,
  unwrapDuckDuckGoHref,
  decodeEntities,
  mapSearxngResponse,
  renderBody,
  OMISSION_MARKER,
  formatSearchOutput,
  createWebKit,
  DEFAULT_SEARCH_BACKEND,
  DdgHtmlSearchProvider,
  SearxngSearchProvider,
  BingHtmlSearchProvider,
  parseBingHtml,
  So360HtmlSearchProvider,
  parseSo360Html,
  isSo360Blocked,
  SO360_BLOCK_PAGE_MARKER,
  withFallback,
  mergeSources,
} from '../dist/index.js'
import { readFileSync } from 'node:fs'

/** Start a stub HTTP server on an ephemeral port. Returns the server and its base URL. */
async function stub(handler) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      handler(new URL(req.url ?? '/', 'http://127.0.0.1'), body, res)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { seen, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(r)) }
}

const EXAMPLE = 'https://example.com'

test('policy: rejects non-http schemes', () => {
  assert.throws(() => parseFetchUrl('file:///etc/passwd'), e => e instanceof WebError && e.code === 'WEB_INVALID_URL')
  assert.throws(() => parseFetchUrl('ftp://x/'), e => e.code === 'WEB_INVALID_URL')
})

test('policy: rejects credentials embedded in the URL', () => {
  assert.throws(() => parseFetchUrl('https://user:pw@example.com/'), e => e instanceof WebError && e.code === 'WEB_BLOCKED_URL')
})

test('policy: rejects over-long URLs', () => {
  assert.throws(() => validateFetchUrl(`https://example.com/?q=${'a'.repeat(3000)}`), e => e.code === 'WEB_INVALID_URL')
})

test('policy: classifies content types', () => {
  assert.equal(classifyContentType('text/html; charset=utf-8'), 'html')
  assert.equal(classifyContentType('application/xhtml+xml'), 'html')
  assert.equal(classifyContentType('application/json'), 'text')
  assert.equal(classifyContentType('image/png'), undefined)
  assert.equal(classifyContentType(null), undefined)
})

test('network: public address classification', () => {
  assert.equal(isPublicIpAddress('8.8.8.8'), true)
  assert.equal(isPublicIpAddress('1.1.1.1'), true)
  assert.equal(isPublicIpAddress('127.0.0.1'), false)
  assert.equal(isPublicIpAddress('10.0.0.1'), false)
  assert.equal(isPublicIpAddress('192.168.1.1'), false)
  assert.equal(isPublicIpAddress('172.16.0.1'), false)
  assert.equal(isPublicIpAddress('169.254.169.254'), false)
  assert.equal(isPublicIpAddress('::1'), false)
  assert.equal(isPublicIpAddress('2606:4700::1111'), true)
  assert.equal(isPublicIpAddress('not-an-ip'), false)
})

test('runtime: no provider registered is UNAVAILABLE', async () => {
  const web = new WebRuntime()
  await assert.rejects(web.fetch({ url: EXAMPLE }), e => e instanceof WebError && e.code === 'WEB_PROVIDER_UNAVAILABLE')
  await assert.rejects(web.search({ query: 'x' }), e => e instanceof WebError && e.code === 'WEB_PROVIDER_UNAVAILABLE')
})

test('runtime: two usable providers is AMBIGUOUS', async () => {
  const web = new WebRuntime()
  web.registerFetchProvider(new HttpFetchProvider())
  web.registerFetchProvider({ id: 'second', available: () => true, fetch: async () => { throw new Error('unused') } })
  await assert.rejects(web.fetch({ url: EXAMPLE }), e => e instanceof WebError && e.code === 'WEB_PROVIDER_AMBIGUOUS')
})

test('runtime: configured id that is missing is CONFIGURED_MISSING', async () => {
  const web = new WebRuntime({ fetchProvider: 'nope' })
  web.registerFetchProvider(new HttpFetchProvider())
  await assert.rejects(web.fetch({ url: EXAMPLE }), e => e instanceof WebError && e.code === 'WEB_PROVIDER_CONFIGURED_MISSING')
})

test('runtime: duplicate provider id is rejected', () => {
  const web = new WebRuntime()
  web.registerFetchProvider(new HttpFetchProvider())
  assert.throws(
    () => web.registerFetchProvider(new HttpFetchProvider()),
    e => e instanceof WebError && e.code === 'WEB_DUPLICATE_PROVIDER',
  )
})

test('runtime: disposer unregisters', async () => {
  const web = new WebRuntime()
  const dispose = web.registerFetchProvider(new HttpFetchProvider())
  assert.deepEqual(web.listFetchProviders(), ['http'])
  dispose()
  await assert.rejects(web.fetch({ url: EXAMPLE }), e => e.code === 'WEB_PROVIDER_UNAVAILABLE')
})

test('runtime: caps sources to maxResults and flags truncation', async () => {
  const web = new WebRuntime()
  web.registerSearchProvider({
    id: 'fake',
    available: () => true,
    async search() {
      return {
        sources: Array.from({ length: 5 }, (_v, i) => ({ url: `https://x/${i}` })),
        truncated: false,
      }
    },
  })
  const result = await web.search({ query: 'q', maxResults: 2 })
  assert.equal(result.sources.length, 2)
  assert.equal(result.truncated, true)
})

test('fetch provider: refuses loopback literals (SSRF defence)', async () => {
  const provider = new HttpFetchProvider({ maxResponseBytes: 1000, maxBodyChars: 100, timeoutMs: 5000, maxRedirects: 0, userAgent: 'test' })
  await assert.rejects(provider.fetch({ url: 'http://127.0.0.1:1/' }), e => e instanceof WebError && e.code === 'WEB_BLOCKED_URL')
})

test('html: turndown converts headings and strips scripts', () => {
  const out = renderBody({ kind: 'html', content: '<h1>Title</h1><script>evil()</script><p>Body</p>' }, 100_000)
  assert.match(out.text, /# Title/)
  assert.match(out.text, /Body/)
  assert.doesNotMatch(out.text, /evil\(\)/)
})

test('html: pathological nesting is refused, not converted', () => {
  const deep = '<div>'.repeat(600)
  const out = renderBody({ kind: 'html', content: deep }, 100_000)
  assert.equal(out.text, OMISSION_MARKER)
})

test('html: text bodies pass through', () => {
  const out = renderBody({ kind: 'text', content: 'plain' }, 100_000)
  assert.equal(out.text, 'plain')
  assert.equal(out.sourceTruncated, false)
})

test('ddg: unwraps the uddg redirect wrapper', () => {
  const wrapped = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc'
  assert.equal(unwrapDuckDuckGoHref(wrapped), 'https://example.com/page')
  assert.equal(unwrapDuckDuckGoHref('https://direct.example/x'), 'https://direct.example/x')
})

test('ddg: decodes entities', () => {
  assert.equal(decodeEntities('a &amp; b &#39;c&#39; &#x27;d&#x27;'), "a & b 'c' 'd'")
  assert.equal(decodeEntities('<b>bold</b> text'), 'bold text')
})

test('ddg: parses a synthetic result page', () => {
  const html = [
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fone.example%2Fa">First &amp; Title</a>',
    '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fone.example%2Fa">First snippet</a>',
    '<a rel="nofollow" class="result__a" href="https://two.example/b">Second Title</a>',
    '<a class="result__snippet" href="https://two.example/b">Second snippet</a>',
    '<a rel="nofollow" class="result__a" href="https://one.example/a">Duplicate URL</a>',
  ].join('\n')
  const sources = parseDuckDuckGoHtml(html)
  assert.equal(sources.length, 2, 'duplicate URL must be dropped')
  assert.equal(sources[0].url, 'https://one.example/a')
  assert.equal(sources[0].title, 'First & Title')
  assert.equal(sources[0].snippet, 'First snippet')
  assert.equal(sources[1].url, 'https://two.example/b')
  assert.equal(sources[1].snippet, 'Second snippet')
})

test('searxng: maps a JSON envelope', () => {
  const result = mapSearxngResponse({
    results: [
      { url: 'https://a/', title: 'A', content: 'snip', publishedDate: '2026-01-02' },
      { url: 'https://b/', title: 'B', content: '' },
      { title: 'no url' },
    ],
  })
  assert.equal(result.sources.length, 2)
  assert.deepEqual(result.sources[0], { url: 'https://a/', title: 'A', snippet: 'snip', publishedAt: '2026-01-02' })
  assert.deepEqual(result.sources[1], { url: 'https://b/', title: 'B' })
  assert.equal(result.truncated, false)
})

test('search tool: validates arguments', async () => {
  const web = new WebRuntime()
  const tool = createWebSearchTool({ web })
  assert.equal(tool.name, 'web_search')
  assert.equal(tool.parameters.required[0], 'queries')

  const empty = await tool.handler({ queries: [] })
  assert.equal(empty.isError, true)
  assert.match(empty.text, /at least one query/)

  const tooMany = await tool.handler({ queries: ['1', '2', '3', '4', '5'] })
  assert.equal(tooMany.isError, true)
  assert.match(tooMany.text, /at most 4 queries/)
})

test('search tool: formats output with markdown links', () => {
  const text = formatSearchOutput({
    sources: [{ url: 'https://one.example/deep', title: 'One', snippet: 'hello', publishedAt: '2026-01-01' }],
    truncated: false,
  })
  assert.match(text, /External web content follows/)
  assert.match(text, /- \[One\]\(https:\/\/one\.example\/deep\)/)
  assert.match(text, /— hello \(2026-01-01\)/)
  assert.match(text, /Cite the relevant URLs/)
})

test('fetch tool: rejects an empty url without touching the network', async () => {
  const web = new WebRuntime()
  const tool = createWebFetchTool({ web })
  const out = await tool.handler({ url: '   ' })
  assert.equal(out.isError, true)
  assert.match(out.text, /url must be a non-empty string/)
})

test('kit: createWebKit wires providers and tools', () => {
  const kit = createWebKit()
  assert.deepEqual(kit.web.listFetchProviders(), ['http'])
  // Zero config must give a working free backend, or the default is a trap.
  assert.deepEqual(kit.web.listSearchProviders(), [DEFAULT_SEARCH_BACKEND.kind])
  assert.deepEqual(kit.tools.map(t => t.name), ['web_search', 'web_fetch'])

  const bare = createWebKit({ search: false })
  assert.deepEqual(bare.web.listSearchProviders(), [])
})

test('fetch: real network fetch of a public page', async (t) => {
  const provider = new HttpFetchProvider()
  let result
  try {
    result = await provider.fetch({ url: EXAMPLE })
  } catch (error) {
    if (error instanceof WebError && ['WEB_PROVIDER_ERROR', 'WEB_FETCH_TIMEOUT', 'WEB_ABORTED'].includes(error.code)) {
      t.skip(`network unavailable: ${error.code} ${error.message}`)
      return
    }
    throw error
  }
  assert.equal(result.statusCode, 200)
  assert.equal(result.body.kind, 'html')
  assert.match(result.body.content, /Example Domain/)
  assert.equal(result.url, new URL(EXAMPLE).toString())

  const tool = createWebFetchTool({ web: new WebRuntime() })
  const runtime = new WebRuntime()
  runtime.registerFetchProvider(provider)
  const out = await createWebFetchTool({ web: runtime }).handler({ url: EXAMPLE })
  assert.equal(out.isError, false)
  assert.match(out.text, /^Fetched https:\/\/example\.com/ )
  assert.match(out.text, /\(HTTP 200\)/)
  assert.match(out.text, /External web content follows/)
  assert.equal(tool.name, 'web_fetch')
})

test('searxng: end-to-end against a local stub instance', async () => {
  const { seen, baseUrl, close } = await stub((url, _body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      query: url.searchParams.get('q'),
      results: [
        { url: 'https://a.example/1', title: 'Alpha', content: 'alpha snippet', publishedDate: '2026-03-01' },
        { url: 'https://b.example/2', title: 'Beta', content: 'beta snippet' },
      ],
    }))
  })
  try {
    const provider = new SearxngSearchProvider({ baseUrl, timeoutMs: 10_000 })
    assert.equal(provider.available(), true)
    const result = await provider.search({ query: 'hello world', maxResults: 5 })

    const request = seen[0]
    const sent = new URL(request.url, 'http://x')
    assert.equal(request.method, 'GET')
    assert.equal(sent.pathname, '/search')
    assert.equal(sent.searchParams.get('q'), 'hello world')
    assert.equal(sent.searchParams.get('format'), 'json')

    assert.equal(result.sources.length, 2)
    assert.equal(result.sources[0].url, 'https://a.example/1')
    assert.equal(result.sources[0].snippet, 'alpha snippet')
    assert.equal(result.sources[0].publishedAt, '2026-03-01')
    assert.equal(result.sources[1].snippet, 'beta snippet')
    assert.equal(result.truncated, false)
  } finally {
    await close()
  }
})

test('searxng: an HTML body (JSON format disabled) is reported, not silently empty', async () => {
  const { baseUrl, close } = await stub((_url, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body>search</body></html>')
  })
  try {
    const provider = new SearxngSearchProvider({ baseUrl })
    await assert.rejects(
      provider.search({ query: 'x' }),
      e => e instanceof WebError && e.code === 'WEB_PROVIDER_ERROR' && /non-JSON/.test(e.message),
    )
  } finally {
    await close()
  }
})

test('searxng: HTTP 403 (JSON format forbidden) surfaces with actionable advice', async () => {
  const { baseUrl, close } = await stub((_url, _body, res) => {
    res.writeHead(403)
    res.end('Forbidden')
  })
  try {
    const provider = new SearxngSearchProvider({ baseUrl })
    await assert.rejects(
      provider.search({ query: 'x' }),
      e => e instanceof WebError && e.code === 'WEB_PROVIDER_ERROR' && /JSON format is enabled/.test(e.message),
    )
  } finally {
    await close()
  }
})

test('ddg-html: end-to-end against a local stub endpoint', async () => {
  const html = [
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Falpha.example%2F1">Alpha &amp; Co</a>',
    '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Falpha.example%2F1">alpha snippet</a>',
    '<a rel="nofollow" class="result__a" href="https://beta.example/2">Beta</a>',
    '<a class="result__snippet" href="https://beta.example/2">beta snippet</a>',
  ].join('\n')
  const { seen, baseUrl, close } = await stub((_url, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  try {
    const provider = new DdgHtmlSearchProvider({ endpoint: baseUrl, timeoutMs: 10_000 })
    const result = await provider.search({ query: 'stub query', maxResults: 5 })

    assert.equal(seen[0].method, 'POST')
    assert.match(seen[0].body, /q=stub\+query/)

    assert.equal(result.sources.length, 2)
    assert.deepEqual(result.sources[0], {
      url: 'https://alpha.example/1',
      title: 'Alpha & Co',
      snippet: 'alpha snippet',
    })
    assert.equal(result.sources[1].url, 'https://beta.example/2')
  } finally {
    await close()
  }
})

test('ddg-html: zero parsable results is an error, not an empty success', async () => {
  const { baseUrl, close } = await stub((_url, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body>please complete the captcha</body></html>')
  })
  try {
    const provider = new DdgHtmlSearchProvider({ endpoint: baseUrl })
    await assert.rejects(
      provider.search({ query: 'x' }),
      e => e instanceof WebError && e.code === 'WEB_PROVIDER_ERROR' && /no parsable results/.test(e.message),
    )
  } finally {
    await close()
  }
})

test('bing: parses the real captured results page', () => {
  const html = readFileSync(new URL('./fixtures/bing-cn.html', import.meta.url), 'utf8')
  const sources = parseBingHtml(html)

  // The fixture carries 10 result blocks; the parser must find most of them.
  assert.ok(sources.length >= 5, `expected at least 5 sources, got ${sources.length}`)

  for (const source of sources) {
    assert.match(source.url, /^https?:\/\//, `absolute url expected: ${source.url}`)
    assert.ok(!/bing\.com/i.test(new URL(source.url).hostname), `bing chrome leaked in: ${source.url}`)
    assert.doesNotMatch(source.title ?? '', /<[a-z]/i, `tags not stripped: ${source.title}`)
    assert.doesNotMatch(source.title ?? '', /&[a-z]+;|&#\d+;/i, `entities not decoded: ${source.title}`)
  }

  const urls = new Set(sources.map(s => s.url))
  assert.equal(urls.size, sources.length, 'urls must be de-duplicated')

  const withSnippet = sources.filter(s => typeof s.snippet === 'string' && s.snippet.length > 0)
  assert.ok(withSnippet.length > 0, 'at least one source should carry a snippet')
  for (const source of withSnippet) {
    assert.doesNotMatch(source.snippet, /&[a-z]+;|&#\d+;/i, `entities not decoded: ${source.snippet}`)
  }

  // The fixture was captured for this exact query; the official site must surface.
  assert.ok(
    sources.some(s => s.url.includes('deepseek')),
    `expected a deepseek result; got ${JSON.stringify(sources.slice(0, 3), null, 2)}`,
  )
  console.log(`[bing fixture] ${sources.length} sources; first:`, JSON.stringify(sources[0], null, 2))
})

test('so360: parses the real captured results page', () => {
  const html = readFileSync(new URL('./fixtures/so360.html', import.meta.url), 'utf8')
  assert.equal(isSo360Blocked(html), false, 'fixture must be a real results page, not the throttle page')

  const sources = parseSo360Html(html)
  assert.ok(sources.length >= 3, `expected at least 3 sources, got ${sources.length}`)

  for (const source of sources) {
    assert.match(source.url, /^https?:\/\//, `absolute url expected: ${source.url}`)
    // The real URL must come from data-mdurl, never from the so.com/link wrapper.
    assert.doesNotMatch(source.url, /so\.com\/link/i, `redirect wrapper leaked in: ${source.url}`)
    assert.ok(!/(^|\.)(so\.com|360\.cn)$/i.test(new URL(source.url).hostname), `360 chrome leaked: ${source.url}`)
    assert.doesNotMatch(source.title ?? '', /<[a-z]/i, `tags not stripped: ${source.title}`)
    assert.doesNotMatch(source.title ?? '', /&[a-z]+;|&#\d+;/i, `entities not decoded: ${source.title}`)
  }

  const urls = new Set(sources.map(s => s.url))
  assert.equal(urls.size, sources.length, 'urls must be de-duplicated')
  assert.ok(
    sources.some(s => /deepseek/i.test(s.url + (s.title ?? ''))),
    `expected a deepseek result; got ${JSON.stringify(sources.slice(0, 3), null, 2)}`,
  )
  console.log(`[so360 fixture] ${sources.length} sources; first:`, JSON.stringify(sources[0], null, 2))
})

test('so360: throttle page is detected and yields zero sources', () => {
  // Captured live: after ~5 queries this IP got this exact 6 KB page back.
  const blocked = `<!DOCTYPE html><html><head><title>${SO360_BLOCK_PAGE_MARKER}</title></head><body></body></html>`
  assert.equal(isSo360Blocked(blocked), true)
  assert.deepEqual(parseSo360Html(blocked), [])
})

test('so360: end-to-end against a local stub endpoint', async () => {
  const html = [
    '<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=aaa" data-mdurl="https://alpha.example/1">Alpha &amp; Co</a></h3>',
    '<p class="res-desc"><span class="gray g-c-gray">2026年9月30日&nbsp;-&nbsp;</span>alpha snippet</p></li>',
    '<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=bbb" data-mdurl="https://beta.example/2">Beta</a></h3>',
    '<p class="res-desc">beta snippet</p></li>',
    // No data-mdurl: the href is a wrapper we cannot resolve, so it is dropped.
    '<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=ccc">Wrapper only</a></h3></li>',
    // 360's own chrome must never become a source.
    '<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/help" data-mdurl="https://www.so.com/help">Chrome</a></h3></li>',
  ].join('\n')
  const { baseUrl, close } = await stub((_url, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  try {
    const provider = new So360HtmlSearchProvider({ endpoint: baseUrl })
    const result = await provider.search({ query: 'x', maxResults: 10 })
    assert.deepEqual(result.sources.map(s => s.url), ['https://alpha.example/1', 'https://beta.example/2'])
    assert.equal(result.sources[0].title, 'Alpha & Co')
    assert.match(result.sources[0].snippet ?? '', /alpha snippet/)
  } finally {
    await close()
  }
})

test('so360: throttle page end-to-end throws WEB_PROVIDER_ERROR', async () => {
  const { baseUrl, close } = await stub((_url, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<html><head><title>${SO360_BLOCK_PAGE_MARKER}</title></head><body>访问异常</body></html>`)
  })
  try {
    const provider = new So360HtmlSearchProvider({ endpoint: baseUrl })
    await assert.rejects(
      () => provider.search({ query: 'x' }),
      e => e instanceof WebError && e.code === 'WEB_PROVIDER_ERROR' && /访问异常页面/.test(e.message),
    )
  } finally {
    await close()
  }
})

test('fallback: falls through a failing provider and a zero-result provider', async () => {
  const calls = []
  const dead = {
    id: 'dead',
    available: () => true,
    search: async () => { calls.push('dead'); throw new WebError('boom', 'WEB_PROVIDER_ERROR') },
  }
  const empty = {
    id: 'empty',
    available: () => true,
    search: async () => { calls.push('empty'); return { sources: [], truncated: false } },
  }
  const good = {
    id: 'good',
    available: () => true,
    search: async () => { calls.push('good'); return { sources: [{ url: 'https://x.example/', title: 'X' }], truncated: false } },
  }
  const chain = withFallback(dead, empty, good)
  assert.equal(chain.id, 'dead', 'chain reports the first provider id')

  const result = await chain.search({ query: 'q' })
  assert.deepEqual(calls, ['dead', 'empty', 'good'])
  assert.equal(result.sources.length, 1)

  // Total failure must name every attempt.
  const allBad = withFallback(empty, dead)
  await assert.rejects(
    () => allBad.search({ query: 'q' }),
    e => e instanceof WebError && e.code === 'WEB_PROVIDER_ERROR'
      && /all search providers failed/.test(e.message) && /empty: 0 results/.test(e.message) && /dead: boom/.test(e.message),
  )
})

test('fallback: cancellation is not swallowed by the chain', async () => {
  const controller = new AbortController()
  const slow = {
    id: 'slow',
    available: () => true,
    search: async (_req, signal) => {
      controller.abort()
      throw new WebError('aborted', 'WEB_ABORTED', {})
    },
  }
  const chain = withFallback(slow, slow)
  await assert.rejects(() => chain.search({ query: 'q' }, controller.signal), e => e instanceof WebError)
})

test('fallback: mergeSources de-duplicates by url', () => {
  const a = [{ url: 'https://x.example/' }, { url: 'https://y.example/' }]
  const b = [{ url: 'https://x.example/', title: 'dup' }, { url: 'https://z.example/' }]
  assert.deepEqual(mergeSources(a, b).map(s => s.url), ['https://x.example/', 'https://y.example/', 'https://z.example/'])
})

test('bing: end-to-end against a local stub endpoint', async () => {
  const html = [
    '<li class="b_algo"><h2><a href="https://alpha.example/1">Alpha &amp; Co</a></h2>',
    '<div class="b_caption"><p class="b_lineclamp2">alpha snippet</p></div></li>',
    '<li class="b_algo"><h2><a href="https://beta.example/2"><strong>Beta</strong></a></h2>',
    '<div class="b_caption"><p class="b_lineclamp3">beta snippet</p></div></li>',
    '<li class="b_algo"><h2><a href="https://www.bing.com/maps">Bing chrome must be dropped</a></h2></li>',
  ].join('\n')
  const { seen, baseUrl, close } = await stub((_url, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  try {
    const provider = new BingHtmlSearchProvider({ endpoint: baseUrl, timeoutMs: 10_000 })
    const result = await provider.search({ query: 'stub', maxResults: 5 })

    const sent = new URL(seen[0].url, 'http://x')
    assert.equal(sent.searchParams.get('q'), 'stub')

    assert.equal(result.sources.length, 2)
    assert.deepEqual(result.sources[0], { url: 'https://alpha.example/1', title: 'Alpha & Co', snippet: 'alpha snippet' })
    assert.deepEqual(result.sources[1], { url: 'https://beta.example/2', title: 'Beta', snippet: 'beta snippet' })
  } finally {
    await close()
  }
})

test('search: real Bing query (no API key)', async (t) => {
  const provider = new BingHtmlSearchProvider({ timeoutMs: 20_000 })
  assert.equal(provider.available(), true)
  let result
  try {
    result = await provider.search({ query: 'deepseek harness', maxResults: 5 })
  } catch (error) {
    const code = error instanceof WebError ? error.code : 'UNKNOWN'
    t.skip(`bing-html unavailable: ${code} — ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  assert.ok(result.sources.length > 0, 'expected at least one parsed source')
  console.log(`[bing live] ${result.sources.length} sources; first:`, JSON.stringify(result.sources[0], null, 2))
})

test('search: real Bing across several query shapes (measured stability)', async (t) => {
  const provider = new BingHtmlSearchProvider({ timeoutMs: 20_000 })
  const queries = ['deepseek 本地部署', '多智能体 架构设计', 'typescript satisfies 运算符', '上海 天气预报']
  const counts = []
  let failures = 0

  for (const query of queries) {
    try {
      const result = await provider.search({ query, maxResults: 8 })
      counts.push(`${query}=${result.sources.length}`)
      assert.ok(result.sources.length > 0, `no sources for "${query}"`)
      assert.ok((result.sources[0]?.title ?? '').length > 0, `no title for "${query}"`)
      assert.match(result.sources[0]?.url ?? '', /^https?:\/\//)
    } catch (error) {
      failures += 1
      counts.push(`${query}=FAIL(${error instanceof WebError ? error.code : 'UNKNOWN'})`)
    }
  }
  console.log(`[bing multi-query] ${counts.join('  |  ')}`)

  if (failures === queries.length) {
    t.skip(`all ${queries.length} live queries failed — bing-html is unavailable from this network right now`)
    return
  }
  assert.equal(failures, 0, `every query should return sources: ${counts.join(' | ')}`)
})

test('search: real 360 query — skipped when the IP is throttled', async (t) => {
  // Measured: the first ~5 queries from one IP succeed, then every request is
  // answered with the "访问异常页面" throttle page. A skip here is the expected
  // outcome after any recent probing, not a code defect.
  const provider = new So360HtmlSearchProvider({ timeoutMs: 20_000 })
  try {
    const result = await provider.search({ query: 'deepseek 本地部署', maxResults: 8 })
    assert.ok(result.sources.length > 0)
    console.log(`[so360 live] ${result.sources.length} sources; first:`, JSON.stringify(result.sources[0], null, 2))
  } catch (error) {
    const code = error instanceof WebError ? error.code : 'UNKNOWN'
    const throttled = /访问异常页面|throttle|HTTP 4|HTTP 5/.test(error instanceof Error ? error.message : '')
    t.skip(`so360-html ${throttled ? 'throttled' : 'unavailable'} (${code}) — ${error instanceof Error ? error.message : String(error)}`)
  }
})

test('search: real DuckDuckGo HTML query (no API key)', async (t) => {
  const provider = new DdgHtmlSearchProvider({ timeoutMs: 20_000 })
  assert.equal(provider.available(), true)
  let result
  try {
    result = await provider.search({ query: 'deepseek', maxResults: 5 })
  } catch (error) {
    // A live scrape can legitimately fail: rate limiting, IP blocking, or a
    // markup change. Report the reason rather than pretending it passed.
    const code = error instanceof WebError ? error.code : 'UNKNOWN'
    t.skip(`ddg-html unavailable: ${code} — ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  assert.ok(result.sources.length > 0, 'expected at least one parsed source')
  for (const source of result.sources) {
    assert.match(source.url, /^https?:\/\//, `source url should be absolute: ${source.url}`)
  }
  assert.ok(
    result.sources.every(s => typeof s.title === 'string' && s.title.length > 0),
    'every source should carry a title',
  )
  console.log(
    `[ddg-html live] ${result.sources.length} sources; first:`,
    JSON.stringify(result.sources[0], null, 2),
  )
})
