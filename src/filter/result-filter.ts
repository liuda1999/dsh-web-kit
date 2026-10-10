/**
 * Result-level content filtering, layered by how much it is allowed to throw away.
 *
 * Scraped search pages contain things that are not answers: paid placements,
 * redirect interstitials that are not destinations, the engine's own navigation
 * links, the same URL with different tracking parameters, and near-duplicate
 * titles from content syndication. Handing that to a model wastes context and
 * makes citation impossible.
 *
 * The design problem is that every one of those rules can also eat something
 * real. So instead of one hard switch, each rule has one of three actions:
 *
 * - `keep`   — ignore the signal entirely
 * - `demote` — keep the row, but move it behind everything clean
 * - `drop`   — remove it
 *
 * {@link FILTER_LEVELS} bundles those into four named levels, and {@link filterSources}
 * returns `kept` / `demoted` / `dropped` separately so nothing disappears
 * unaccounted for. **The default is `loose`, which only drops rows that are
 * provably not content** (an unusable URL, an ad the scraper structurally
 * identified, an engine redirect when the real destination is not otherwise
 * present, an exact duplicate URL). Everything merely *suspicious* survives and
 * is ranked last, so a bad day costs you relevance, not recall.
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/filter/result-filter
 */

import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '../types.js'

/** A source plus the optional ad flag a scraper can supply. */
export interface FilterableSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  /** True when the scraper identified the row as a paid placement. */
  readonly sponsored?: boolean
}

/**
 * Every signal the filter can act on. Used both as the `reason` on output rows
 * and as the key for per-rule overrides.
 */
export type FilterRule =
  | 'invalid-url'
  | 'sponsored'
  | 'engine-link'
  | 'duplicate-url'
  | 'no-title'
  | 'short-snippet'
  | 'duplicate-title'
  | 'host-cap'
  | 'low-score'
  | 'blocked-keyword'
  | 'blocked-host'
  | 'not-allowed-host'

/** What a rule does when it fires. */
export type RuleAction = 'keep' | 'demote' | 'drop'

/** Per-rule actions. */
export type FilterRules = Readonly<Record<FilterRule, RuleAction>>

/** How much the filter is allowed to remove. See {@link FILTER_LEVELS}. */
export type FilterLevel = 'off' | 'loose' | 'balanced' | 'strict'

/**
 * The four bundled levels.
 *
 * `loose` is the default. The dividing line is confidence, not severity:
 * `loose` drops only what is provably not source material, and demotes what is
 * merely suspicious. `strict` is for people who have read their own results and
 * decided they would rather lose an edge case than see noise.
 */
export const FILTER_LEVELS: Readonly<Record<FilterLevel, FilterRules>> = Object.freeze({
  /** Nothing is removed or reordered. Truly off; useful to measure what the filter was doing. */
  off: {
    'invalid-url': 'keep',
    sponsored: 'keep',
    'engine-link': 'keep',
    'duplicate-url': 'keep',
    'no-title': 'keep',
    'short-snippet': 'keep',
    'duplicate-title': 'keep',
    'host-cap': 'keep',
    'low-score': 'keep',
    'blocked-keyword': 'keep',
    'blocked-host': 'keep',
    'not-allowed-host': 'keep',
  },
  /** Default. Drops dead and duplicative rows; everything else is only demoted. */
  loose: {
    'invalid-url': 'drop',
    sponsored: 'drop',
    'engine-link': 'drop',
    'duplicate-url': 'drop',
    'no-title': 'keep',
    'short-snippet': 'keep',
    'duplicate-title': 'demote',
    'host-cap': 'keep',
    'low-score': 'keep',
    'blocked-keyword': 'drop',
    'blocked-host': 'drop',
    'not-allowed-host': 'drop',
  },
  /** Demotes every soft signal (untitled, thin snippet, near-dupes, ...). */
  balanced: {
    'invalid-url': 'drop',
    sponsored: 'drop',
    'engine-link': 'drop',
    'duplicate-url': 'drop',
    'no-title': 'demote',
    'short-snippet': 'demote',
    'duplicate-title': 'demote',
    'host-cap': 'demote',
    'low-score': 'demote',
    'blocked-keyword': 'drop',
    'blocked-host': 'drop',
    'not-allowed-host': 'drop',
  },
  /** Soft signals become drops. Explicit policy still wins, as in every level. */
  strict: {
    'invalid-url': 'drop',
    sponsored: 'drop',
    'engine-link': 'drop',
    'duplicate-url': 'drop',
    'no-title': 'drop',
    'short-snippet': 'drop',
    'duplicate-title': 'drop',
    'host-cap': 'drop',
    'low-score': 'drop',
    'blocked-keyword': 'drop',
    'blocked-host': 'drop',
    'not-allowed-host': 'drop',
  },
})

