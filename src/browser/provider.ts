/**
 * `BrowserSearchProvider`: a `WebSearchProvider` that drives a real browser.
 *
 * This exists because plain HTTP scraping is not enough. Measured during
 * development, from a mainland-China network:
 *
 * | Engine | plain HTTP | real browser |
 * |---|---|---|
 * | Bing `cn.bing.com` | 9-10 rows, usable | 10/10 rows, usable |
 * | Baidu `www.baidu.com` | 4 rows, all redirect wrappers | 8-11 rows, real URLs |
 * | Sogou | 302 to `/antispider` | still `/antispider` |
 * | 360 `www.so.com` | blocked after ~5 queries | blocked (`qcaptcha`) |
 *
 * So the browser buys Baidu, which HTTP cannot use at all, and it is the only
 * reason Baidu is worth shipping. Sogou and 360 stay blocked either way — they
 * are not implemented rather than shipped broken.
 *
 * Cost: a browser launch is slow (hundreds of ms to seconds) and each query
 * navigates a real page. This is the price of not paying for an API.
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/browser/provider
 */

import { readSearchQuery, WebError } from '../types.js'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '../types.js'
import { describeFilter, filterSources, survived, type ResultFilterOptions } from '../filter/result-filter.js'
import { deadline, timeoutOf } from '../timeout.js'
import { BrowserPool, type BrowserPage, type BrowserPoolOptions } from './pool.js'
import { type BrowserEngine, browserEngine } from './engines.js'

/** Resolved provider options. */
export interface BrowserSearchProviderOptions extends BrowserPoolOptions {
  /** Engine id (`'bing'` / `'baidu'`) or a custom adapter. Defaults to `'bing'`. */
  readonly engine?: string | BrowserEngine
  /** Override the registered provider id. Defaults to `browser:<engine>`. */
  readonly id?: string
  /** Visit the engine home page first so cookies look organic. Defaults to `true`. */
  readonly warmUp?: boolean
  /** Milliseconds to let the results page settle after load. Defaults to `2000`. */
  readonly settleMs?: number
  /** Per-search timeout in milliseconds. Defaults to `60000`. */
  readonly timeoutMs?: number
  /** Drop ads, redirect wrappers, duplicates and self-links. Defaults to on. */
  readonly filter?: ResultFilterOptions | false
  /** Reuse an externally owned pool instead of creating one. */
  readonly pool?: BrowserPool
}

/** Id prefix every browser provider registers under. */
export const BROWSER_PROVIDER_PREFIX = 'browser'

/**
 * Resolve the engine option to a concrete adapter.
 */
function resolveEngine(engine: string | BrowserEngine | undefined): BrowserEngine {
  if (engine === undefined) return browserEngine('bing')
  return typeof engine === 'string' ? browserEngine(engine) : engine
}

/**
 * A search provider that renders the results page in a real browser, then
 * scrapes it there.
 */
export class BrowserSearchProvider implements WebSearchProvider {
  readonly id: string
  private readonly engine: BrowserEngine
  private readonly options: BrowserSearchProviderOptions
  private readonly ownsPool: boolean
  private readonly pool: BrowserPool

  constructor(options: BrowserSearchProviderOptions = {}) {
    this.engine = resolveEngine(options.engine)
    this.id = options.id ?? `${BROWSER_PROVIDER_PREFIX}:${this.engine.id}`
    this.options = options
    this.ownsPool = options.pool === undefined
    this.pool = options.pool ?? new BrowserPool(options)
  }

  /**
   * Cheap local check. Playwright is an optional dependency resolved lazily, so
   * this cannot prove a browser will launch without doing I/O; it reports the
   * provider as selectable and lets `search()` produce the actionable error.
   */
  available(): boolean {
    return true
  }

