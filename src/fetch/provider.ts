/**
 * Safe HTTP(S) retrieval: validates and pins public IP destinations, follows
 * only same-origin redirects, enforces time and size limits, and classifies and
 * decodes text. Requests carry no browser cookies or ambient credentials.
 *
 * Extracted from DeepSeek Harness
 * `packages/web/web-fetch-http/src/provider.ts` (MIT). Two changes from
 * upstream: the `using` declaration became an explicit `try/finally` (so no
 * Explicit Resource Management support is required), and `proxyRouteFor` comes
 * from the local simplified `proxy.ts`.
 *
 * @module dsh-web-kit/fetch/provider
 */

import { WebError } from '../types.js'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '../types.js'
import { deadline, timeoutOf } from '../timeout.js'
import { proxyRouteFor } from '../proxy.js'
import type { Response } from 'undici'
import { isNonPublicIpLiteral, publicHttpNetwork } from './network.js'
import type { PublicAddress } from './network.js'
import { classifyContentType, decoderForCharset, isSameOrigin, parseCharset, validateFetchUrl } from './policy.js'

/** Resolved provider limits. */
export interface HttpFetchLimits {
  /** Maximum response body size in bytes (read is aborted past this). */
  maxResponseBytes: number
  /** Maximum decoded body length in characters (truncated past this). */
  maxBodyChars: number
  /** Default fetch timeout in milliseconds. */
  timeoutMs: number
  /** Maximum number of (same-origin) redirect hops to follow. */
  maxRedirects: number
  /** `User-Agent` header sent on every request. */
  userAgent: string
}

/** Resolve one hostname to an already policy-validated address set. */
export type HttpFetchResolver = (hostname: string, signal: AbortSignal) => Promise<PublicAddress[]>

/** Stable id this provider registers under. */
export const LOCAL_FETCH_PROVIDER_ID = 'http'

/** Default limits, matching the shipped DeepSeek Harness plugin defaults. */
export const DEFAULT_FETCH_LIMITS: HttpFetchLimits = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
  userAgent: 'dsh-web-kit/0.1',
}

/** The anonymous public HTTP(S) fetch provider. */
export class HttpFetchProvider implements WebFetchProvider {
  readonly id = LOCAL_FETCH_PROVIDER_ID

  constructor(
    private readonly limits: HttpFetchLimits = DEFAULT_FETCH_LIMITS,
    private readonly resolveAddresses: HttpFetchResolver = publicHttpNetwork.resolve,
  ) {}

  /** No credentials to check — an anonymous public fetcher is always usable. */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    const d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    try {
      return await this.followAndRead(request.url, d.signal)
    } finally {
      d.dispose()
    }
  }

  /** Follow same-origin redirects up to the hop cap, then read the final response. */
  private async followAndRead(initialUrl: string, signal: AbortSignal): Promise<WebFetchResult> {
    let currentUrl = validateFetchUrl(initialUrl)
    let redirectsFollowed = 0

    for (;;) {
      const request = await this.requestOnce(currentUrl, signal)
      const { response } = request
      try {
        if (isRedirectStatus(response.status)) {
          if (redirectsFollowed >= this.limits.maxRedirects) {
            await response.body?.cancel()
            throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
          }
          const location = response.headers.get('location')
          if (location === null) {
            await response.body?.cancel()
            throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
          }
          const target = resolveRedirect(location, currentUrl)
          let validatedTarget: URL
          try {
            validatedTarget = validateFetchUrl(target.toString())
            if (!isSameOrigin(validatedTarget, currentUrl)) {
              throw new WebError(
                `cross-origin redirect to ${validatedTarget.origin} is not followed automatically; retry against that URL directly`,
                'WEB_REDIRECT_BLOCKED',
              )
            }
          } catch (error: unknown) {
            await response.body?.cancel()
            throw error
          }
          await response.body?.cancel()
          currentUrl = validatedTarget
          redirectsFollowed++
          continue
        }

        return await this.readBody(response, currentUrl, signal)
      } finally {
        await request.close()
      }
    }
  }

  private async requestOnce(url: URL, signal: AbortSignal) {
    const headers = {
      'user-agent': this.limits.userAgent,
      'accept': 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
    }
    try {
      // A proxied hop skips public-address resolution and pinning: the proxy
      // performs the origin's DNS, so there is no local address to validate.
      // An IP literal the address checks would refuse never takes this branch.
      const route = proxyRouteFor(url)
      if (route.proxied && route.dispatcher !== undefined && !isNonPublicIpLiteral(url.hostname)) {
        return await publicHttpNetwork.requestVia(route.dispatcher, url, headers, signal)
      }
      const addresses = await this.resolveAddresses(url.hostname, signal)
      return await publicHttpNetwork.request(url, addresses, headers, signal)
    } catch (error: unknown) {
      if (error instanceof WebError) throw error
      throw translateAbortOrNetwork(error, signal)
    }
  }

  /** Read, byte-cap, classify, and decode the final response body. */
  private async readBody(response: Response, finalUrl: URL, signal: AbortSignal): Promise<WebFetchResult> {
    const contentType = response.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      await response.body?.cancel()
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }

    // Resolve the decoder BEFORE reading so an unsupported charset fails without
    // consuming the stream — but cancel the body so the socket does not leak.
    let decoder: TextDecoder
    try {
      decoder = decoderForCharset(parseCharset(contentType))
    } catch (error: unknown) {
      await response.body?.cancel()
      throw error
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response, signal)
    const decoded = decoder.decode(bytes)
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded
    const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }

    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body,
      truncated: truncatedByBytes || truncatedByChars,
    }
  }

  /**
   * Read the response stream up to `maxResponseBytes`. A `Content-Length` over
   * the cap rejects immediately; a stream that grows past the cap is cut short
   * rather than rejected, so a server that under-reports still yields a bounded
   * usable body.
   */
  private async readCapped(
    response: Response,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        await response.body?.cancel()
        throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
    }

    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }

    const chunks: Uint8Array[] = []
    let total = 0
    let truncatedByBytes = false
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = this.limits.maxResponseBytes - total
        // Only DROPPED bytes count as truncation: a chunk that exactly fills the
        // remaining capacity keeps all its bytes and we read on to observe EOF.
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } catch (error: unknown) {
      throw translateAbortOrNetwork(error, signal)
    } finally {
      await reader.cancel().catch(() => {
        // Cancel after a successful read is best-effort cleanup.
      })
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }
}

/** HTTP redirect status codes that carry a `Location`. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Resolve a (possibly relative) `Location` against the current URL. */
function resolveRedirect(location: string, base: URL): URL {
  try {
    return new URL(location, base)
  } catch (error: unknown) {
    throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/**
 * Translate a thrown fetch/stream error into a `WebError`, classified by the
 * deadline signal rather than the thrown value (which differs by phase).
 */
function translateAbortOrNetwork(error: unknown, signal: AbortSignal): WebError {
  const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}
