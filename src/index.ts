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

// --- browser automation ----------------------------------------------------
export {
  BrowserPool,
  DEFAULT_USER_AGENT,
  type BrowserContext,
  type BrowserHandle,
  type BrowserPage,
  type BrowserPoolOptions,
} from './browser/pool.js'
export {
  BROWSER_ENGINES,
  BROWSER_ENGINE_BAIDU,
  BROWSER_ENGINE_BING,
  baiduExtract,
  bingExtract,
  browserEngine,
  type BrowserEngine,
  type BrowserRow,
} from './browser/engines.js'
export {
  BrowserSearchProvider,
  BROWSER_PROVIDER_PREFIX,
  type BrowserSearchProviderOptions,
} from './browser/provider.js'

// --- content filtering -----------------------------------------------------
export {
  canonicalUrl,
  canonicalTitle,
  filterSources,
  isEngineLink,
  keywordHit,
  resolveRules,
  scoreSource,
  sourceHost,
  survived,
  describeFilter,
  toSources,
  withFilter,
  DEFAULT_FILTER_LEVEL,
  FILTER_LEVELS,
  FILTER_RULE_NAMES,
  type DemotedSource,
  type DroppedSource,
  type FilterLevel,
  type FilterOutcome,
  type FilterRule,
  type FilterRules,
  type FilterableSource,
  type ResultFilterOptions,
  type RuleAction,
  type ScoredSource,
} from './filter/result-filter.js'
export {
  cleanPageHtml,
  extractMainContent,
  htmlToText,
  DEFAULT_EXTRACT_MODE,
  EXTRACT_MODES,
  type ExtractFallback,
  type ExtractMode,
  type ExtractModeSpec,
  type ExtractOptions,
  type ExtractedContent,
} from './filter/extract.js'
export {
  UNREADABLE_INPUT_TYPES,
  controlValue,
  type AttributeReader,
} from './filter/controls.js'

// --- local index -----------------------------------------------------------
export { DocStore, docId, type StoredDoc, type StoredDocInput } from './local/store.js'
export {
  bm25,
  excerpt,
  indexDoc,
  termFrequencies,
  tokenize,
  type Bm25Hit,
  type Bm25Options,
  type IndexedDoc,
} from './local/bm25.js'
export {
  CachingFetchProvider,
  htmlTitle,
  type CachingFetchProviderOptions,
} from './local/caching-fetch.js'
export {
  DEFAULT_INDEX_DIR,
  LocalIndexSearchProvider,
  LOCAL_INDEX_PROVIDER_ID,
  type LocalIndexSearchProviderOptions,
} from './local/provider.js'

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
import { withFallback } from './search/fallback.js'
import { BrowserSearchProvider, type BrowserSearchProviderOptions } from './browser/provider.js'
import { withFilter, type ResultFilterOptions } from './filter/result-filter.js'
import type { ExtractOptions } from './filter/extract.js'
import { CachingFetchProvider, type CachingFetchProviderOptions } from './local/caching-fetch.js'
import {
  DEFAULT_INDEX_DIR,
  LocalIndexSearchProvider,
  type LocalIndexSearchProviderOptions,
} from './local/provider.js'
import { DocStore } from './local/store.js'
import { createWebTools, type ToolDefinition } from './tools/definitions.js'

/** Which search backend to use. */
export type SearchBackend =
  | { readonly kind: 'searxng'; readonly options?: SearxngSearchProviderOptions }
  | { readonly kind: 'bing-html'; readonly options?: BingHtmlSearchProviderOptions }
  | { readonly kind: 'so360-html'; readonly options?: So360HtmlSearchProviderOptions }
  | { readonly kind: 'ddg-html'; readonly options?: DdgHtmlSearchProviderOptions }
  /**
   * Drive a real browser (needs the optional `playwright` dependency). This is
   * the only way to use Baidu: over plain HTTP every link is a redirect wrapper.
   */
  | { readonly kind: 'browser'; readonly options?: BrowserSearchProviderOptions }
  /**
   * Browser first, plain HTTP second. The browser sees the richer page; if
   * Playwright is missing or no browser can launch, HTTP still answers.
   */
  | { readonly kind: 'browser-first'; readonly options?: BrowserSearchProviderOptions }
  /**
   * Plain HTTP first, browser second. Runs scrape-Bing (HTTP) and, only if that
   * fails or answers empty, scrape-Bing through a real browser.
   */
  | { readonly kind: 'http-first'; readonly options?: BrowserSearchProviderOptions }
  /** Search only the pages this machine has already fetched. */
  | { readonly kind: 'local-index'; readonly options?: LocalIndexSearchProviderOptions }
  /** Bring your own provider; it must implement `WebSearchProvider`. */
  | { readonly kind: 'custom'; readonly provider: WebSearchProvider }

