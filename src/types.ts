/**
 * Vocabulary for the web capability seam: search and fetch share one seam so
 * provider selection, cancellation, and errors have a single owner, while
 * retaining separate request and result types.
 * Extracted from DeepSeek Harness `packages/web/web/src/types.ts` (MIT).
 * @module dsh-web-kit/types
 */

import { HarnessError } from './errors.js'

/** What one search-capable backend is asked to search. */
export interface WebSearchRequest {
  readonly query: string
  /**
   * Upper bound on returned sources. The runtime truncates to it on the way
   * back; a provider that supports a result-count control should also apply it
   * at the request layer as a cost/latency optimization.
   */
  readonly maxResults?: number
}

/** Normalized search outcome. */
export interface WebSearchResult {
  /** Optional provider-generated answer text or summary. */
  readonly content?: string
  /** Citeable sources. */
  readonly sources: readonly WebSearchSource[]
  /** True when the runtime dropped sources to honor `maxResults`. */
  readonly truncated: boolean
}

/** One citeable source. A source always has a URL; the rest is optional. */
export interface WebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  /** Publication/crawl timestamp as a provider-supplied ISO-8601 string. */
  readonly publishedAt?: string
}

/** What one fetch-capable backend is asked to retrieve. */
export interface WebFetchRequest {
  readonly url: string
}

/**
 * Normalized fetch outcome. A successful network fetch of a non-2xx response is
 * a result, not an error.
 */
export interface WebFetchResult {
  /** The final URL after allowed redirects. */
  readonly url: string
  /** HTTP status code of the fetched response. */
  readonly statusCode: number
  /** Decoded body, classified by content kind. */
  readonly body: WebFetchBody
  /** True when the provider capped the decoded body. */
  readonly truncated: boolean
}

/**
 * A closed discriminated union: the provider decodes the kind, the tool layer
 * renders it. Consumers `switch` on `kind` ending in `default: assertNever()`.
 */
export type WebFetchBody =
  | { readonly kind: 'html'; readonly content: string }
  | { readonly kind: 'text'; readonly content: string }

/** A search-capable backend. */
export interface WebSearchProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Run one search; honor `signal` for cancellation. */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

/** A fetch-capable backend. */
export interface WebFetchProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Retrieve one URL; honor `signal` for cancellation. */
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>
}

/**
 * Typed web error with a machine-routable `code` and chained `cause`.
 * Shared codes: `WEB_PROVIDER_UNAVAILABLE`, `WEB_PROVIDER_AMBIGUOUS`,
 * `WEB_PROVIDER_CONFIGURED_MISSING`, `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`,
 * `WEB_DUPLICATE_PROVIDER`, `WEB_ABORTED`. The local fetch provider adds
 * `WEB_INVALID_URL`, `WEB_BLOCKED_URL`, `WEB_REDIRECT_BLOCKED`,
 * `WEB_FETCH_TOO_LARGE`, `WEB_FETCH_TIMEOUT`, `WEB_UNSUPPORTED_CONTENT_TYPE`,
 * `WEB_PROVIDER_ERROR`. The tool layer adds `WEB_INVALID_ARGS` for rejected
 * arguments, so a mis-named tool field is routable instead of a `TypeError`.
 */
/**
 * Read and validate the query on a search request.
 *
 * Every provider needs this, and none should invent its own rule, because the
 * failure it prevents is quiet rather than loud. `searchParams.set('q', x)`
 * coerces `undefined` to the string `"undefined"`, so a caller who passes the
 * wrong field name (the tool-level shape is `{ queries: [] }`, the provider
 * shape is `{ query: '' }`) receives a full page of well-formed results about
 * JavaScript's `undefined` — and no error saying the request was wrong.
 */
export function readSearchQuery(request: WebSearchRequest, scope = 'web search'): string {
  const query = typeof request.query === 'string' ? request.query.trim() : ''
  if (query.length === 0) throw new WebError(`${scope} query is empty`, 'WEB_PROVIDER_ERROR')
  return query
}

export class WebError extends HarnessError {}
