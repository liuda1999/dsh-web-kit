/**
 * `So360HtmlSearchProvider`: a `WebSearchProvider` that parses the 360 搜索
 * (`www.so.com`) results page. **No API key and no self-hosted infrastructure.**
 *
 * ## Measured behaviour — read this before depending on it
 *
 * Verified from a mainland-China network on 2026-10-10:
 *
 * - The first ~5 queries from one IP parsed successfully: 3–6 results each,
 *   Chinese and English queries both worked, and `data-mdurl` exposes the real
 *   destination URL directly (no redirect resolution needed).
 * - After that burst, **every subsequent request returned a 6 KB "访问异常页面"
 *   (access anomaly) block page**, and it had not recovered after 3 minutes
 *   or with a `Referer` header. This is IP-level throttling.
 *
 * So: usable at low volume, not usable as a steady primary. It is here as a
 * fallback for domestic-leaning results, not as the default.
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/search/so360-html
 */

import type { Dispatcher } from 'undici'
import { readSearchQuery, WebError } from '../types.js'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '../types.js'
import { deadline, timeoutOf } from '../timeout.js'
import { decodeEntities, stripTags } from './html-text.js'

/** Stable id this provider registers under. */
export const SO360_HTML_PROVIDER_ID = 'so360-html'

/** Default endpoint. */
export const SO360_HTML_ENDPOINT = 'https://www.so.com/s'

/** Attribution header sent on every request. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** The title of the throttle page 360 serves instead of results. */
export const SO360_BLOCK_PAGE_MARKER = '访问异常页面'

/** Resolved provider options. */
export interface So360HtmlSearchProviderOptions {
  /** Endpoint override. Defaults to {@link SO360_HTML_ENDPOINT}. */
  readonly endpoint?: string
  /** Optional per-request timeout in milliseconds. `0` disables the timer. */
  readonly timeoutMs?: number
  /** `Accept-Language` header. Defaults to `zh-CN,zh;q=0.9`. */
  readonly acceptLanguage?: string
  /** Optional dispatcher, e.g. an `undici` `ProxyAgent`. */
  readonly dispatcher?: Dispatcher
}

/** One organic result block. */
const RESULT_BLOCK = /<li[^>]*class="[^"]*\bres-list\b[^"]*"[\s\S]*?<\/li>/gi
/** The title anchor inside a block. */
const TITLE_ANCHOR = /<h3[^>]*class="[^"]*\bres-title\b[^"]*"[^>]*>([\s\S]*?)<\/h3>/i
/** The real destination URL, carried as an attribute — no redirect to follow. */
const MD_URL = /data-mdurl="([^"]+)"/i
/** The snippet paragraph. */
const SNIPPET_PARAGRAPH = /<p[^>]*class="[^"]*\bres-desc\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i

/** True when 360 served its throttle page instead of results. */
export function isSo360Blocked(html: string): boolean {
  return html.includes(SO360_BLOCK_PAGE_MARKER)
}

/** Hosts whose links are 360's own chrome rather than results. */
function isResultUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    const { hostname } = new URL(url)
    return !/(^|\.)(so\.com|360\.cn|360safe\.com|qhres2\.com|qhimg\.com)$/i.test(hostname)
  } catch {
    return false
  }
}

/**
 * Parse a 360 搜索 results page into normalized sources.
 *
 * Each `<li class="res-list">` carries its own title, URL and snippet, so
 * fields are paired by block rather than positionally.
 */
export function parseSo360Html(html: string): WebSearchSource[] {
  if (isSo360Blocked(html)) return []

  const seen = new Set<string>()
  const sources: WebSearchSource[] = []

  for (const [block] of html.matchAll(RESULT_BLOCK)) {
    if (block === undefined) continue

    const anchor = block.match(TITLE_ANCHOR)
    if (anchor?.[1] === undefined) continue
    const innerAnchor = anchor[1].match(/<a[^>]*>([\s\S]*?)<\/a>/i)
    const title = decodeEntities(stripTags(innerAnchor?.[1] ?? ''))
    if (title.length === 0) continue

    // `data-mdurl` is the real destination. The `href` is a so.com/link?m=
    // wrapper, which would need an extra request to resolve — skip it.
    const md = block.match(MD_URL)
    const url = md?.[1] === undefined ? undefined : decodeEntities(md[1])
    if (url === undefined || !isResultUrl(url) || seen.has(url)) continue

    seen.add(url)
    const snippetMatch = block.match(SNIPPET_PARAGRAPH)
    const snippet = snippetMatch?.[1] === undefined ? '' : decodeEntities(stripTags(snippetMatch[1]))
    sources.push({
      url,
      title,
      ...snippet.length > 0 ? { snippet } : {},
    })
  }
  return sources
}

/** The 360-HTML-backed search provider. */
export class So360HtmlSearchProvider implements WebSearchProvider {
  readonly id = SO360_HTML_PROVIDER_ID

  constructor(private readonly options: So360HtmlSearchProviderOptions = {}) {}

  available(): boolean {
    return URL.canParse(this.options.endpoint ?? SO360_HTML_ENDPOINT)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (signal?.aborted) throw new WebError('web search aborted', 'WEB_ABORTED')
    const query = readSearchQuery(request)

    const url = new URL(this.options.endpoint ?? SO360_HTML_ENDPOINT)
    url.searchParams.set('q', query)

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
        throw new WebError(`360 搜索 returned HTTP ${response.status} (throttled or unavailable)`, 'WEB_PROVIDER_ERROR')
      }

      const html = await response.text()
      if (isSo360Blocked(html)) {
        throw new WebError(
          '360 搜索 served its "访问异常页面" throttle page; this IP is rate-limited (observed after ~5 queries)',
          'WEB_PROVIDER_ERROR',
        )
      }
      const sources = parseSo360Html(html)
      if (sources.length === 0) {
        throw new WebError('360 搜索 returned no parsable results (throttled, or markup changed)', 'WEB_PROVIDER_ERROR')
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
