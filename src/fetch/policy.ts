/**
 * URL validation and content-type classification for the local HTTP(S) fetch
 * provider — the pure, network-free half.
 * Extracted verbatim from DeepSeek Harness `packages/web/web-fetch-http/src/policy.ts` (MIT).
 * @module dsh-web-kit/fetch/policy
 */

import { WebError } from '../types.js'

/** Maximum accepted request URL length enforced by the public fetch provider. */
export const WEB_FETCH_MAX_URL_LENGTH = 2048

/** The body kinds this provider decodes. */
export type FetchableKind = 'html' | 'text'

/**
 * Parse a request URL and enforce network-independent transport restrictions:
 * HTTP(S) only and no embedded credentials.
 */
export function parseFetchUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

/** Validate a request URL against the provider's complete pre-network policy. */
export function validateFetchUrl(input: string): URL {
  if (input.length > WEB_FETCH_MAX_URL_LENGTH) {
    throw new WebError(`URL exceeds the maximum length of ${WEB_FETCH_MAX_URL_LENGTH}`, 'WEB_INVALID_URL')
  }
  return parseFetchUrl(input)
}

/**
 * Two URLs are same-origin when scheme, hostname, and port match. A redirect
 * that crosses origins is refused so each new origin requires a fresh call and
 * public-address validation.
 */
export function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

/**
 * Classify a response `Content-Type` into a decodable body kind, or `undefined`
 * for an unsupported (e.g. binary) type.
 */
export function classifyContentType(contentType: string | null): FetchableKind | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

/** Extract the `charset` parameter from a response `Content-Type`, lower-cased. */
export function parseCharset(contentType: string | null): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')
  return match?.[1]?.trim().toLowerCase()
}

/**
 * Build a `TextDecoder` for the declared charset, falling back to UTF-8.
 * Throws `WEB_UNSUPPORTED_CONTENT_TYPE` when the label is present but unknown —
 * better to fail loudly than return mojibake.
 */
export function decoderForCharset(charset: string | undefined): TextDecoder {
  if (charset === undefined) return new TextDecoder('utf-8')
  try {
    return new TextDecoder(charset)
  } catch (error: unknown) {
    throw new WebError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', { cause: error })
  }
}
