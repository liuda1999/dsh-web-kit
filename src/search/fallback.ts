/**
 * `withFallback(...)`: compose several search providers into one that tries
 * them in order.
 *
 * Every zero-credential backend in this package is a scraper, and every
 * scraper fails eventually — a markup change, an IP throttle, a captcha. A
 * single backend means one failure takes the agent's web access down entirely.
 * This turns that into a chain: use the good one, fall back to the cheap one.
 *
 * A provider is treated as failed when it throws **or** when it returns zero
 * sources, because "zero results" is exactly how a silent scraping break
 * presents itself. Distinguishing "the internet has nothing" from "my parser
 * is broken" is not possible at this layer, so the pessimistic reading wins.
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/search/fallback
 */

import { WebError } from '../types.js'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '../types.js'

/** One attempt, recorded so a total failure can explain itself. */
interface Attempt {
  readonly id: string
  readonly outcome: 'empty' | 'error'
  readonly error?: unknown
}

/**
 * Wrap providers in priority order. The returned provider reports the id of
 * the first provider in the chain so registration stays stable.
 */
export function withFallback(...providers: readonly WebSearchProvider[]): WebSearchProvider {
  if (providers.length === 0) {
    throw new WebError('withFallback requires at least one provider', 'WEB_PROVIDER_ERROR')
  }

  // Declared with a wider type so the chain exposes its children: kit disposal
  // walks the graph to close browser processes the chain owns.
  const composite: WebSearchProvider & {
    readonly providers: readonly WebSearchProvider[]
    readonly dispose: () => Promise<void>
  } = {
    id: providers[0]?.id ?? 'fallback',
    providers,
    dispose: async () => {
      for (const provider of providers) {
        const disposable = provider as unknown as { dispose?: () => Promise<void> }
        if (typeof disposable.dispose === 'function') {
          await disposable.dispose().catch(() => undefined)
        }
      }
    },
    available(): boolean {
      return providers.some(provider => provider.available())
    },
    async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
      const attempts: Attempt[] = []

      for (const provider of providers) {
        if (!provider.available()) {
          attempts.push({ id: provider.id, outcome: 'error', error: new Error('unavailable') })
          continue
        }
        try {
          const result = await provider.search(request, signal)
          if (result.sources.length > 0) return { ...result, truncated: result.truncated }
          attempts.push({ id: provider.id, outcome: 'empty' })
        } catch (error: unknown) {
          // A cancellation is a decision by the caller, not a backend failure.
          if (signal?.aborted) throw error
          attempts.push({ id: provider.id, outcome: 'error', error })
        }
      }

      throw new WebError(describeFailure(attempts), 'WEB_PROVIDER_ERROR', {
        cause: attempts.find(attempt => attempt.error !== undefined)?.error,
      })
    },
  }
  return composite
}

/** Build the error message for a chain where nothing worked. */
function describeFailure(attempts: readonly Attempt[]): string {
  const parts = attempts.map(attempt => {
    if (attempt.outcome === 'empty') return `${attempt.id}: 0 results`
    const error = attempt.error
    const message = error instanceof Error ? error.message : String(error)
    return `${attempt.id}: ${message}`
  })
  return `all search providers failed (${parts.join('; ')})`
}

/** Merge sources from several providers, de-duplicating by URL. */
export function mergeSources(...groups: readonly (readonly WebSearchSource[])[]): WebSearchSource[] {
  const seen = new Set<string>()
  const merged: WebSearchSource[] = []
  for (const group of groups) {
    for (const source of group) {
      if (seen.has(source.url)) continue
      seen.add(source.url)
      merged.push(source)
    }
  }
  return merged
}
