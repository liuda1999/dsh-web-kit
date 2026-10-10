/**
 * Search engine adapters for {@link BrowserSearchProvider}.
 *
 * Each adapter has two halves:
 * - `buildUrl(query)` runs in Node.
 * - `extract()` runs **inside the browser page**. It is serialized by
 *   Playwright, so it must be self-contained: no closure over Node scope, no
 *   imports, DOM globals only.
 *
 * The selectors below were read off live pages, not guessed. See ATTRIBUTION.md
 * for the measurements that justify each one.
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/browser/engines
 */

/** One row as scraped from a results page, before filtering. */
export interface BrowserRow {
  readonly title: string
  readonly url: string
  readonly snippet: string
  /** True when the row looks like a paid placement. */
  readonly sponsored: boolean
}

/** What a browser-backed engine has to supply. */
export interface BrowserEngine {
  /** Stable engine id, used in the provider id. */
  readonly id: string
  /** Visited once before searching so cookies look organic. */
  readonly homeUrl: string
  /** Build the search URL for one query. */
  readonly buildUrl: (query: string) => string
  /** Runs in the page. Must be self-contained. */
  readonly extract: () => BrowserRow[]
}

/**
 * Bing (`cn.bing.com`).
 *
 * Organic results live in `.b_algo`; paid placements live in `.b_ad`, so
 * selecting `.b_algo` already excludes them. Measured: 10/10 results with both
 * title and URL on four different queries.
 */
export function bingExtract(): BrowserRow[] {
  // Declared inside the function on purpose: this body is serialized into the
  // page, so it cannot reference anything from module scope.
  const tidy = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim()
  const rows: BrowserRow[] = []
  const nodes = document.querySelectorAll('.b_algo')
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i]
    if (!el) continue
    const anchor = el.querySelector('a[href]')
    if (!anchor) continue
    const href = anchor.getAttribute('href') ?? ''
    if (!/^https?:\/\//i.test(href)) continue
    let host = ''
    try {
      host = new URL(href).hostname
    } catch {
      continue
    }
    if (/(^|\.)bing\.com$/i.test(host)) continue
    const heading = el.querySelector('h2')
    const snippetEl = el.querySelector('.b_caption p, .b_lineclamp, .b_lineclamp1, p')
    rows.push({
      title: tidy(heading?.textContent),
      url: href,
      snippet: tidy(snippetEl?.textContent),
      sponsored: false,
    })
  }
  return rows
}

/** The Bing adapter. */
export const BROWSER_ENGINE_BING: BrowserEngine = {
  id: 'bing',
  homeUrl: 'https://cn.bing.com',
  buildUrl: (query) => `https://cn.bing.com/search?q=${encodeURIComponent(query)}`,
  extract: bingExtract,
}

/**
 * Baidu (`www.baidu.com`).
 *
 * Two facts drive this adapter, both measured:
 *
 * 1. **The `mu` attribute carries the real destination URL.** Plain HTTP
 *    scraping only sees `baidu.com/link?url=...` redirect wrappers, which is why
 *    the plain-HTTP parser managed just 4 unusable rows. Reading `mu` in a
 *    browser yields real URLs such as `https://github.com/...`.
 * 2. **Paid placements are not `.result`/`.result-op` and carry no `mu`.** They
 *    use a build-hash class name, so the class filter drops them without
 *    needing to match ad copy.
 *
 * `result-op` rows are Baidu "Aladdin" vertical cards (AI summaries, news
 * aggregators). Some are useful, some are pure chrome; they are kept and left
 * for the result filter to judge on content.
 */
export function baiduExtract(): BrowserRow[] {
  // Self-contained: serialized into the page, so no module-scope references.
  const tidy = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim()
  const rows: BrowserRow[] = []
  const nodes = document.querySelectorAll('#content_left > *')
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i]
    if (!el) continue
    const cls = typeof el.className === 'string' ? el.className : ''
    if (!/\b(result|result-op)\b/.test(cls)) continue

    const mu = el.getAttribute('mu') ?? ''
    // No `mu` at all, or Baidu's placeholder, means there is no real target.
    if (mu.length === 0) continue
    if (mu.indexOf('http://nourl.ubs.baidu.com') === 0) continue
    // Baidu-internal targets are navigation, not results.
    if (/^https?:\/\/[^/]*baidu\.com\/(s\?|baidu\.php|link\?)/i.test(mu)) continue

    const heading = el.querySelector('h3')
    const title = tidy(heading?.textContent)
    const abstract = el.querySelector('.c-abstract, .content-right, .c-span-last')
    let snippet = tidy(abstract?.textContent)
    if (snippet.length === 0) {
      // Aladdin cards have no `.c-abstract`; use the row text minus its title.
      const full = tidy(el.textContent)
      snippet = title.length > 0 && full.indexOf(title) === 0 ? full.slice(title.length).trim() : full
    }
    const text = tidy(el.textContent)
    const sponsored = /^(广告|推广)/.test(text) || /(^|\s)(广告|推广)(\s|$)/.test(text)

    rows.push({ title, url: mu, snippet, sponsored })
  }
  return rows
}

/** The Baidu adapter. */
export const BROWSER_ENGINE_BAIDU: BrowserEngine = {
  id: 'baidu',
  homeUrl: 'https://www.baidu.com',
  buildUrl: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
  extract: baiduExtract,
}

/** The built-in browser engines, keyed by id. */
export const BROWSER_ENGINES: Readonly<Record<string, BrowserEngine>> = {
  bing: BROWSER_ENGINE_BING,
  baidu: BROWSER_ENGINE_BAIDU,
}

/** Look up a built-in engine by id. */
export function browserEngine(id: string): BrowserEngine {
  const engine = BROWSER_ENGINES[id]
  if (engine === undefined) {
    throw new Error(`unknown browser engine "${id}"; known: ${Object.keys(BROWSER_ENGINES).join(', ')}`)
  }
  return engine
}
