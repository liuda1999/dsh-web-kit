/**
 * Browser automation pool.
 *
 * Search engines that defeat plain HTTP scraping (Baidu renders results with
 * JavaScript and wraps every outbound link in a redirect interstitial; Sogou
 * and 360 serve anti-bot pages) are reachable from a real browser, because a
 * real browser is what the page was written for.
 *
 * `playwright` is an *optional* dependency: it is imported lazily, and every
 * entry point degrades to a typed `WEB_PROVIDER_UNAVAILABLE` error when it is
 * not installed. The types here are structural so that consumers without
 * Playwright never see a `playwright` type in our emitted `.d.ts`.
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/browser/pool
 */

import { WebError } from '../types.js'

/** Structural view of the pieces of a Playwright page this module uses. */
export interface BrowserPage {
  goto(url: string, options?: { readonly waitUntil?: string; readonly timeout?: number; readonly referer?: string }): Promise<{ status(): number } | null>
  url(): string
  content(): Promise<string>
  waitForTimeout(ms: number): Promise<void>
  evaluate<R>(fn: () => R): Promise<R>
  close(): Promise<void>
}

/** Structural view of a Playwright browser context. */
export interface BrowserContext {
  newPage(): Promise<BrowserPage>
  addInitScript(script: () => void): Promise<void>
  close(): Promise<void>
}

/** Structural view of a Playwright browser. */
export interface BrowserHandle {
  newContext(options?: Record<string, unknown>): Promise<BrowserContext>
  close(): Promise<void>
  isConnected(): boolean
}

/** Structural view of the `playwright` module surface actually used. */
interface PlaywrightModule {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<BrowserHandle>
  }
}

/** Options for {@link BrowserPool}. */
export interface BrowserPoolOptions {
  /**
   * Browser channel to launch: `'msedge'`, `'chrome'`, or `undefined` for
   * Playwright's bundled Chromium (which needs `npx playwright install`).
   *
   * Unset, the pool tries `msedge` then `chrome` then bundled — so a stock
   * Windows machine works with nothing to download.
   */
  readonly channel?: string
  /** Extra channel candidates tried in order after {@link BrowserPoolOptions.channel}. */
  readonly channelFallbacks?: readonly (string | undefined)[]
  /** Run without a visible window. Defaults to `true`. */
  readonly headless?: boolean
  /** User agent string. Defaults to a current Edge desktop UA. */
  readonly userAgent?: string
  /** Locale forwarded to the browser context. Defaults to `zh-CN`. */
  readonly locale?: string
  /** Default navigation timeout in milliseconds. */
  readonly navigationTimeoutMs?: number
  /** Extra Chromium launch arguments. */
  readonly args?: readonly string[]
}

/**
 * A one-browser, many-context pool.
 *
 * A single browser process is launched on first use and reused; each acquisition
 * gets its own context so cookies and storage never leak between queries. The
 * browser is closed by {@link BrowserPool.close} (or `dispose()`).
 */
export class BrowserPool {
  private readonly options: BrowserPoolOptions
  private browser: BrowserHandle | undefined
  private launching: Promise<BrowserHandle> | undefined
  private closed = false

  constructor(options: BrowserPoolOptions = {}) {
    this.options = options
  }

  /** Launch arguments used for every attempt. */
  private launchArgs(): Record<string, unknown> {
    return {
      headless: this.options.headless ?? true,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        ...this.options.args ?? [],
      ],
    }
  }

  /** Resolve the `playwright` module or throw a typed, actionable error. */
  private async requirePlaywright(): Promise<PlaywrightModule> {
    try {
      return (await import('playwright')) as unknown as PlaywrightModule
    } catch (cause: unknown) {
      throw new WebError(
        'browser search requires the optional dependency "playwright" (npm install playwright) ' +
          'and a browser: set channel "msedge" or "chrome" to use the one already installed, ' +
          'or run `npx playwright install chromium`',
        'WEB_PROVIDER_UNAVAILABLE',
        { cause },
      )
    }
  }

  /** Launch (once) and return the shared browser handle. */
  async launch(): Promise<BrowserHandle> {
    if (this.closed) {
      throw new WebError('browser pool is closed', 'WEB_PROVIDER_UNAVAILABLE')
    }
    if (this.browser?.isConnected() === true) return this.browser
    if (this.launching !== undefined) return this.launching

    const playwright = await this.requirePlaywright()
    const preferred = this.options.channel
    const fallbacks = this.options.channelFallbacks ?? ['msedge', 'chrome', undefined]
    const candidates: (string | undefined)[] = preferred === undefined
      ? [...fallbacks]
      : [preferred, ...fallbacks.filter(candidate => candidate !== preferred)]
    const seen = new Set<string | undefined>()
    const ordered = candidates.filter(candidate => {
      if (seen.has(candidate)) return false
      seen.add(candidate)
      return true
    })

    this.launching = (async () => {
      const failures: string[] = []
      for (const candidate of ordered) {
        try {
          const handle = await playwright.chromium.launch({
            ...this.launchArgs(),
            ...candidate !== undefined ? { channel: candidate } : {},
          })
          this.browser = handle
          return handle
        } catch (error: unknown) {
          failures.push(`${candidate ?? 'bundled chromium'}: ${describe(error)}`)
        }
      }
      throw new WebError(
        `could not launch a browser (tried ${ordered.map(c => c ?? 'bundled').join(', ')}): ${failures.join(' | ')}`,
        'WEB_PROVIDER_UNAVAILABLE',
      )
    })()

    try {
      return await this.launching
    } finally {
      this.launching = undefined
    }
  }

  /**
   * Acquire a fresh context and page, run `fn`, then always release them.
   * Cookie state never carries over between calls.
   */
  async withPage<R>(fn: (page: BrowserPage) => Promise<R>): Promise<R> {
    const browser = await this.launch()
    const context = await browser.newContext({
      userAgent: this.options.userAgent ?? DEFAULT_USER_AGENT,
      locale: this.options.locale ?? 'zh-CN',
      viewport: { width: 1366, height: 900 },
    })
    // Hide the single most common automation tell before any page script runs.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
    const page = await context.newPage()
    try {
      return await fn(page)
    } finally {
      await context.close().catch(() => undefined)
    }
  }

  /** Close the shared browser. Safe to call more than once. */
  async close(): Promise<void> {
    this.closed = true
    const browser = this.browser
    this.browser = undefined
    if (browser !== undefined) {
      await browser.close().catch(() => undefined)
    }
  }

  /** Alias for {@link BrowserPool.close}. */
  async dispose(): Promise<void> {
    await this.close()
  }
}

/** A current Edge desktop user agent; the most common browser on Windows. */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'

/** Short one-line description of a launch failure. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0] ?? message
}
