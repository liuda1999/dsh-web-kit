/**
 * `web_fetch` business logic: argument validation and model-visible formatting.
 *
 * Extracted from DeepSeek Harness `packages/web/tool-web/src/fetch.ts` (MIT).
 * The HTML conversion lives in `./html.ts`; this module owns the header, the
 * truncation footer, and the output cap arithmetic.
 *
 * @module dsh-web-kit/tools/fetch
 */

import type { WebFetchResult } from '../types.js'
import { renderBody } from './html.js'
import { EXTERNAL_WEB_CONTENT_NOTICE } from './trust.js'

/** Default cap on one `web_fetch` output and on converted source characters. */
export const DEFAULT_FETCH_MAX_OUTPUT_CHARS = 200_000

/** Arguments accepted by `web_fetch`. */
export interface WebFetchArgs {
  readonly url: string
}

/** Structured summary attached to a result for UI replay (never model-visible). */
export interface WebFetchMeta {
  /** The final URL after allowed redirects. */
  readonly url: string
  /** HTTP status code of the fetched response. */
  readonly statusCode: number
  /** True when the provider, a source cut, or the output cap trimmed the content. */
  readonly truncated: boolean
}

/** Validate `web_fetch` arguments. */
export function parseFetchArgs(args: WebFetchArgs): { url: string } {
  if (args.url.trim().length === 0) throw new Error('url must be a non-empty string')
  return { url: args.url }
}

/** The truncation notice appended when the provider or the output cap cut content. */
const TRUNCATION_FOOTER = '\n\n(Content truncated. Fetch a more specific URL or section for the full text.)'

export interface RenderedFetch {
  /** The complete bounded output — header, rendered body, and truncation footer. */
  readonly text: string
  /**
   * True when the provider capped the body, a pre-conversion source cut applied,
   * or the complete output exceeded `maxOutputChars`. Wider than the
   * provider-only `WebFetchResult.truncated`.
   */
  readonly truncated: boolean
}

/**
 * Per-result memo, keyed first on the frozen result value so a garbage-collected
 * result drops its entry, then on the output cap. Collapses the twin
 * render/meta calls into one HTML to markdown conversion.
 */
const renderCache = new WeakMap<WebFetchResult, Map<number, RenderedFetch>>()

/** Render one fetch result, memoized. */
export function renderFetchOutput(result: WebFetchResult, maxOutputChars: number): RenderedFetch {
  const byCap = renderCache.get(result) ?? new Map<number, RenderedFetch>()
  const cached = byCap.get(maxOutputChars)
  if (cached !== undefined) return cached
  const computed = computeFetchOutput(result, maxOutputChars)
  byCap.set(maxOutputChars, computed)
  renderCache.set(result, byCap)
  return computed
}

function computeFetchOutput(result: WebFetchResult, maxOutputChars: number): RenderedFetch {
  const header = `Fetched ${result.url} (HTTP ${result.statusCode})\n\n${EXTERNAL_WEB_CONTENT_NOTICE}\n\n`
  const rendered = renderBody(result.body, maxOutputChars)
  const prefix = `${header}${rendered.text}`
  const truncated = result.truncated || rendered.sourceTruncated || prefix.length > maxOutputChars
  const full = `${prefix}${truncated ? TRUNCATION_FOOTER : ''}`
  if (full.length <= maxOutputChars) return { text: full, truncated }
  if (maxOutputChars < TRUNCATION_FOOTER.length) return { text: full.slice(0, maxOutputChars), truncated }
  return { text: `${prefix.slice(0, maxOutputChars - TRUNCATION_FOOTER.length)}${TRUNCATION_FOOTER}`, truncated }
}

/** The model-visible text for one fetch result. */
export function formatFetchOutput(result: WebFetchResult, maxOutputChars = DEFAULT_FETCH_MAX_OUTPUT_CHARS): string {
  return renderFetchOutput(result, maxOutputChars).text
}

/** Build the UI-replay meta from a result value. */
export function fetchMetaFromValue(
  value: WebFetchResult,
  maxOutputChars = DEFAULT_FETCH_MAX_OUTPUT_CHARS,
): WebFetchMeta {
  return { url: value.url, statusCode: value.statusCode, truncated: renderFetchOutput(value, maxOutputChars).truncated }
}

/** Whether an unknown value is a well-formed {@link WebFetchMeta}. */
export function fetchMetaFromResult(meta: unknown): WebFetchMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { url, statusCode, truncated } = meta as Record<string, unknown>
  if (typeof url !== 'string' || typeof statusCode !== 'number' || typeof truncated !== 'boolean') return undefined
  return { url, statusCode, truncated }
}
