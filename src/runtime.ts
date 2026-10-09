/**
 * The web access runtime: registries and provider-selecting execution for
 * search and fetch.
 *
 * Extracted from DeepSeek Harness `packages/web/web/src/index.ts` (MIT).
 * Cordis was removed: upstream this is a `Service` whose registrations are
 * reversible effects bound to a plugin fiber. Here registration returns a
 * disposer the caller owns, and selection semantics are unchanged.
 *
 * Selection is resolved at execution time and is never order-dependent:
 * - A configured id that is registered and `available()` wins.
 * - A configured id not registered → `WEB_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable → `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one usable provider → that provider.
 * - No id configured, multiple usable → `WEB_PROVIDER_AMBIGUOUS`.
 * - No id configured, none usable → `WEB_PROVIDER_UNAVAILABLE`.
 *
 * @module dsh-web-kit/runtime
 */

import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from './types.js'
import { WebError } from './types.js'

/** Selection inputs for execution-time provider resolution. */
interface Selection<P> {
  readonly configuredId?: string
  readonly providers: ReadonlyMap<string, P>
}

/** Runtime options. Both ids are optional; a single usable provider auto-selects. */
export interface WebRuntimeOptions {
  /** Explicit search provider id. Omitted = auto-select when exactly one usable. */
  readonly searchProvider?: string
  /** Explicit fetch provider id. Omitted = auto-select when exactly one usable. */
  readonly fetchProvider?: string
}

/** The web access runtime. */
export class WebRuntime {
  private readonly searchProviders = new Map<string, WebSearchProvider>()
  private readonly fetchProviders = new Map<string, WebFetchProvider>()
  private readonly searchProviderId: string | undefined
  private readonly fetchProviderId: string | undefined

  constructor(options: WebRuntimeOptions = {}) {
    this.searchProviderId = options.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER
    this.fetchProviderId = options.fetchProvider ?? process.env.DSH_WEB_FETCH_PROVIDER
  }

  /**
   * Register a search provider. Throws `WEB_DUPLICATE_PROVIDER` when its id is
   * already registered for search.
   * @returns a disposer that unregisters the provider.
   */
  registerSearchProvider(provider: WebSearchProvider): () => void {
    return this.registerProvider(this.searchProviders, provider)
  }

  /**
   * Register a fetch provider. Throws `WEB_DUPLICATE_PROVIDER` when its id is
   * already registered for fetch.
   * @returns a disposer that unregisters the provider.
   */
  registerFetchProvider(provider: WebFetchProvider): () => void {
    return this.registerProvider(this.fetchProviders, provider)
  }

  /** The registered search provider ids. */
  listSearchProviders(): string[] {
    return [...this.searchProviders.keys()]
  }

  /** The registered fetch provider ids. */
  listFetchProviders(): string[] {
    return [...this.fetchProviders.keys()]
  }

  private registerProvider<P extends { readonly id: string }>(store: Map<string, P>, provider: P): () => void {
    if (store.has(provider.id)) {
      throw new WebError(`a web provider with id "${provider.id}" is already registered`, 'WEB_DUPLICATE_PROVIDER')
    }
    store.set(provider.id, provider)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      store.delete(provider.id)
    }
  }

  /**
   * Run one search through the selected provider. The runtime enforces
   * `request.maxResults` on the result: if the provider over-returns,
   * `sources[]` is truncated and `truncated` set.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const provider = resolveProvider({
      providers: this.searchProviders,
      ...this.searchProviderId !== undefined ? { configuredId: this.searchProviderId } : {},
    })
    const result = await provider.search(request, signal)
    return capSources(result, request.maxResults)
  }

  /**
   * Retrieve one URL through the selected provider. A non-2xx response is a
   * result, not a throw.
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const provider = resolveProvider({
      providers: this.fetchProviders,
      ...this.fetchProviderId !== undefined ? { configuredId: this.fetchProviderId } : {},
    })
    return provider.fetch(request, signal)
  }
}

interface ResolvableProvider {
  readonly id: string
  available(): boolean
}

/** Resolve the selected provider or throw the matching {@link WebError}. */
function resolveProvider<P extends ResolvableProvider>(selection: Selection<P>): P {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new WebError(`configured web provider "${configuredId}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new WebError(`configured web provider "${configuredId}" is registered but unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new WebError('no usable web provider is registered', 'WEB_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new WebError(`multiple usable web providers are registered (${ids}); configure one explicitly`, 'WEB_PROVIDER_AMBIGUOUS')
  }
  return single
}

/** Enforce `maxResults` on a search result: truncate `sources[]` and flag it. */
function capSources(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}