/** The level used when none is given. Loose on purpose: recall first. */
export const DEFAULT_FILTER_LEVEL: FilterLevel = 'loose'

/** All rules, in the order duplicate and news reports should read them. */
export const FILTER_RULE_NAMES: readonly FilterRule[] = Object.freeze([
  'invalid-url', 'sponsored', 'engine-link', 'duplicate-url',
  'no-title', 'short-snippet', 'duplicate-title', 'host-cap', 'low-score',
  'blocked-keyword', 'blocked-host', 'not-allowed-host',
])

/** Options for {@link filterSources}. Nothing is blocked until you ask for it. */
export interface ResultFilterOptions {
  /**
   * Starting point for {@link FILTER_LEVELS}. Default `'loose'`.
   * Set `'off'` to see what the filter was doing to your results.
   */
  readonly level?: FilterLevel
  /**
   * Per-rule overrides applied on top of the level. Use this rather than
   * switching levels when you only disagree with one rule.
   */
  readonly rules?: Partial<FilterRules>
  /** @deprecated use `rules: { sponsored: 'keep' }`. `false` disables the rule. */
  readonly dropSponsored?: false
  /** @deprecated use `rules: { 'engine-link': 'keep' }`. `false` disables the rule. */
  readonly dropEngineLinks?: false
  /** @deprecated use `rules: { 'no-title': 'keep' }`. `false` disables the rule. */
  readonly requireTitle?: false
  /** Rows with a snippet shorter than this are flagged. Default `0` (never). */
  readonly minSnippetChars?: number
  /** After this many rows from one host, extra rows are flagged. Default `0` (unlimited). */
  readonly maxPerHost?: number
  /** Rows scoring below this are flagged. Default `0` (never). The score otherwise only orders rows. */
  readonly minScore?: number
  /**
   * Substrings that disqualify a row, matched against title + snippet.
   * **Default: empty.** Nothing is blocked out of the box; this list is yours.
   * ASCII entries match on word boundaries, so `ad` never hits "read".
   */
  readonly blockedKeywords?: readonly string[]
  /** Hosts that are never useful as sources. **Default: empty.** Suffix match. */
  readonly blockedHosts?: readonly string[]
  /** If set, only these hosts survive. Suffix match. **Default: unset (everything allowed).** */
  readonly allowedHosts?: readonly string[]
  /** Re-rank kept rows by {@link scoreSource}. Default `false` — trust the engine's own order. */
  readonly sortByScore?: boolean
}

/** A kept or demoted row, with the score it was given. */
export interface ScoredSource extends FilterableSource {
  readonly score: number
}

/** Why a row was removed. */
export interface DroppedSource {
  readonly source: FilterableSource
  readonly reason: FilterRule
  /** Always `'drop'` here; present so callers can treat both lists uniformly. */
  readonly action: 'drop'
}

/** Why a row was kept but moved to the back. */
export interface DemotedSource extends ScoredSource {
  /** The soft signal that fired. */
  readonly reason: FilterRule
  /** Always `'demote'` here. */
  readonly action: 'demote'
}

/** Outcome of one filter pass. `kept` and `demoted` together are what survives. */
export interface FilterOutcome {
  /** Rows that passed every rule, in input order (or score order if requested). */
  readonly kept: readonly ScoredSource[]
  /** Suspicious rows that were *not* removed — appended after `kept`. */
  readonly demoted: readonly DemotedSource[]
  /** Rows removed, each with its reason. */
  readonly dropped: readonly DroppedSource[]
  /** The rules actually applied, after level + overrides. */
  readonly rules: FilterRules
  /** The level this run started from. */
  readonly level: FilterLevel
}

/**
 * Engine hosts, and the paths on those hosts that mean "this is the engine's own
 * navigation, not a result". Blocking the whole host would throw away real
 * content (Baidu Baike is a legitimate source), so host *and* path are matched.
 *
 * This is the only hard-coded direction in the filter, and it covers nine
 * entries — six search-engine hosts plus Baidu's placement and ad-tech hosts,
 * each of which was observed outranking real results. Everything else is
 * opt-in.
 */
