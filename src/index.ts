/**
 * dsh-web-kit — standalone `web_search` / `web_fetch` capability extracted from
 * DeepSeek Harness (deepseek-harness), MIT licensed.
 *
 * Cordis is gone: providers are plain objects, the runtime is a plain class,
 * and the tools are framework-neutral JSON Schema plus a handler.
 *
 * @module dsh-web-kit
 */

export { HarnessError, isHarnessError, errorChain } from './errors.js'
export {
  WebError,
  type WebFetchBody,
  type WebFetchProvider,
  type WebFetchRequest,
  type WebFetchResult,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchSource,
} from './types.js'
export { WebRuntime, type WebRuntimeOptions } from './runtime.js'
export { deadline, timeoutOf, TimeoutReason, type Deadline } from './timeout.js'

export {
  HttpFetchProvider,
  DEFAULT_FETCH_LIMITS,
  LOCAL_FETCH_PROVIDER_ID,
  type HttpFetchLimits,
  type HttpFetchResolver,
} from './fetch/provider.js'
export {
  classifyContentType,
  decoderForCharset,
  isSameOrigin,
  parseCharset,
  parseFetchUrl,
  validateFetchUrl,
  WEB_FETCH_MAX_URL_LENGTH,
  type FetchableKind,
} from './fetch/policy.js'
export {
  createPinnedLookup,
  isNonPublicIpLiteral,
  isPublicIpAddress,
  publicHttpNetwork,
  requestPinned,
  requestVia,
  resolvePublicAddresses,
  type AddressResolver,
  type PublicAddress,
  type PinnedResponse,
} from './fetch/network.js'

export {
  SearxngSearchProvider,
  SEARXNG_PROVIDER_ID,
  SEARXNG_DEFAULT_BASE_URL,
  mapSearxngResponse,
  mapSearxngResult,
  type SearxngSearchProviderOptions,
} from './search/searxng.js'
export {
  BingHtmlSearchProvider,
  BING_HTML_PROVIDER_ID,
  BING_HTML_ENDPOINT,
  parseBingHtml,
  type BingHtmlSearchProviderOptions,
} from './search/bing-html.js'
export {
  So360HtmlSearchProvider,
  SO360_HTML_PROVIDER_ID,
  SO360_HTML_ENDPOINT,
  SO360_BLOCK_PAGE_MARKER,
  isSo360Blocked,
  parseSo360Html,
  type So360HtmlSearchProviderOptions,
} from './search/so360-html.js'
export { withFallback, mergeSources } from './search/fallback.js'
export {
  DdgHtmlSearchProvider,
  DDG_HTML_PROVIDER_ID,
  DDG_HTML_ENDPOINT,
  decodeEntities,
  parseDuckDuckGoHtml,
  unwrapDuckDuckGoHref,
  type DdgHtmlSearchProviderOptions,
} from './search/ddg-html.js'
export { stripTags, collapseWhitespace } from './search/html-text.js'

export {
  createWebFetchTool,
  createWebSearchTool,
  createWebTools,
  webToolPromptSections,
  WEB_FETCH_OUTPUT_SCHEMA,
  WEB_SEARCH_OUTPUT_SCHEMA,
  type JsonSchema,
  type ToolDefinition,
  type ToolOutcome,
  type WebFetchToolOptions,
  type WebSearchToolOptions,
} from './tools/definitions.js'
export {
  DEFAULT_FETCH_MAX_OUTPUT_CHARS,
  fetchMetaFromResult,
  fetchMetaFromValue,
  formatFetchOutput,
  parseFetchArgs,
  renderFetchOutput,
  type RenderedFetch,
  type WebFetchArgs,
  type WebFetchMeta,
} from './tools/fetch.js'
export {
  WEB_SEARCH_MAX_QUERIES,
  WEB_SEARCH_MAX_RESULTS,
  formatSearchOutput,
  mergeSearchResults,
  parseSearchArgs,
  runSearchQueries,
  searchMetaFromResult,
  searchMetaFromValue,
  type WebSearchArgs,
  type WebSearchMeta,
} from './tools/search.js'
export { EXTERNAL_WEB_CONTENT_NOTICE } from './tools/trust.js'
export { renderBody, exceedsConversionDepth, assertNever, OMISSION_MARKER } from './tools/html.js'

