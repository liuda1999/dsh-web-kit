/**
 * A fetch provider that renders the page in a real browser before reading it.
 *
 * The HTTP provider only ever sees what the server sends. Pages that build
 * their tables from XHR responses — market grids, data consoles, ranking
 * boards — arrive as an empty shell with the numbers missing entirely. This
 * provider drives a browser to the same URL and hands back the rendered DOM,
 * so those tables exist by the time extraction runs.
 *
 * It is not a general replacement: rendering costs seconds and a browser
 * process where the HTTP path costs milliseconds and nothing. Use it as the
 * second rung of a ladder, not the default.
 *
 * @module dsh-web-kit/browser/fetch-provider
 */

import { WebError } from '../types.js'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '../types.js'
import { validateFetchUrl } from '../fetch/policy.js'
import { resolvePublicAddresses } from '../fetch/network.js'
import { deadline, timeoutOf } from '../timeout.js'
import { cleanPageHtml, type ExtractOptions } from '../filter/extract.js'
import { contentSignals } from '../fetch/render-fallback.js'
import type { BrowserPage, BrowserPool, BrowserPoolOptions } from './pool.js'
import { BrowserPool as Pool } from './pool.js'

/** Provider id registered on the runtime when no explicit id is given. */
export const BROWSER_FETCH_PROVIDER_ID = 'browser-fetch'

/**
 * Cap on rendered-DOM characters. Rendered DOM is routinely larger than the
 * source document — scripts that only add nodes — so this starts higher than
 * the HTTP provider's body cap.
 */
export const DEFAULT_BROWSER_BODY_CHARS = 1_000_000

/**
 * Extra time allowed for a table to receive its data, in milliseconds.
 * Defaults to 3000.
 *
 * Measured on `www.cngold.org/xhhj/`: with a fixed 1,500 ms settle the grid
 * came back with **8 of 40** placeholder cells filled — the render ran, was
 * correctly judged the better body, and still handed the model a table of `--`.
 * The XHR that fills those cells simply had not landed. Rather than raise the
 * settle for every page, this waits only when the DOM still shows an unfilled
 * table, and returns as soon as it stops changing.
 */
export const DEFAULT_FILL_WAIT_MS = 3_000

/** Interval between fill checks, in milliseconds. */
export const FILL_POLL_MS = 700

/** Options for {@link BrowserFetchProvider}. */
export interface BrowserFetchProviderOptions extends BrowserPoolOptions {
  /** Reuse a browser pool instead of owning one. */
  readonly pool?: BrowserPool
  /** Override the registered provider id. */
  readonly id?: string
  /** Whole-operation timeout. Defaults to 45 s. */
  readonly timeoutMs?: number
  /** Per-navigation timeout. Defaults to 30 s. */
  readonly navigationTimeoutMs?: number
  /**
   * Quiet period after navigation, in milliseconds, so late XHR tables land.
   * Defaults to 1500. Set to `0` to skip.
   */
  readonly settleMs?: number
  /**
   * Extra budget for a grid that has not been filled yet, in milliseconds.
   * Defaults to {@link DEFAULT_FILL_WAIT_MS}; `0` reads the DOM immediately
   * after the settle.
   *
   * A page whose tables are already populated pays nothing: the check is one
   * pass over the DOM and it stops there. Only a page still showing an
   * unfilled table waits, in {@link FILL_POLL_MS} steps, and it stops early
   * both when the data lands and when the DOM stops changing — a grid that
   * never fills costs one extra poll, not the whole budget.
   */
  readonly fillWaitMs?: number
  /** Playwright `waitUntil` for navigation. Defaults to `'domcontentloaded'`. */
  readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'
  /**
   * Optional selector to wait for before reading the DOM, e.g. `'table tbody tr'`.
   * Absent longer than the navigation timeout is not fatal — the DOM is read
   * anyway so a page that never renders it still returns something.
   */
  readonly waitForSelector?: string
  /** Cap on rendered-DOM characters. Defaults to {@link DEFAULT_BROWSER_BODY_CHARS}. */
  readonly maxBodyChars?: number
  /**
   * Strip non-rendering tags from the rendered DOM before returning it.
   * Defaults to `true`.
   *
   * This is not cosmetic. A rendered DOM carries every inline `<script>` and
   * `<style>` the source had plus whatever hydration added — measured on
   * douyin.com/hot, 799,426 characters of rendered DOM reduced to 13,702 once
   * cleaned. Rendered pages are also far more likely to push their real content
   * past the tool's conversion window, so cleaning decides what the model sees.
   * Pass `false` for the raw DOM, or an {@link ExtractOptions} object to tune it.
   */
  readonly clean?: boolean | ExtractOptions
}

/**
 * Fetch one URL through a real browser and return the rendered DOM.
 *
 * The target is validated against the same public-address policy as the HTTP
 * provider *before* the browser is launched, and the URL the browser actually
 * ends up on is validated again after navigation: scripted redirects can move
 * a page anywhere, and the browser performs its own DNS.
 */
export class BrowserFetchProvider implements WebFetchProvider {
  readonly id: string
  private readonly options: BrowserFetchProviderOptions
  private readonly ownsPool: boolean
  private readonly pool: BrowserPool