/**
 * The default: scrape Bing over plain HTTP first, fall back to driving a real
 * browser if that ever stops answering.
 *
 * No API key, no infrastructure, no money — the point of this extraction.
 *
 * Why HTTP is first, when `browser-first` also works: both are scrape-Bing and
 * they agree on the top result for four queries out of five, but the browser
 * costs **5,558 ms median against 149 ms** — 37× — and drags in Playwright, an
 * optional dependency, for no better answer. Latency on the default path is a
 * real cost when this sits under a model that waits for the result.
 *
 * Both halves are scrapers and both can break; run `npm run check` to detect
 * that, and note that 360 Search throttles a single IP after roughly five
 * queries, which is why it is not in the default chain.
 */
export const DEFAULT_SEARCH_BACKEND: SearchBackend = { kind: 'http-first' }

/** Options for {@link createWebKit}. */
export interface WebKitOptions {
  /** The search backend. Defaults to {@link DEFAULT_SEARCH_BACKEND}. Pass `false` to register none. */
  readonly search?: SearchBackend | false
  /** Partial overrides for the HTTP fetch provider limits. */
  readonly fetch?: Partial<HttpFetchLimits>
  /** Register no fetch provider. */
  readonly disableFetch?: boolean
  /**
   * Result filtering applied to every search. Defaults to {@link DEFAULT_FILTER_LEVEL}
   * (`loose`), which drops only rows that are provably not content and merely
   * *relegates* suspicious ones to the back — nothing is lost without saying so.
   * Pass `false` to disable, or see {@link ResultFilterOptions} for levels.
   */
  readonly filter?: ResultFilterOptions | false
  /**
   * Remember fetched pages so they can be searched offline later. Omitting it
   * or passing `false` disables — indexing writes to disk, so it is opt-in.
   */
  readonly index?: IndexOptions | false
  /** Upper bound on sources returned by one `web_search` call. */
  readonly searchMaxResults?: number
  /** Upper bound on queries accepted by one `web_search` call. */
  readonly searchMaxQueries?: number
  /** Cap on source characters converted and complete `web_fetch` output characters. */
  readonly fetchMaxOutputChars?: number
}

/** Options for the local index. See {@link WebKitOptions.index}. */
export interface IndexOptions {
  /** Directory holding the store. Defaults to `.dsh-web-kit/index` under cwd. */
  readonly dir?: string
  /**
   * How pages are narrowed before being stored. Default `'gentle'`
   * (drop non-rendering tags and clear ad slots, keep everything else).
   */
  readonly extract?: ExtractOptions
  /**
   * Skip pages whose extracted body is shorter than this. Default `200`.
   *
   * Below here a page is usually a shell — a redirect stub, a login wall, an
   * empty SPA `<div id="root">` — and its few words compete with real documents
   * for the same BM25 slots. Set `0` to index everything, which matters for
   * short reference pages (some are genuinely answer-sized at ~170 chars).
   */
  readonly minChars?: number
  /**
   * Index responses outside 2xx. Default `false`.
   *
   * Error pages are mostly worth forgetting, but enabling this is how you index
   * a deliberately non-2xx document — a rate-limit notice you want to find
   * again, or a `204` endpoint whose body you still read.
   */
  readonly onlySuccessful?: boolean
}

/** Project {@link IndexOptions} onto what {@link CachingFetchProvider} accepts. */
function indexPassThrough(options: IndexOptions): CachingFetchProviderOptions {
  return {
    ...options.extract !== undefined ? { extract: options.extract } : {},
    ...options.minChars !== undefined ? { minChars: options.minChars } : {},
    ...options.onlySuccessful !== undefined ? { onlySuccessful: options.onlySuccessful } : {},
  }
}

