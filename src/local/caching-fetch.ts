/**
 * `CachingFetchProvider`: a fetch provider decorator that indexes what it reads.
 *
 * Wraps any `WebFetchProvider` and stores the extracted article body of every
 * successful fetch into a {@link DocStore}. The wrapped result is passed through
 * unchanged, so this is transparent to callers: its only visible effect is that
 * {@link LocalIndexSearchProvider} can find the page later.
 *
 * Storage failures never fail the fetch — a full disk or a read-only directory
 * should degrade to "not indexed", not "cannot read the web".
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/local/caching-fetch
 */

import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '../types.js'
import { extractMainContent, type ExtractOptions } from '../filter/extract.js'
import { DocStore } from './store.js'

/** Options for {@link CachingFetchProvider}. */
export interface CachingFetchProviderOptions {
  /** Override the registered provider id. Defaults to the wrapped provider's id. */
  readonly id?: string
  /** Skip indexing when the extracted body is shorter than this. Default `200`. */
  readonly minChars?: number
  /** Index only successful (2xx) responses. Default `true`. */
  readonly onlySuccessful?: boolean
  /**
   * How to narrow the page before storing it. Defaults to `'gentle'`, so the
   * stored text keeps everything except non-rendering tags and clear ad slots.
   * Use `{ mode: 'full' }` to store the whole cleaned page.
   */
  readonly extract?: ExtractOptions
}

/** Read `<title>` out of an HTML document. */
export function htmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (match === null) return ''
  return match[1]?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() ?? ''
}

/**
 * A fetch provider that records what it fetched into the local index.
 */
export class CachingFetchProvider implements WebFetchProvider {
  readonly id: string
  private readonly inner: WebFetchProvider
  private readonly store: DocStore
  private readonly options: CachingFetchProviderOptions

  constructor(inner: WebFetchProvider, store: DocStore, options: CachingFetchProviderOptions = {}) {
    this.inner = inner
    this.store = store
    this.options = options
    this.id = options.id ?? inner.id
  }

  /** Delegate: the wrapper is usable exactly when the wrapped provider is. */
  available(): boolean {
    return this.inner.available()
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const result = await this.inner.fetch(request, signal)
    await this.record(result).catch(() => undefined)
    return result
  }

  /** Extract and store one result. Swallows storage errors by design. */
  private async record(result: WebFetchResult): Promise<void> {
    if (this.options.onlySuccessful !== false) {
      if (result.statusCode < 200 || result.statusCode >= 300) return
    }
    const minChars = this.options.minChars ?? 200
    if (result.body.content.length < minChars) return

    const extracted = extractMainContent(result.body.content, this.options.extract)
    const text = extracted.text.length > 0 ? extracted.text : result.body.content
    if (text.length < minChars) return

    await this.store.put({
      url: result.url,
      title: htmlTitle(result.body.content),
      text,
    })
  }
}