  constructor(options: BrowserFetchProviderOptions = {}) {
    this.id = options.id ?? BROWSER_FETCH_PROVIDER_ID
    this.options = options
    this.ownsPool = options.pool === undefined
    // The pool is shared with search; this one renders fetched pages, so a
    // missing Playwright has to say so in fetch terms.
    this.pool = options.pool ?? new Pool({ ...options, purpose: options.purpose ?? 'fetch' })
  }

  /**
   * Playwright is an optional dependency resolved lazily, so this cannot prove
   * a browser will launch without doing I/O. It reports the provider as
   * selectable and lets `fetch()` raise the actionable error.
   */
  available(): boolean {
    return true
  }

  /** The pool this provider drives; shared when one was passed in. */
  get browserPool(): BrowserPool {
    return this.pool
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    const url = validateFetchUrl(request.url)

    const d = deadline(signal, this.options.timeoutMs ?? 45_000, 'WEB_FETCH_TIMEOUT')
    try {
      // Validate before launching: the browser resolves the name itself, so a
      // hostname that fails here is refused rather than silently dialled.
      await resolvePublicAddresses(url.hostname, d.signal)

      return await this.pool.withPage(async page => {
        const response = await page.goto(url.toString(), {
          waitUntil: this.options.waitUntil ?? 'domcontentloaded',
          ...this.options.navigationTimeoutMs !== undefined
            ? { timeout: this.options.navigationTimeoutMs }
            : { timeout: 30_000 },
        })
        const statusCode = response?.status() ?? 0

        const finalUrl = await this.validatedFinalUrl(page, d.signal)

        if (this.options.waitForSelector !== undefined) {
          await this.waitForSelector(page, this.options.waitForSelector)
        }
        const settle = this.options.settleMs ?? 1500
        if (settle > 0) await page.waitForTimeout(settle)

        const html = await this.awaitFilledTables(page)
        const cleaned = this.options.clean === false
          ? html
          : cleanPageHtml(html, this.options.clean === true || this.options.clean === undefined ? {} : this.options.clean)
        const cap = this.options.maxBodyChars ?? DEFAULT_BROWSER_BODY_CHARS
        const content = cleaned.length > cap ? cleaned.slice(0, cap) : cleaned

        return {
          url: finalUrl,
          statusCode,
          body: { kind: 'html' as const, content },
          truncated: cleaned.length > cap,
        }
      })
    } catch (error: unknown) {
      throw translateFetchError(error, d.signal)
    } finally {
      d.dispose()
    }
  }

  /**
   * Re-validate where the browser actually ended up. Scripted navigation is a
   * redirect the HTTP provider would have refused, so it gets the same check.
   */
  private async validatedFinalUrl(page: BrowserPage, signal: AbortSignal): Promise<string> {
    const raw = page.url()
    if (raw.length === 0) return raw
    try {
      const reached = new URL(raw)
      if (reached.protocol !== 'http:' && reached.protocol !== 'https:') {
        throw new WebError(
          `browser navigated to an unsupported scheme "${reached.protocol}"`,
          'WEB_REDIRECT_BLOCKED',
        )
      }
      await resolvePublicAddresses(reached.hostname, signal)
      return reached.toString()
    } catch (error: unknown) {
      if (error instanceof WebError) throw error
      throw new WebError(`browser navigated to an unvalidated URL: ${raw}`, 'WEB_REDIRECT_BLOCKED', {
        cause: error,
      })
    }
  }

  /**
   * Read the DOM, then keep waiting while it still shows an unfilled table.
   *
   * The settle delay is a guess about XHR latency and 1,500 ms is not always
   * enough; this replaces the guess with the thing actually being waited for.
   * Two exits keep it cheap: the table fills, or the DOM stops changing — a
   * grid that is going to stay empty should not cost the whole budget.
   */
  private async awaitFilledTables(page: BrowserPage): Promise<string> {
    const budget = this.options.fillWaitMs ?? DEFAULT_FILL_WAIT_MS
    const html = await page.content()
    if (budget <= 0) return html
    if (contentSignals(html).unfilledTableCount === 0) return html

    const until = Date.now() + budget
    let current = html
    while (Date.now() < until) {
      await page.waitForTimeout(FILL_POLL_MS)
      const next = await page.content()
      if (next === current) break
      current = next
      if (contentSignals(current).unfilledTableCount === 0) break
    }
    return current
  }

  /**
   * Wait for a selector when the page exposes it. Pages without it (or pools
   * whose page type predates it) fall through to the settle delay instead.
   */
  private async waitForSelector(page: BrowserPage, selector: string): Promise<void> {
    const waiter = (page as { waitForSelector?: (s: string, o?: { timeout?: number }) => Promise<unknown> })
      .waitForSelector
    if (typeof waiter !== 'function') return
    try {
      await waiter.call(page, selector, { timeout: this.options.navigationTimeoutMs ?? 30_000 })
    } catch {
      // Not fatal: read the DOM as it stands.
    }
  }

  /** Close the pool, when this provider created it. */
  async dispose(): Promise<void> {
    if (this.ownsPool) await this.pool.close().catch(() => undefined)
  }
}

/** Classify a thrown value as cancellation, timeout, or provider failure. */
function translateFetchError(error: unknown, signal: AbortSignal): WebError {
  if (error instanceof WebError) return error
  if (timeoutOf(signal, 'WEB_FETCH_TIMEOUT') !== undefined) {
    return new WebError('browser web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: error })
  }
  if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`browser web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}