const ENGINE_SELF_LINKS: readonly { readonly host: RegExp; readonly path: RegExp }[] = [
  { host: /(^|\.)baidu\.com$/i, path: /^\/(s|baidu\.php|link|home|index)(\?|\/|$)/i },
  // Baidu serves recommendation slots from numbered subdomains, e.g.
  // http://28608.recommend_list.baidu.com. Sampling five queries, three
  // returned one as the **top** result — a placement ranking above every real
  // source. Same for the ad-tech hosts below: none can be an answer.
  { host: /^[\w-]+\.recommend_list\.baidu\.com$/i, path: /^/ },
  { host: /(^|\.)(pos|cpro|cbjs|eclick)\.baidu\.com$/i, path: /^/ },
  { host: /(^|\.)bing\.com$/i, path: /^\/(search|ck|images|videos|maps|news\/search)(\?|\/|$)/i },
  { host: /(^|\.)sogou\.com$/i, path: /^\/(web|link|sogou)(\?|\/|$)/i },
  { host: /(^|\.)so\.com$/i, path: /^\/(s|link)(\?|\/|$)/i },
  { host: /(^|\.)google\.com$/i, path: /^\/(search|url)(\?|\/|$)/i },
  { host: /(^|\.)duckduckgo\.com$/i, path: /^\/(l|html)(\?|\/|$)/i },
]

/** Query parameters that only exist for tracking and never change the document. */
const TRACKING_PARAMS = /^(utm_|spm|from|ref|share_|_ga|gclid|fbclid|msclkid|wt_|hmsr|hmmd|share_source|share_medium)/i

/**
 * Titles shorter than this (after {@link canonicalTitle} strips punctuation and
 * spaces) are never treated as duplicates. Nothing proves collision more often
 * than meaningless short titles: two unrelated sites both titled "首页" are not
 * one document.
 */
const MIN_TITLE_DUP_CHARS = 8

/** Strip tracking parameters and normalise a URL for de-duplication. */
export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url)
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key)
    }
    parsed.hash = ''
    let host = parsed.hostname.toLowerCase()
    if (host.startsWith('www.')) host = host.slice(4)
    let path = parsed.pathname
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
    return `${parsed.protocol}//${host}${path}${parsed.search}`
  } catch {
    return url
  }
}

/** The host a source belongs to, with a leading `www.` removed. */
export function sourceHost(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.startsWith('www.') ? host.slice(4) : host
  } catch {
    return ''
  }
}

/** True when the URL is an engine redirect interstitial or engine self-link. */
export function isEngineLink(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return ENGINE_SELF_LINKS.some(entry => entry.host.test(parsed.hostname) && entry.path.test(parsed.pathname))
}

/**
 * Heuristic quality score. Higher is better; the scale is arbitrary and only
 * meaningful relative to other rows in the same result set.
 *
 * By default this only *orders* rows — it removes nothing. It becomes a removal
 * signal only once you supply `minScore` (or choose `balanced` / `strict`, where
 * it demotes or drops instead).
 *
 * All signals are ones a scraper can see without fetching the page.
 */
export function scoreSource(source: FilterableSource): number {
  let score = 0
  const title = source.title?.trim() ?? ''
  const snippet = source.snippet?.trim() ?? ''

  if (title.length > 0) score += 2
  if (title.length >= 10) score += 1
  score += Math.min(3, Math.floor(snippet.length / 40))
  if (snippet.length >= 80) score += 1

  try {
    const parsed = new URL(source.url)
    if (parsed.protocol === 'https:') score += 1
    const segments = parsed.pathname.split('/').filter(Boolean)
    // Deep paths and directory roots are usually indexes, not documents.
    if (segments.length === 0) score -= 2
    else if (segments.length > 6) score -= 1
    if (/\.(html?|shtml|php|aspx?|md|txt)$/i.test(parsed.pathname)) score += 1
    if (/\/(tag|category|tags|categories|page|search|index)(\/|$)/i.test(parsed.pathname)) score -= 2
  } catch {
    score -= 5
  }

  if (source.sponsored === true) score -= 10
  return score
}

