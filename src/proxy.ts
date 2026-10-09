/**
 * Minimal proxy routing for outbound fetches.
 *
 * DELIBERATE SIMPLIFICATION. DeepSeek Harness ships `packages/util/http-proxy`
 * (681 lines) which owns a mounted, reloadable policy with per-URL routing,
 * install/uninstall lifecycle, and support for proxying loopback model
 * endpoints. None of that is needed to fetch public web pages, so this module
 * reads the standard environment variables once per request instead.
 *
 * Behaviour that differs from upstream:
 * - No mounted policy and no reload: variables are read on each call.
 * - NO_PROXY supports exact host match, dot-prefixed suffix match, and `*`.
 * - No per-scheme proxy override beyond `HTTPS_PROXY` / `HTTP_PROXY`.
 *
 * @module dsh-web-kit/proxy
 */

import { ProxyAgent, type Dispatcher } from 'undici'

/** The route one URL takes: either a proxy dispatcher, or direct. */
export interface ProxyRoute {
  /** True when the URL must go through `dispatcher`. */
  readonly proxied: boolean
  /** The dispatcher to use when {@link ProxyRoute.proxied} is true. */
  readonly dispatcher?: Dispatcher
}

const agents = new Map<string, ProxyAgent>()

/** Read one environment variable case-insensitively (Windows names vary in case). */
function env(name: string): string | undefined {
  const direct = process.env[name]
  if (direct !== undefined && direct.length > 0) return direct
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === target && value !== undefined && value.length > 0) return value
  }
  return undefined
}

/** Whether `hostname` is exempted by the `NO_PROXY` list. */
function isBypassed(hostname: string): boolean {
  const raw = env('NO_PROXY')
  if (raw === undefined) return false
  const host = hostname.toLowerCase()
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim().toLowerCase()
    if (trimmed.length === 0) continue
    if (trimmed === '*') return true
    if (trimmed.startsWith('.')) {
      if (host.endsWith(trimmed) || host === trimmed.slice(1)) return true
      continue
    }
    if (host === trimmed || host.endsWith(`.${trimmed}`)) return true
  }
  return false
}

/**
 * Resolve the route one URL takes.
 *
 * Loopback and private-literal hosts are never proxied: the public-address
 * checks refuse them anyway, and handing them to a proxy running on this
 * machine would reach the very service those checks exist to keep out of reach.
 */
export function proxyRouteFor(url: URL): ProxyRoute {
  const https = url.protocol === 'https:'
  const proxyUrl = env(https ? 'HTTPS_PROXY' : 'HTTP_PROXY') ?? env(https ? 'HTTP_PROXY' : 'HTTPS_PROXY')
  if (proxyUrl === undefined) return { proxied: false }
  if (isBypassed(url.hostname)) return { proxied: false }

  const cached = agents.get(proxyUrl)
  if (cached !== undefined) return { proxied: true, dispatcher: cached }
  const agent = new ProxyAgent(proxyUrl)
  agents.set(proxyUrl, agent)
  return { proxied: true, dispatcher: agent }
}
