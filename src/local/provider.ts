/**
 * `LocalIndexSearchProvider`: search the pages you have already fetched.
 *
 * This is the "index" half of the kit. Every page pulled through
 * {@link CachingFetchProvider} is stored, and this provider searches that store
 * offline with BM25. Nothing leaves the machine and nothing is paid for.
 *
 * It is a complement to live search, not a replacement: it only knows pages you
 * fetched. Used together — live search to discover, fetch to read, this to find
 * it again — you get a personal index that grows as you work.
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/local/provider
 */

import { readSearchQuery, WebError } from '../types.js'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '../types.js'
import { bm25, excerpt, indexDoc, tokenize, type Bm25Options } from './bm25.js'
import { DocStore, type StoredDoc } from './store.js'

/** Stable id this provider registers under. */
export const LOCAL_INDEX_PROVIDER_ID = 'local-index'

/** Options for {@link LocalIndexSearchProvider}. */
export interface LocalIndexSearchProviderOptions {
  /** Directory holding the store. Defaults to `.dsh-web-kit/index` under cwd. */
  readonly dir?: string
  /** An externally owned store. Wins over `dir`. */
  readonly store?: DocStore
  /** BM25 tuning and result cap. */
  readonly bm25?: Bm25Options
  /** Drop hits scoring below this. Default `0`, which still drops zero-scoring docs. */
  readonly minScore?: number
  /** Attach an excerpt of the matching text as the snippet. Default `true`. */
  readonly snippets?: boolean
}

/** Default store location, relative to the process working directory. */
export const DEFAULT_INDEX_DIR = '.dsh-web-kit/index'

/**
 * A search provider over the local document store.
 */
export class LocalIndexSearchProvider implements WebSearchProvider {
  readonly id = LOCAL_INDEX_PROVIDER_ID
  private readonly store: DocStore
  private readonly options: LocalIndexSearchProviderOptions

  constructor(options: LocalIndexSearchProviderOptions = {}) {
    this.store = options.store ?? new DocStore(options.dir ?? DEFAULT_INDEX_DIR)
    this.options = options
  }

  /** The store behind this provider, so callers can add or inspect documents. */
  get documents(): DocStore {
    return this.store
  }

  /** Cheap local check: the directory is creatable on demand, so always true. */
  available(): boolean {
    return true
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (signal?.aborted) throw new WebError('local index search aborted', 'WEB_ABORTED')
    const query = readSearchQuery(request, 'local index search')

    const docs = await this.store.all()
    if (docs.length === 0) {
      return {
        sources: [],
        truncated: false,
        content: 'The local index is empty: no page has been fetched yet.',
      }
    }

    const queryTokens = tokenize(query)
    const indexed = docs.map(doc => indexDoc(doc.id, tokenize(`${doc.title} ${doc.text}`)))
    const hits = bm25(indexed, queryTokens, {
      limit: request.maxResults ?? this.options.bm25?.limit ?? 10,
      ...this.options.bm25 ?? {},
    })

    const byId = new Map<string, StoredDoc>(docs.map(doc => [doc.id, doc]))
    const minScore = this.options.minScore ?? 0
    const sources: WebSearchSource[] = []
    for (const hit of hits) {
      if (hit.score < minScore) continue
      const doc = byId.get(hit.id)
      if (doc === undefined) continue
      sources.push({
        url: doc.url,
        ...doc.title.length > 0 ? { title: doc.title } : {},
        ...this.options.snippets !== false
          ? { snippet: excerpt(doc.text, queryTokens) }
          : {},
      })
    }

    return { sources, truncated: sources.length < hits.length }
  }
}