/** Normalise a title for near-duplicate detection. */
export function canonicalTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim()
}

/**
 * Keyword match that respects word boundaries for ASCII needles.
 *
 * Substring matching would make the English keyword `ad` hit every title
 * containing "read", "load" or "update". CJK has no word boundaries, so those
 * needles stay substring matches — which is why Chinese keywords want to be
 * multi-character.
 */
export function keywordHit(keyword: string, haystack: string): boolean {
  const needle = keyword.toLowerCase().trim()
  if (needle.length === 0) return false
  const lower = haystack.toLowerCase()
  if (/^[\x20-\x7e]+$/.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(lower)
  }
  return lower.includes(needle)
}

/** Resolve level + per-rule overrides + deprecated booleans into one rule set. */
export function resolveRules(options: ResultFilterOptions = {}): { level: FilterLevel; rules: FilterRules } {
  const level = options.level ?? DEFAULT_FILTER_LEVEL
  const base = FILTER_LEVELS[level]
  const rules: Record<FilterRule, RuleAction> = { ...base }

  for (const [rule, action] of Object.entries(options.rules ?? {})) {
    if (action !== undefined && (rule as FilterRule) in rules) rules[rule as FilterRule] = action
  }

  // Backwards-compatible single-rule switches. They can only loosen, never
  // tighten: anything stricter belongs in `rules`.
  if (options.dropSponsored === false) rules.sponsored = 'keep'
  if (options.dropEngineLinks === false) rules['engine-link'] = 'keep'
  if (options.requireTitle === false) rules['no-title'] = 'keep'

  return { level, rules: Object.freeze(rules) }
}

/**
 * Filter scraped search rows.
 *
 * Returns three lists rather than two. Rows that merely look suspicious are
 * **demoted** — kept, but placed after every clean row — so the default level
 * can only cost you ranking, never content. `maxResults` truncation then removes
 * them first, without ever having hidden them from you.
 */
export function filterSources(
  sources: readonly FilterableSource[],
  options: ResultFilterOptions = {},
): FilterOutcome {
  const { level, rules } = resolveRules(options)
  const minSnippetChars = options.minSnippetChars ?? 0
  const maxPerHost = options.maxPerHost ?? 0
  const minScore = options.minScore ?? 0
  const blockedKeywords = options.blockedKeywords ?? []
  const blockedHosts = options.blockedHosts ?? []
  const allowedHosts = options.allowedHosts

  const kept: ScoredSource[] = []
  const demoted: DemotedSource[] = []
  const dropped: DroppedSource[] = []
  const seenUrls = new Set<string>()
  const seenTitles = new Set<string>()
  const perHost = new Map<string, number>()

  const matchesHost = (host: string, patterns: readonly string[]): boolean =>
    patterns.some(pattern => host === pattern || host.endsWith(`.${pattern}`))

  for (const source of sources) {
    const score = scoreSource(source)
    const host = sourceHost(source.url)
    const allowed = allowedHosts !== undefined && matchesHost(host, allowedHosts)
    const haystack = `${source.title ?? ''} ${source.snippet ?? ''}`

    // `flag` records the first rule that fires, together with its action.
    // Explicit allow-listed hosts are exempt from every soft rule; only
    // structural problems (unusable URL, exact duplicate) still apply.
    let flagged: { reason: FilterRule; action: RuleAction } | undefined
    const soft = (reason: FilterRule, hits: boolean): void => {
      if (flagged !== undefined || !hits) return
      if (allowed && reason !== 'not-allowed-host') return
      flagged = { reason, action: rules[reason] }
    }

    flagged = undefined
    if (host.length === 0 || !/^https?:\/\//i.test(source.url)) {
      flagged = { reason: 'invalid-url', action: rules['invalid-url'] }
    } else {
      soft('sponsored', source.sponsored === true)
      soft('engine-link', isEngineLink(source.url))
      soft('blocked-keyword', blockedKeywords.length > 0 && blockedKeywords.some(word => keywordHit(word, haystack)))
      soft('blocked-host', blockedHosts.length > 0 && matchesHost(host, blockedHosts))
      if (allowedHosts !== undefined && !allowed) flagged = { reason: 'not-allowed-host', action: rules['not-allowed-host'] }
      soft('no-title', (source.title?.trim().length ?? 0) === 0)
      soft('short-snippet', minSnippetChars > 0 && (source.snippet?.trim().length ?? 0) < minSnippetChars)

      const key = canonicalUrl(source.url)
      if (flagged === undefined && seenUrls.has(key)) {
        flagged = { reason: 'duplicate-url', action: rules['duplicate-url'] }
      }
      const titleKey = canonicalTitle(source.title ?? '')
      if (flagged === undefined && titleKey.length >= MIN_TITLE_DUP_CHARS && seenTitles.has(titleKey)) {
        flagged = { reason: 'duplicate-title', action: rules['duplicate-title'] }
      }
      if (flagged === undefined && minScore > 0 && score < minScore) {
        flagged = { reason: 'low-score', action: rules['low-score'] }
      }
      soft('host-cap', maxPerHost > 0 && (perHost.get(host) ?? 0) >= maxPerHost)
    }

    const row: ScoredSource = { ...source, score }

    if (flagged !== undefined && flagged.action === 'drop') {
      dropped.push({ source, reason: flagged.reason, action: 'drop' })
      // Removed rows still reserve their URL and title: keeping one copy is the
      // point, and a demoted row must not be re-offered later.
      seenUrls.add(canonicalUrl(source.url))
      const titleKey = canonicalTitle(source.title ?? '')
      if (titleKey.length >= MIN_TITLE_DUP_CHARS) seenTitles.add(titleKey)
      continue
    }

    seenUrls.add(canonicalUrl(source.url))
    const titleKey = canonicalTitle(source.title ?? '')
    if (titleKey.length >= MIN_TITLE_DUP_CHARS) seenTitles.add(titleKey)

    if (flagged !== undefined && flagged.action === 'demote') {
      demoted.push({ ...row, reason: flagged.reason, action: 'demote' })
      continue
    }

    if (maxPerHost > 0) perHost.set(host, (perHost.get(host) ?? 0) + 1)
    kept.push(row)
  }

  if (options.sortByScore === true) {
    kept.sort((a, b) => b.score - a.score)
    demoted.sort((a, b) => b.score - a.score)
  }

  return { kept, demoted, dropped, rules, level }
}

