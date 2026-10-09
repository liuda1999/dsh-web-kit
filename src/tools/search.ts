/**
 * `web_search` business logic: argument validation, multi-query merging, and
 * model-visible formatting.
 *
 * Extracted from DeepSeek Harness `packages/web/tool-web/src/search.ts` (MIT).
 * The Cordis tool registration was removed; what remains is the schema, the
 * validation, the merge, and the exact output prose.
 *
 * @module dsh-web-kit/tools/search
 */

import type { WebSearchResult, WebSearchSource } from '../types.js'
import type { WebRuntime } from '../runtime.js'
import { EXTERNAL_WEB_CONTENT_NOTICE } from './trust.js'

/** Default upper bound on sources returned by one `web_search` call. */
export const WEB_SEARCH_MAX_RESULTS = 8

/** Default upper bound on queries accepted by one `web_search` call. */
export const WEB_SEARCH_MAX_QUERIES = 4

/** Arguments accepted by `web_search`. */
export interface WebSearchArgs {
  readonly queries: readonly string[]
}

/** Structured summary attached to a result for UI replay (never model-visible). */
export interface WebSearchMeta {
  /** The faithful structured sources, in result order. */
  readonly sources: WebSearchSource[]
  /** True when the seam or multi-query merge cut the source list. */
  readonly truncated: boolean
  /** The provider-generated answer text, when any. */
  readonly answer?: string
}

/** Validate and normalize `web_search` arguments. */
export function parseSearchArgs(args: WebSearchArgs, maxQueries: number): string[] {
  const queries = args.queries
  if (queries.length === 0) throw new Error('queries must contain at least one query')
  if (queries.length > maxQueries) {
    const noun = maxQueries === 1 ? 'query' : 'queries'
    throw new Error(`queries must contain at most ${maxQueries} ${noun}`)
  }
  if (queries.some(query => query.trim().length === 0)) throw new Error('each query must be a non-empty string')
  return [...new Set(queries)]
}

/** Display label for a source: its title, else its hostname. */
function sourceLabel(url: string, title: string | undefined): string {
  if (title !== undefined && title.length > 0) return title
  try {
    return new URL(url).hostname
  } catch {
    // A provider should return a valid URL, but never let a malformed one throw
    // out of pure formatting — fall back to the raw string.
    return url
  }
}

/** Render one search result as the model-visible text block. */
export function formatSearchOutput(result: WebSearchResult): string {
  const parts: string[] = [EXTERNAL_WEB_CONTENT_NOTICE]
  if (result.content !== undefined && result.content.length > 0) parts.push(result.content)

  if (result.sources.length > 0) {
    const lines = result.sources.map((source) => {
      const label = sourceLabel(source.url, source.title)
      const meta: string[] = []
      if (source.snippet !== undefined && source.snippet.length > 0) meta.push(source.snippet)
      if (source.publishedAt !== undefined && source.publishedAt.length > 0) meta.push(`(${source.publishedAt})`)
      const suffix = meta.length > 0 ? ` — ${meta.join(' ')}` : ''
      return `- [${label}](${source.url})${suffix}`
    })
    parts.push(`Sources:\n${lines.join('\n')}`)
  } else if (result.content === undefined || result.content.length === 0) {
    parts.push('No results found.')
  }

  if (result.truncated) parts.push(`(Showing the first ${result.sources.length} sources. Refine the query for more.)`)
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

/** Project one source into the shape returned to the model. */
export function projectSource(source: WebSearchSource): {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
} {
  return {
    url: source.url,
    ...source.title !== undefined ? { title: source.title } : {},
    ...source.snippet !== undefined ? { snippet: source.snippet } : {},
    ...source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {},
  }
}

/** Build the UI-replay meta from a result value. */
export function searchMetaFromValue(value: WebSearchResult): WebSearchMeta {
  return {
    sources: value.sources.map(projectSource),
    truncated: value.truncated,
    ...value.content !== undefined ? { answer: value.content } : {},
  }
}

/** Whether an unknown value is a well-formed {@link WebSearchMeta}. */
export function searchMetaFromResult(meta: unknown): WebSearchMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { sources, truncated, answer } = meta as Record<string, unknown>
  if (!Array.isArray(sources) || !sources.every(isWebSource)) return undefined
  if (typeof truncated !== 'boolean') return undefined
  if (answer !== undefined && typeof answer !== 'string') return undefined
  return {
    sources,
    truncated,
    ...answer !== undefined ? { answer } : {},
  }
}

function isWebSource(value: unknown): value is WebSearchSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { url, title, snippet, publishedAt } = value as Record<string, unknown>
  return typeof url === 'string'
    && (title === undefined || typeof title === 'string')
    && (snippet === undefined || typeof snippet === 'string')
    && (publishedAt === undefined || typeof publishedAt === 'string')
}

/**
 * Merge per-query results by interleaving on rank, so the first source of each
 * query precedes the second source of any query. De-duplicates by URL.
 */
export function mergeSearchResults(
  queries: readonly string[],
  results: readonly WebSearchResult[],
  maxResults: number,
): WebSearchResult {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  let sourceRanks = 0
  for (const result of results) {
    sourceRanks = Math.max(sourceRanks, result.sources.length)
  }
  let droppedSource = false
  merge: for (let rank = 0; rank < sourceRanks; rank++) {
    for (const result of results) {
      const source = result.sources[rank]
      if (source !== undefined && !seen.has(source.url)) {
        seen.add(source.url)
        if (sources.length === maxResults) {
          droppedSource = true
          break merge
        }
        sources.push(source)
      }
    }
  }
  const contents = results.flatMap((result, index) => {
    if (result.content === undefined || result.content.length === 0) return []
    const query = queries[index]
    return [`### ${query ?? ''}\n\n${result.content}`]
  })
  return {
    ...contents.length > 0 ? { content: contents.join('\n\n') } : {},
    sources,
    truncated: results.some(result => result.truncated) || droppedSource,
  }
}

/**
 * Run every query through the runtime, then merge. The first failing query
 * aborts the rest and is rethrown.
 */
export async function runSearchQueries(
  web: WebRuntime,
  queries: readonly string[],
  maxResults: number,
  signal?: AbortSignal,
): Promise<WebSearchResult> {
  const controller = new AbortController()
  const forward = () => { controller.abort(signal?.reason) }
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', forward, { once: true })
  }
  try {
    const settled = await Promise.allSettled(
      queries.map(query => web.search({ query, maxResults }, controller.signal)),
    )
    const results: WebSearchResult[] = []
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        controller.abort(outcome.reason)
        throw outcome.reason
      }
      results.push(outcome.value)
    }
    const [first] = results
    if (first === undefined) throw new Error('web_search produced no result')
    return results.length === 1 ? first : mergeSearchResults(queries, results, maxResults)
  } finally {
    signal?.removeEventListener('abort', forward)
  }
}
