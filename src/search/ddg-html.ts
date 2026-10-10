/**
 * `DdgHtmlSearchProvider`: a `WebSearchProvider` that parses the DuckDuckGo
 * HTML endpoint. **No API key and no self-hosted infrastructure.**
 *
 * ## Read this before using it
 *
 * This provider scrapes `https://html.duckduckgo.com/html/`. That endpoint is
 * not a documented API. It is therefore the fragile option:
 *
 * - DuckDuckGo may change the markup or the redirect wrapper at any time, and
 *   this parser stops working with no error other than "zero results".
 * - Automated querying can be rate-limited or blocked by IP, silently.
 * - Scraping may conflict with the endpoint's terms of use. Check your own
 *   compliance obligations.
 *
 * It exists as a zero-infrastructure fallback, not as the recommended path.
 * Prefer {@link SearxngSearchProvider} for anything you depend on.
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/search/ddg-html
 */

import type { Dispatcher } from 'undici'
import { readSearchQuery, WebError } from '../types.js'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '../types.js'
import { deadline, timeoutOf } from '../timeout.js'
import { decodeEntities } from './html-text.js'

export { decodeEntities }

/** Stable id this provider registers under. */
export const DDG_HTML_PROVIDER_ID = 'ddg-html'

/** The HTML endpoint this provider queries. */
export const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/'

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-web-kit/0.1'

/** Resolved provider options. */
export interface DdgHtmlSearchProviderOptions {
  /** Endpoint override. Defaults to {@link DDG_HTML_ENDPOINT}. */
  endpoint?: string
  /** Optional per-request timeout in milliseconds. `0` disables the timer. */
  timeoutMs?: number
  /** Region forwarded as `kl`, e.g. `wt-wt` (worldwide) or `cn-zh`. */
  region?: string
  /** Optional dispatcher, e.g. an `undici` `ProxyAgent`. */
  dispatcher?: Dispatcher
}

/**
 * DuckDuckGo wraps result links as `/l/?uddg=<encoded>&rut=...`. Unwrap the
 * encoded destination; return the input when it is already a direct URL.
 */
export function unwrapDuckDuckGoHref(href: string): string {
  if (!href.includes('uddg=')) return href
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    const target = url.searchParams.get('uddg')
    return target !== null && target.length > 0 ? target : href
  } catch {
    return href
  }
}

/** One `<a class="result__a">` anchor plus its following snippet. */
interface ParsedHit {
  readonly url: string
  readonly title: string
  readonly snippet?: string
}

/** Result-title anchors, in document order. */
const TITLE_ANCHOR = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
/** Snippet anchors, in document order. */
const SNIPPET_ANCHOR = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*href="[^"]*"[^>]*>([\s\S]*?)<\/a>/gi

/**
 * Parse the DuckDuckGo HTML response into normalized sources.
 *
 * Titles and snippets are matched positionally: the Nth snippet belongs to the
 * Nth title. That holds for the current markup and is the single assumption
 * most likely to break.
 */
export function parseDuckDuckGoHtml(html: string): WebSearchSource[] {
  const titles: { url: string; title: string }[] = []
  for (const match of html.matchAll(TITLE_ANCHOR)) {
    const href = match[1]
    const text = match[2]
    if (href === undefined || text === undefined) continue
    const url = unwrapDuckDuckGoHref(decodeEntities(href))
    if (!/^https?:\/\//i.test(url)) continue
    const title = decodeEntities(text)
    if (title.length === 0) continue
    titles.push({ url, title })
  }

  const snippets: string[] = []
  for (const match of html.matchAll(SNIPPET_ANCHOR)) {
    const text = match[1]
    if (text === undefined) continue
    const snippet = decodeEntities(text)
    if (snippet.length > 0) snippets.push(snippet)
  }

  const hits: ParsedHit[] = titles.map((entry, index) => ({
    url: entry.url,
    title: entry.title,
    ...snippets[index] !== undefined ? { snippet: snippets[index] } : {},
  }))

  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const hit of hits) {
    if (seen.has(hit.url)) continue
    seen.add(hit.url)
    sources.push({
      url: hit.url,
      ...hit.title.length > 0 ? { title: hit.title } : {},
      ...hit.snippet !== undefined ? { snippet: hit.snippet } : {},
    })
  }
  return sources
}

/** The DuckDuckGo-HTML-backed search provider. */
export class DdgHtmlSearchProvider implements WebSearchProvider {
  readonly id = DDG_HTML_PROVIDER_ID

  constructor(private readonly options: DdgHtmlSearchProviderOptions = {}) {}

  available(): boolean {
    return URL.canParse(this.options.endpoint ?? DDG_HTML_ENDPOINT)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (signal?.aborted) throw new WebError('web search aborted', 'WEB_ABORTED')
    const query = readSearchQuery(request)

    const endpoint = this.options.endpoint ?? DDG_HTML_ENDPOINT
    const body = new URLSearchParams({ q: query })
    if (this.options.region !== undefined) body.set('kl', this.options.region)

    const d = deadline(signal, this.options.timeoutMs ?? 30_000, 'WEB_SEARCH_TIMEOUT')
    try {
      const { fetch } = await import('undici')
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'accept': 'text/html',
          'user-agent': USER_AGENT,
        },
        body: body.toString(),
        signal: d.signal,
        ...this.options.dispatcher !== undefined ? { dispatcher: this.options.dispatcher } : {},
      })

      if (!response.ok) {
        throw new WebError(
          `DuckDuckGo HTML endpoint returned HTTP ${response.status} (rate limiting or a markup change)`,
          'WEB_PROVIDER_ERROR',
        )
      }

      const html = await response.text()
      const sources = parseDuckDuckGoHtml(html)
      if (sources.length === 0) {
        throw new WebError(
          'DuckDuckGo HTML endpoint returned no parsable results (blocked, rate limited, or markup changed)',
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