  /** The engine this provider drives. */
  get engineId(): string {
    return this.engine.id
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (signal?.aborted) throw new WebError('web search aborted', 'WEB_ABORTED')
    const query = readSearchQuery(request)

    const d = deadline(signal, this.options.timeoutMs ?? 60_000, 'WEB_SEARCH_TIMEOUT')
    try {
      const rows = await this.withBrowser(d.signal, query)
      const filter = this.options.filter === false ? undefined : this.options.filter ?? {}
      const outcome = filterSources(
        rows.map(row => ({ url: row.url, title: row.title, snippet: row.snippet, sponsored: row.sponsored })),
        filter,
      )
      // Relegated rows survive; they go behind the clean ones rather than away.
      const sources: WebSearchSource[] = survived(outcome).map(row => ({
        url: row.url,
        ...row.title !== undefined ? { title: row.title } : {},
        ...row.snippet !== undefined ? { snippet: row.snippet } : {},
      }))
      if (sources.length === 0) {
        throw new WebError(
          `browser search on "${this.engine.id}" produced no usable results ` +
            '(markup changed, a challenge page, or everything was filtered as an ad/self-link)',
          'WEB_PROVIDER_ERROR',
        )
      }
      const summary = describeFilter(outcome)
      return { sources, truncated: false, ...summary.length > 0 ? { content: summary } : {} }
    } catch (error: unknown) {
      throw translateBrowserError(error, d.signal, this.engine.id)
    } finally {
      d.dispose()
    }
  }

  /** Run one search in an isolated browser context. */
  private async withBrowser(signal: AbortSignal, query: string): Promise<
    { url: string; title: string; snippet: string; sponsored: boolean }[]
  > {
    const settle = this.options.settleMs ?? 2000
    const navigationTimeout = this.options.navigationTimeoutMs ?? 30_000
    let lastError: unknown

    // One attempt, retried once: the first navigation after a cold browser
    // launch intermittently loses the race with page hydration.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw new WebError('web search aborted', 'WEB_ABORTED')
      try {
        return await this.pool.withPage(async (page: BrowserPage) => {
          if (this.options.warmUp !== false) {
            await raceAbort(
              page.goto(this.engine.homeUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeout }),
              signal,
            )
            await raceAbort(page.waitForTimeout(800), signal)
          }
          const response = await raceAbort(
            page.goto(this.engine.buildUrl(query), { waitUntil: 'domcontentloaded', timeout: navigationTimeout }),
            signal,
          )
          await raceAbort(page.waitForTimeout(settle), signal)
          const status = response?.status() ?? 0
          if (status >= 400) {
            throw new WebError(
              `${this.engine.id} returned HTTP ${status}`,
              'WEB_PROVIDER_ERROR',
            )
          }
          const extract = this.engine.extract
          return await raceAbort(page.evaluate(extract), signal)
        })
      } catch (error: unknown) {
        lastError = error
        if (signal.aborted) throw new WebError('web search aborted', 'WEB_ABORTED')
        if (error instanceof WebError && error.code === 'WEB_PROVIDER_ERROR') {
          // A real HTTP error is a real answer; do not retry it.
          throw error
        }
        await sleep(500)
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new WebError(`browser search failed: ${String(lastError)}`, 'WEB_PROVIDER_ERROR')
  }

  /** Close the browser. Only closes a pool this provider created. */
  async dispose(): Promise<void> {
    if (this.ownsPool) await this.pool.close()
  }
}

/** Reject with `WEB_ABORTED` if `signal` fires before `promise` settles. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new WebError('web search aborted', 'WEB_ABORTED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new WebError('web search aborted', 'WEB_ABORTED'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Classify a thrown value as cancellation, timeout, or provider failure. */
export function translateBrowserError(error: unknown, signal: AbortSignal, engineId: string): WebError {
  if (error instanceof WebError) return error
  if (timeoutOf(signal, 'WEB_SEARCH_TIMEOUT') !== undefined) {
    return new WebError('browser web search timed out', 'WEB_SEARCH_TIMEOUT', { cause: error })
  }
  if (signal.aborted) return new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`browser web search failed on "${engineId}": ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

/** Sleep helper that cannot throw. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
