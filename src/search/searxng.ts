/**
 * `SearxngSearchProvider`: a `WebSearchProvider` backed by a **self-hosted
 * SearXNG metasearch instance**.
 *
 * This is the recommended provider when you need web search without a
 * third-party API key: SearXNG aggregates upstream engines server-side, so the
 * client needs no credential. Deploy it yourself (see README) and point
 * `baseUrl` at it.
 *
 * The instance must serve the JSON format. Recent SearXNG builds disable it by
 * default; add `json` to `search.formats` in `settings.yml`:
 *
 * ```yaml
 * search:
 *   formats:
 *     - html
 *     - json
 * ```
 *
 * NEW CODE — not present in DeepSeek Harness, which ships DeepSeek/Exa/
 * Perplexity providers that all require an API key. It implements the same
 * `WebSearchProvider` seam, so it composes with the extracted runtime unchanged.
 *
 * @module dsh-web-kit/search/searxng
 */

import type { Dispatcher } from 'undici'
import { readSearchQuery, WebError } from '../types.js'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '../types.js'
import { deadline, timeoutOf } from '../timeout.js'

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/** Default SearXNG location for a local Docker deployment. */
export const SEARXNG_DEFAULT_BASE_URL = 'http://localhost:8080'

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-web-kit/0.1'

/** One entry of SearXNG's `results[]` (only the fields this provider reads). */
interface SearxngResult {
  readonly url?: string
  readonly title?: string
  readonly content?: string
  readonly publishedDate?: string | null
  readonly engine?: string
}

/** Parsed `format=json` response envelope. */
interface SearxngResponse {
  readonly query?: string
  readonly results?: readonly SearxngResult[]
}

/** Resolved provider options. */
export interface SearxngSearchProviderOptions {
  /** SearXNG base URL, e.g. `http://localhost:8080`. No trailing slash needed. */
  baseUrl: string
  /** Optional per-request timeout in milliseconds. `0` disables the timer. */
  timeoutMs?: number
  /** Comma-separated engine list forwarded to SearXNG, e.g. `bing,brave`. */
  engines?: string
  /** Language forwarded to SearXNG. `all` means "do not restrict". */
  language?: string
  /** Safe-search level: `0` off, `1` moderate, `2` strict. */
  safeSearch?: 0 | 1 | 2
  /** Extra headers merged into every request (e.g. an instance access token). */
  headers?: Readonly<Record<string, string>>
  /** Optional dispatcher, e.g. an `undici` `ProxyAgent` for a remote instance. */
  dispatcher?: Dispatcher
}

/** Map one SearXNG result to a normalized source, or `undefined` when unusable. */
export function mapSearxngResult(result: SearxngResult): WebSearchSource | undefined {
  const url = result.url
  if (typeof url !== 'string' || url.length === 0) return undefined
  const title = typeof result.title === 'string' && result.title.length > 0 ? result.title : undefined
  const snippet = typeof result.content === 'string' && result.content.trim().length > 0 ? result.content : undefined
  const published = typeof result.publishedDate === 'string' && result.publishedDate.length > 0
    ? result.publishedDate
    : undefined
  return {
    url,
    ...title !== undefined ? { title } : {},
    ...snippet !== undefined ? { snippet } : {},
    ...published !== undefined ? { publishedAt: published } : {},
  }
}

/** Map a SearXNG envelope to a normalized search result. */
export function mapSearxngResponse(response: SearxngResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapSearxngResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // SearXNG returns no generated answer, so `content` is omitted. The runtime
  // owns the final `maxResults` truncation.
  return { sources, truncated: false }
}

/** The SearXNG-backed search provider. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearxngSearchProviderOptions) {}

  available(): boolean {
    return URL.canParse(this.options.baseUrl)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (signal?.aborted) throw new WebError('web search aborted', 'WEB_ABORTED')
    const query = readSearchQuery(request)

    const url = new URL('/search', this.options.baseUrl)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('language', this.options.language ?? 'all')
    url.searchParams.set('safesearch', String(this.options.safeSearch ?? 0))
    if (this.options.engines !== undefined && this.options.engines.length > 0) {
      url.searchParams.set('engines', this.options.engines)
    }
    if (request.maxResults !== undefined) url.searchParams.set('pageno', '1')

    const d = deadline(signal, this.options.timeoutMs ?? 30_000, 'WEB_SEARCH_TIMEOUT')
    try {
      const { fetch } = await import('undici')
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'accept': 'application/json',
          'user-agent': USER_AGENT,
          ...this.options.headers ?? {},
        },
        signal: d.signal,
        ...this.options.dispatcher !== undefined ? { dispatcher: this.options.dispatcher } : {},
      })

      if (!response.ok) {
        throw new WebError(
          `SearXNG error (HTTP ${response.status}); check that the JSON format is enabled on the instance`,
          'WEB_PROVIDER_ERROR',
        )
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch (error: unknown) {
        throw new WebError(
          `SearXNG returned a non-JSON body (HTTP ${response.status}); check that format=json is enabled`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
      return mapSearxngResponse(payload as SearxngResponse)
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
