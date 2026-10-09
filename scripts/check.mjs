#!/usr/bin/env node
/**
 * dsh-web-kit self-check — `npm run check` / `npx dsh-web-check`.
 *
 * Why this exists: the free search backends are scrapers. They break silently
 * when the upstream markup changes, when the endpoint rate-limits you, or when
 * a captcha page replaces the results. A scraper that returns zero results is
 * the worst possible failure mode for an agent: the model concludes "the
 * internet has no information about this" instead of "my tool is broken".
 *
 * This script makes that failure loud. Exit code 1 means the default backend
 * is not producing usable results right now.
 *
 * Required checks: fetch, and the default search backend (bing-html).
 * Informational: ddg-html, searxng (reported, never fatal).
 */

import {
  BingHtmlSearchProvider,
  DdgHtmlSearchProvider,
  DEFAULT_SEARCH_BACKEND,
  HttpFetchProvider,
  DEFAULT_FETCH_LIMITS,
  SEARXNG_DEFAULT_BASE_URL,
  SearxngSearchProvider,
  So360HtmlSearchProvider,
} from '../dist/index.js'

const QUERY = process.env.DSH_WEB_CHECK_QUERY ?? 'deepseek'
const FETCH_URL = process.env.DSH_WEB_CHECK_URL ?? 'https://example.com'
const SEARXNG_BASE_URL = process.env.SEARXNG_BASE_URL ?? SEARXNG_DEFAULT_BASE_URL
/** Below this, a scraper is presumed broken rather than "no results found". */
const MIN_EXPECTED_RESULTS = 3

const REQUIRED = new Set(['fetch', 'bing-html'])
const rows = []

function record(name, status, detail) {
  rows.push({ name, status, detail })
  const tag = REQUIRED.has(name) ? 'REQUIRED' : 'info    '
  console.log(`[${status === 'ok' ? ' OK ' : status === 'warn' ? 'WARN' : 'FAIL'}] ${tag} ${name.padEnd(10)} ${detail}`)
}

async function timed(fn) {
  const started = Date.now()
  try {
    return { value: await fn(), ms: Date.now() - started }
  } catch (error) {
    return { error, ms: Date.now() - started }
  }
}

function describe(error) {
  const cause = error?.cause
  const code = cause?.code ?? cause?.name
  const message = error?.message ?? String(error)
  const errCode = error?.code ? ` [${error.code}]` : ''
  return code ? `${message}${errCode} (${code})` : `${message}${errCode}`
}

/** A result set is only usable if the first entry has a title and a snippet. */
function qualityOf(sources) {
  if (sources.length === 0) return '0 results'
  const [first] = sources
  const missing = [!first?.title ? 'title' : null, !first?.snippet ? 'snippet' : null].filter(Boolean)
  if (missing.length > 0) return `${sources.length} results, first missing ${missing.join('+')}`
  return `${sources.length} results, first has title+snippet`
}

console.log(`dsh-web-kit self-check — query: "${QUERY}"\n`)

// --- fetch -----------------------------------------------------------------
{
  const provider = new HttpFetchProvider({ ...DEFAULT_FETCH_LIMITS })
  const { value, error, ms } = await timed(() => provider.fetch({ url: FETCH_URL }))
  if (error) {
    record('fetch', 'fail', `${describe(error)} after ${ms}ms`)
  } else if (value.statusCode !== 200) {
    record('fetch', 'fail', `${FETCH_URL} returned HTTP ${value.statusCode}`)
  } else {
    record('fetch', 'ok', `HTTP ${value.statusCode}, ${value.body.content.length} chars of ${value.body.kind}, ${ms}ms`)
  }
}

// --- bing-html (the default backend) ---------------------------------------
async function checkSearch(name, provider) {
  if (!provider.available()) {
    record(name, 'fail', 'provider reports available() === false')
    return
  }
  const { value, error, ms } = await timed(() => provider.search({ query: QUERY, maxResults: 10 }))
  if (error) {
    record(name, 'fail', `${describe(error)} after ${ms}ms`)
    return
  }
  const detail = `${qualityOf(value.sources)}, ${ms}ms`
  if (value.sources.length < MIN_EXPECTED_RESULTS) {
    record(name, 'fail', `${detail} — expected >=${MIN_EXPECTED_RESULTS}; the markup probably changed or you are blocked`)
  } else if (!value.sources[0]?.title || !value.sources[0]?.snippet) {
    record(name, 'warn', `${detail} — parse is degrading, results may be unusable`)
  } else {
    record(name, 'ok', detail)
  }
}

const activeBackend = DEFAULT_SEARCH_BACKEND.kind
if (activeBackend === 'bing-html') {
  await checkSearch('bing-html', new BingHtmlSearchProvider({}))
} else {
  record('bing-html', 'warn', `not the default backend (default is ${activeBackend}); skipped`)
}

// --- so360 (domestic fallback; throttles hard) -----------------------------
{
  const { value, error, ms } = await timed(() =>
    new So360HtmlSearchProvider({}).search({ query: QUERY, maxResults: 10 }),
  )
  if (error) {
    const throttled = /访问异常页面/.test(error?.message ?? '')
    record('so360-html', 'warn',
      `${throttled ? 'throttled by 360' : describe(error)} after ${ms}ms — expected after ~5 queries from one IP; not fatal`)
  } else {
    record('so360-html', 'ok', `${qualityOf(value.sources)}, ${ms}ms`)
  }
}

// --- informational backends ------------------------------------------------
{
  const { value, error, ms } = await timed(() =>
    new DdgHtmlSearchProvider({}).search({ query: QUERY, maxResults: 10 }),
  )
  record('ddg-html', error ? 'warn' : value.sources.length > 0 ? 'ok' : 'warn',
    error ? `${describe(error)} after ${ms}ms (unreachable on many CN networks; not fatal)` : `${qualityOf(value.sources)}, ${ms}ms`)
}

{
  const { value, error, ms } = await timed(() =>
    new SearxngSearchProvider({ baseUrl: SEARXNG_BASE_URL }).search({ query: QUERY, maxResults: 10 }),
  )
  if (error) {
    record('searxng', 'warn', `not available at ${SEARXNG_BASE_URL}: ${describe(error)} (deploy it if you want the stable free option)`)
  } else {
    record('searxng', 'ok', `${qualityOf(value.sources)} at ${SEARXNG_BASE_URL}, ${ms}ms`)
  }
}

const failures = rows.filter(row => REQUIRED.has(row.name) && row.status === 'fail')
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${rows.length} checks, ${failures.length} required failure(s)`)
if (failures.length > 0) {
  console.log('\nThe default search backend is not usable. Before debugging code, check:')
  console.log('  1. Is the site reachable at all?  curl -I https://cn.bing.com')
  console.log('  2. Did the markup change?         open the saved fixture and compare')
  console.log('  3. Are you rate-limited/captcha?  the parser silently finds nothing')
  console.log('  4. Long-term fix:                 deploy SearXNG and switch to kind: "searxng"')
}
process.exit(failures.length === 0 ? 0 : 1)