import { WebRuntime } from './runtime.js'
import type { WebSearchProvider } from './types.js'
import { DEFAULT_FETCH_LIMITS, HttpFetchProvider, type HttpFetchLimits } from './fetch/provider.js'
import {
  BingHtmlSearchProvider,
  type BingHtmlSearchProviderOptions,
} from './search/bing-html.js'
import {
  DdgHtmlSearchProvider,
  type DdgHtmlSearchProviderOptions,
} from './search/ddg-html.js'
import {
  So360HtmlSearchProvider,
  type So360HtmlSearchProviderOptions,
} from './search/so360-html.js'
import {
  SearxngSearchProvider,
  SEARXNG_DEFAULT_BASE_URL,
  type SearxngSearchProviderOptions,
} from './search/searxng.js'
import { createWebTools, type ToolDefinition } from './tools/definitions.js'

/** Which search backend to use. */
export type SearchBackend =
  | { readonly kind: 'searxng'; readonly options?: SearxngSearchProviderOptions }
  | { readonly kind: 'bing-html'; readonly options?: BingHtmlSearchProviderOptions }
  | { readonly kind: 'so360-html'; readonly options?: So360HtmlSearchProviderOptions }
  | { readonly kind: 'ddg-html'; readonly options?: DdgHtmlSearchProviderOptions }
  /** Bring your own provider; it must implement `WebSearchProvider`. */
  | { readonly kind: 'custom'; readonly provider: WebSearchProvider }

/**
 * The default search backend: Bing HTML scraping. Chosen because it needs no
 * API key, no infrastructure, and no money — the point of this extraction.
 * It is scraping, so it can break; run `npm run check` to detect that.
 */
export const DEFAULT_SEARCH_BACKEND: SearchBackend = { kind: 'bing-html' }

/** Options for {@link createWebKit}. */
export interface WebKitOptions {
  /** The search backend. Defaults to {@link DEFAULT_SEARCH_BACKEND}. Pass `false` to register none. */
  readonly search?: SearchBackend | false
  /** Partial overrides for the HTTP fetch provider limits. */
  readonly fetch?: Partial<HttpFetchLimits>
  /** Register no fetch provider. */
  readonly disableFetch?: boolean
  /** Upper bound on sources returned by one `web_search` call. */
  readonly searchMaxResults?: number
  /** Upper bound on queries accepted by one `web_search` call. */
  readonly searchMaxQueries?: number
  /** Cap on source characters converted and complete `web_fetch` output characters. */
  readonly fetchMaxOutputChars?: number
}

/** The assembled kit. */
export interface WebKit {
  /** The runtime; call `search()` / `fetch()` directly, or use the tools. */
  readonly web: WebRuntime
  /** Framework-neutral tool definitions. */
  readonly tools: readonly ToolDefinition[]
}

/**
 * Assemble a runtime with the selected providers and return ready-to-register
 * tool definitions.
 */
export function createWebKit(options: WebKitOptions = {}): WebKit {
  const web = new WebRuntime()

  const backend = options.search === undefined ? DEFAULT_SEARCH_BACKEND : options.search
  if (backend !== false) {
    web.registerSearchProvider(createSearchProvider(backend))
  }
  if (options.disableFetch !== true) {
    web.registerFetchProvider(new HttpFetchProvider({ ...DEFAULT_FETCH_LIMITS, ...options.fetch ?? {} }))
  }

  const tools = createWebTools({
    web,
    ...options.searchMaxResults !== undefined ? { maxResults: options.searchMaxResults } : {},
    ...options.searchMaxQueries !== undefined ? { maxQueries: options.searchMaxQueries } : {},
    ...options.fetchMaxOutputChars !== undefined ? { maxOutputChars: options.fetchMaxOutputChars } : {},
  })

  return { web, tools }
}

function createSearchProvider(backend: SearchBackend): WebSearchProvider {
  switch (backend.kind) {
    case 'searxng':
      return new SearxngSearchProvider({
        baseUrl: SEARXNG_DEFAULT_BASE_URL,
        ...backend.options ?? {},
      })
    case 'bing-html':
      return new BingHtmlSearchProvider(backend.options ?? {})
    case 'so360-html':
      return new So360HtmlSearchProvider(backend.options ?? {})
    case 'ddg-html':
      return new DdgHtmlSearchProvider(backend.options ?? {})
    case 'custom':
      return backend.provider
    /* v8 ignore next 2 -- SearchBackend is a closed union; unreachable, and only makes a new kind a compile error. */
    default:
      throw new Error(`unsupported search backend: ${JSON.stringify(backend)}`)
  }
}