/** The assembled kit. */
export interface WebKit {
  /** The runtime; call `search()` / `fetch()` directly, or use the tools. */
  readonly web: WebRuntime
  /** Framework-neutral tool definitions. */
  readonly tools: readonly ToolDefinition[]
  /** The local index, when {@link WebKitOptions.index} enabled it. */
  readonly index?: LocalIndexSearchProvider
  /** Release browser processes owned by the kit, if any. */
  readonly dispose: () => Promise<void>
}

/**
 * Assemble a runtime with the selected providers and return ready-to-register
 * tool definitions.
 */
export function createWebKit(options: WebKitOptions = {}): WebKit {
  const web = new WebRuntime()
  const owned: { dispose(): Promise<void> }[] = []

  const backend = options.search === undefined ? DEFAULT_SEARCH_BACKEND : options.search
  if (backend !== false) {
    const provider = createSearchProvider(backend, options.filter)
    owned.push(...collectDisposers(provider))
    web.registerSearchProvider(provider)
  }

  let index: LocalIndexSearchProvider | undefined
  if (options.index !== undefined && options.index !== false) {
    index = new LocalIndexSearchProvider({ dir: DEFAULT_INDEX_DIR, ...options.index })
  }

  if (options.disableFetch !== true) {
    const http = new HttpFetchProvider({ ...DEFAULT_FETCH_LIMITS, ...options.fetch ?? {} })
    const indexOptions = options.index === undefined || options.index === false ? undefined : options.index
    const provider = index === undefined || indexOptions === undefined
      ? http
      : new CachingFetchProvider(http, index.documents, indexPassThrough(indexOptions))
    web.registerFetchProvider(provider)
  }

  const tools = createWebTools({
    web,
    ...options.searchMaxResults !== undefined ? { maxResults: options.searchMaxResults } : {},
    ...options.searchMaxQueries !== undefined ? { maxQueries: options.searchMaxQueries } : {},
    ...options.fetchMaxOutputChars !== undefined ? { maxOutputChars: options.fetchMaxOutputChars } : {},
  })

  return {
    web,
    tools,
    ...index !== undefined ? { index } : {},
    dispose: async () => {
      for (const item of owned) await item.dispose().catch(() => undefined)
    },
  }
}

/**
 * Walk a provider graph collecting everything that owns a browser process.
 *
 * Composites ({@link withFallback}, {@link withFilter}) hide their children, so
 * this duck-types through `providers` and `inner` rather than depending on
 * their types.
 */
function collectDisposers(provider: WebSearchProvider): { dispose(): Promise<void> }[] {
  const candidate = provider as unknown as {
    dispose?: () => Promise<void>
    providers?: readonly WebSearchProvider[]
    inner?: WebSearchProvider
  }
  const out: { dispose(): Promise<void> }[] = []
  if (typeof candidate.dispose === 'function') out.push({ dispose: candidate.dispose.bind(provider) })
  for (const child of candidate.providers ?? []) out.push(...collectDisposers(child))
  if (candidate.inner !== undefined) out.push(...collectDisposers(candidate.inner))
  return out
}

function createSearchProvider(backend: SearchBackend, filter: ResultFilterOptions | false | undefined): WebSearchProvider {
  const provider = buildSearchProvider(backend)
  if (filter === false || backend.kind === 'custom' || backend.kind === 'local-index') return provider
  return withFilter(provider, filter ?? {})
}

function buildSearchProvider(backend: SearchBackend): WebSearchProvider {
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
    case 'browser':
      return new BrowserSearchProvider(backend.options ?? {})
    case 'browser-first':
      return withFallback(
        new BrowserSearchProvider({ engine: 'bing', ...backend.options ?? {} }),
        new BingHtmlSearchProvider(),
      )
    case 'http-first':
      return withFallback(
        new BingHtmlSearchProvider(),
        // Bing, not Baidu: sampled five queries against both, Baidu returned a
        // recommendation slot as the top hit three times. Baidu is still one
        // `engine` option away if you want it.
        new BrowserSearchProvider({ engine: 'bing', ...backend.options ?? {} }),
      )
    case 'local-index':
      return new LocalIndexSearchProvider(backend.options ?? {})
    case 'custom':
      return backend.provider
    /* v8 ignore next 2 -- SearchBackend is a closed union; unreachable, and only makes a new kind a compile error. */
    default:
      throw new Error(`unsupported search backend: ${JSON.stringify(backend)}`)
  }
}