/** Everything that survived, `kept` first then `demoted`. */
export function survived(outcome: FilterOutcome): readonly ScoredSource[] {
  return [...outcome.kept, ...outcome.demoted]
}

/** Convert filtered rows into the runtime's source shape. */
export function toSources(rows: readonly FilterableSource[]): WebSearchSource[] {
  return rows.map(row => ({
    url: row.url,
    ...row.title !== undefined ? { title: row.title } : {},
    ...row.snippet !== undefined ? { snippet: row.snippet } : {},
  }))
}

/** One-line summary of what the filter did, for humans and models. */
export function describeFilter(outcome: FilterOutcome): string {
  const actions = new Map<string, number>()
  for (const row of outcome.dropped) actions.set(`dropped ${row.reason}`, (actions.get(`dropped ${row.reason}`) ?? 0) + 1)
  for (const row of outcome.demoted) actions.set(`relegated ${row.reason}`, (actions.get(`relegated ${row.reason}`) ?? 0) + 1)
  if (actions.size === 0) return ''
  return [...actions.entries()].map(([name, count]) => `${name}×${count}`).join(', ')
}

/**
 * Wrap any search provider so its results pass through {@link filterSources}.
 *
 * Nothing is removed silently: when rows are dropped or relegated, that fact is
 * reported in `content`. Silent removal would be indistinguishable from the web
 * having nothing to say, which is exactly the failure mode worth avoiding.
 */
export function withFilter(provider: WebSearchProvider, options: ResultFilterOptions = {}): WebSearchProvider {
  // Wider declared type: the wrapper keeps a handle on the wrapped provider so
  // disposal can reach browser processes inside it.
  const composite: WebSearchProvider & { readonly inner: WebSearchProvider } = {
    id: provider.id,
    inner: provider,
    available: () => provider.available(),
    async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
      const result = await provider.search(request, signal)
      const outcome = filterSources(result.sources, options)
      if (outcome.dropped.length === 0 && outcome.demoted.length === 0) return result

      const summary = describeFilter(outcome)
      const note = `Filter (${outcome.level}): ${summary}.`
      return {
        ...result,
        sources: toSources(survived(outcome)),
        ...result.content !== undefined ? {} : { content: note },
      }
    },
  }
  return composite
}
