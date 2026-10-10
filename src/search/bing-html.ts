/**
 * `BingHtmlSearchProvider`: a `WebSearchProvider` that parses the Bing search
 * results page. **No API key and no self-hosted infrastructure.**
 *
 * ## Read this before using it
 *
 * This scrapes `https://cn.bing.com/search`. That page is not a documented API:
 *
 * - Bing may change the markup at any time; the parser then returns nothing and
 *   the provider throws `WEB_PROVIDER_ERROR` rather than silently reporting an
 *   empty web.
 * - Automated querying can be rate-limited or blocked, and Bing may serve a
 *   challenge page instead of results.
 * - Scraping may conflict with the endpoint's terms of use. Check your own
 *   compliance obligations.
 *
 * It is included because it is the zero-credential option that was actually
 * reachable from a mainland-China network during development (DuckDuckGo's HTML
 * endpoint was not). Prefer {@link SearxngSearchProvider} for anything you
 * depend on.
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/search/bing-html
 */

import type { Dispatcher } from 'undici'
import { readSearchQuery, WebError } from '../types.js'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '../types.js'
import { deadline, timeoutOf } from '../timeout.js'
import { decodeEntities } from './html-text.js'

/** Stable id this provider registers under. */
export const BING_HTML_PROVIDER_ID = 'bing-html'

/** Default endpoint. `cn.bing.com` was the reachable host during development. */
export const BING_HTML_ENDPOINT = 'https://cn.bing.com/search'

/** Attribution header sent on every request. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Resolved provider options. */
export interface BingHtmlSearchProviderOptions {
  /** Endpoint override. Defaults to {@link BING_HTML_ENDPOINT}. */
  readonly endpoint?: string
  /** Optional per-request timeout in milliseconds. `0` disables the timer. */
  readonly timeoutMs?: number
  /** Market forwarded as `mkt`, e.g. `zh-CN` or `en-US`. */
  readonly market?: string
  /** `Accept-Language` header. Defaults to `zh-CN,zh;q=0.9`. */
  readonly acceptLanguage?: string
  /** Optional dispatcher, e.g. an `undici` `ProxyAgent`. */
  readonly dispatcher?: Dispatcher
}

/** Result titles: the anchor inside each `<h2>`. */
const TITLE_ANCHOR = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/gi
/** Result snippets: the paragraph carrying a `b_lineclamp*` class. */
const SNIPPET_PARAGRAPH = /<p[^>]*class="[^"]*b_lineclamp\d*[^"]*"[^>]*>([\s\S]*?)<\/p>/gi

/** Hosts whose links are navigation chrome rather than results. */
function isResultUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    const { hostname } = new URL(url)
    return !/(^|\.)bing\.com$/i.test(hostname)
  } catch {
    return false
  }
}

/**
 * Parse a Bing results page into normalized sources.
 *
 * Titles and snippets are paired positionally: the Nth snippet belongs to the
 * Nth title. Observed pages carry exactly one of each per result.
 */
export function parseBingHtml(html: string): WebSearchSource[] {
  const titles: { url: string; title: string }[] = []
  for (const match of html.matchAll(TITLE_ANCHOR)) {
    const href = match[1]
    const text = match[2]
    if (href === undefined || text === undefined) continue
    if (!isResultUrl(href)) continue
    const title = decodeEntities(text)
    if (title.length === 0) continue
    titles.push({ url: href, title })
  }

  const snippets: string[] = []
  for (const match of html.matchAll(SNIPPET_PARAGRAPH)) {
    const text = match[1]
    if (text === undefined) continue
    const snippet = decodeEntities(text)
    if (snippet.length > 0) snippets.push(snippet)
  }

  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  titles.forEach((entry, index) => {
    if (seen.has(entry.url)) return
    seen.add(entry.url)
    const snippet = snippets[index]
    sources.push({
      url: entry.url,
      title: entry.title,
      ...snippet !== undefined && snippet.length > 0 ? { snippet } : {},
    })
  })
  return sources
}

/** The Bing-HTML-backed search provider. */
export class BingHtmlSearchProvider implements WebSearchProvider {
  readonly id = BING_HTML_PROVIDER_ID

  constructor(private readonly options: BingHtmlSearchProviderOptions = {}) {}

  available(): boolean {
    return URL.canParse(this.options.endpoint ?? BING_HTML_ENDPOINT)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (signal?.aborted) throw new WebError('web search aborted', 'WEB_ABORTED')
    const query = readSearchQuery(request)

    const url = new URL(this.options.endpoint ?? BING_HTML_ENDPOINT)
    url.searchParams.set('q', query)
    if (this.options.market !== undefined) url.searchParams.set('mkt', this.options.market)

    const d = deadline(signal, this.options.timeoutMs ?? 30_000, 'WEB_SEARCH_TIMEOUT')
    try {
      const { fetch } = await import('undici')
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': this.options.acceptLanguage ?? 'zh-CN,zh;q=0.9',
          'user-agent': USER_AGENT,
        },
        signal: d.signal,
        ...this.options.dispatcher !== undefined ? { dispatcher: this.options.dispatcher } : {},
      })

      if (!response.ok) {
        throw new WebError(
          `Bing returned HTTP ${response.status} (rate limiting, a challenge page, or a markup change)`,
          'WEB_PROVIDER_ERROR',
        )
      }

      const html = await response.text()
      const sources = parseBingHtml(html)
      if (sources.length === 0) {
        throw new WebError(
          'Bing returned no parsable results (challenge page, rate limited, or markup changed)',
          'WEB_PROVIDER_ERROR',
        )
      }
      return { sources, truncated: false }
    } catch (error: unknown) {
      throw translateSearchError(error, d.signal)
    } finally {
      d.dispose()
    }
  }
}

/** Classify a thrown value as timeout, cancellation, or provider failure. */
function translateSearchError(error: unknown, signal: AbortSignal): WebError {
  if (error instanceof WebError) return error
  if (timeoutOf(signal, 'WEB_SEARCH_TIMEOUT') !== undefined) {
    return new WebError('web search timed out', 'WEB_SEARCH_TIMEOUT', { cause: error })
  }
  if (signal.aborted) return new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`web search failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}
