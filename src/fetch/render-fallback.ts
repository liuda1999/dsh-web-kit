/**
 * `withRenderFallback(primary, renderer)`: HTTP first, browser only when the
 * static body looks like a shell — and only when rendering actually wins.
 *
 * Three measured facts drive this design:
 *
 * 1. **A short static body is not the only signal.** Pages that build their
 *    tables from XHR responses can carry several thousand characters of static
 *    chrome and still have zero data rows. Judging on text length alone misses
 *    the market grids this exists for, so an unfilled table counts as a shell
 *    too.
 *
 * 2. **"Has rows" is not "has data", and neither is "has a filled cell".**
 *    `www.cngold.org/xhhj/` ships its grid server-side with every price cell
 *    holding `--`: 16 `<tr>` around eight rows of placeholders. Two cheaper
 *    tests were tried and both failed on that page, which is why the check is
 *    what it is:
 *
 *    - *count rows* — passes, because the skeleton has rows, so no render.
 *    - *count rows that contain any non-empty cell* — also passes, because the
 *      name column ("伦敦黄金") is real text and rescues every row; and on top
 *      of that the page's footer "recommended reading" table contributes six
 *      genuinely-filled rows that mask the empty grid beside it.
 *
 *    What separates a filled grid from an unfilled one is the **cell**: a table
 *    where placeholder cells outnumber real ones has not been populated. That
 *    is measured per table, because a page can hold one empty grid next to one
 *    table that is honestly full.
 *
 * 3. **Rendering can make a page worse.** Measured on the same ten sites:
 *    music.163.com drops from 17,640 characters of main text to **484**, and
 *    MDN from 40,023 to 28,320 — a hash-routed SPA and a hydrated docs page
 *    both render to less than the source they came from. Replacing the static
 *    body unconditionally would silently destroy working pages.
 *
 * So the renderer runs when the static body looks like a shell, and its result
 * is kept **only when it scores higher**. Scoring weights populated cells
 * because a grid of figures is worth more than a screen of navigation.
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/fetch/render-fallback
 */

import { WebError } from '../types.js'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '../types.js'
import { extractMainContent } from '../filter/extract.js'

/** Cheap, DOM-free measurements of one HTML body. */
export interface ContentSignals {
  /** Visible text length after script/style/noscript/template are stripped. */
  readonly textChars: number
  /** Number of `<table` elements. */
  readonly tableCount: number
  /** Number of `<tr` elements — the data rows, whether or not they were filled. */
  readonly rowCount: number
  /** `<td>` cells whose text is real data rather than a placeholder. */
  readonly dataCells: number
  /** `<td>` cells that are empty or hold a placeholder such as `--`. */
  readonly placeholderCells: number
  /**
   * Tables that have cells at all but hold more placeholders than data.
   *
   * This is the signal that separates a delivered grid from a skeleton: rows
   * alone do not, and neither does "some cell in the row has text".
   */
  readonly unfilledTableCount: number
  /** Number of `<img` elements. */
  readonly imageCount: number
}

/**
 * Cells that mean "no value yet": dashes, dots, the "nothing here" words.
 *
 * `0.00` is deliberately absent. A market grid at rest shows `0.00` for a
 * genuinely flat price, and treating that as a placeholder would launch a
 * browser on every closed market in the world.
 */
const PLACEHOLDER_CELL = /^(?:[-—–_*.·•\s]|&nbsp;|暂无|无数据|null|n\/?a|-{2,})$/i

/**
 * Text of one cell: tags off, `&nbsp;` to a space, whitespace collapsed.
 *
 * `&nbsp;` must be handled before the whitespace collapse, or a cell that is
 * nothing but that entity reads as non-empty content.
 */
export function cellText(cellHtml: string): string {
  return cellHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when a cell holds no value — empty, or only a placeholder glyph. */
export function isPlaceholderCell(text: string): boolean {
  return text.length === 0 || PLACEHOLDER_CELL.test(text)
}

/**
 * Measure one HTML body without building a DOM.
 *
 * The regexes are deliberately crude: this decides whether to spend seconds on
 * a browser, not what the page says. Being wrong by a few tags is harmless.
 *
 * Tables are measured one at a time. Aggregating over the whole page is what
 * let the footer's filled rows hide an empty quote grid.
 */
export function contentSignals(
  html: string,
  minPlaceholderCells: number = DEFAULT_MIN_PLACEHOLDER_CELLS,
): ContentSignals {
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  const textChars = stripped.replace(/\s+/g, ' ').trim().length

  const tables = html.match(/<table\b[\s\S]*?<\/table>/gi) ?? []
  let dataCells = 0
  let placeholderCells = 0
  let unfilledTableCount = 0
  for (const table of tables) {
    const cells = table.match(/<td\b[\s\S]*?<\/td>/gi) ?? []
    let placeholders = 0
    for (const cell of cells) {
      if (isPlaceholderCell(cellText(cell))) placeholders++
    }
    const data = cells.length - placeholders
    dataCells += data
    placeholderCells += placeholders
    // "More placeholders than data" needs a floor as well, or a table whose
    // only cell is a single `-` would count as an unfilled grid.
    if (placeholders >= minPlaceholderCells && placeholders > data) unfilledTableCount++
  }

  return {
    textChars,
    tableCount: tables.length,
    rowCount: (html.match(/<tr\b/gi) ?? []).length,
    dataCells,
    placeholderCells,
    unfilledTableCount,
    imageCount: (html.match(/<img\b/gi) ?? []).length,
  }
}

/**
 * Error codes a browser must not be asked to work around.
 *
 * A renderer is not a second opinion on policy. `www.rust-lang.org` redirects
 * cross-origin to `rust-lang.org`; the HTTP provider refuses that on purpose,
 * and a browser follows redirects by definition — so falling back here would
 * quietly reverse a security decision and hand back the page the policy just
 * refused. The same applies to private addresses, bad URLs, and oversized
 * responses: if the policy said no, the answer is no.
 *
 * Timeouts, connection failures and unsupported content types are absent on
 * purpose — those are capability failures, and a browser genuinely can do
 * better on them.
 */
const POLICY_CODES: readonly string[] = [
  'WEB_BLOCKED_URL',
  'WEB_REDIRECT_BLOCKED',
  'WEB_INVALID_URL',
  'WEB_INVALID_ARGS',
  'WEB_FETCH_TOO_LARGE',
]

/** True for a failure that is a decision rather than a capability gap. */
function isPolicyError(error: unknown): boolean {
  return error instanceof WebError && POLICY_CODES.includes(error.code)
}

/**
 * Length of the extracted main text, falling back to the whole-page signal.
 *
 * Extraction is the right measure because it is what the model actually sees.
 * Whole-page text is not: on douyin.com/hot the rendered DOM measured 84,954
 * characters of "visible" text, all of it JSON inside an unterminated
 * `<script>` that no regex strip catches — cleaned, the page held 94.
 * Extraction costs 1–4 ms on these bodies, so the cruder number buys nothing.
 */
function mainTextChars(html: string, fallback: ContentSignals): number {
  try {
    return extractMainContent(html).text.length
  } catch {
    return fallback.textChars
  }
}

/**
 * Weight of one populated cell when comparing two bodies, in main-text
 * characters. A cell of figures is short in characters and high in value, so
 * cells are counted as more than their raw length.
 *
 * 12 is the old row weight (50) divided by the five cells a market row has.
 * Measured on `www.cngold.org/xhhj/`, whose eight price rows fill 8 more cells
 * when rendered: static 7,494 + 20×12 = 7,734 against rendered 7,609 + 28×12 =
 * 7,945 — the rendered body wins by 211, which is what makes the gap more than
 * noise without letting a grid outvote a page.
 */
export const DEFAULT_CELL_WEIGHT = 12

/**
 * Placeholder cells a table must hold before it can count as unfilled.
 * Default 2.
 *
 * One is too few: any table with a single `-` in it — a footnote, a range like
 * "2019-" — would launch a browser. Two is where a skeleton becomes
 * distinguishable from a page that simply has a dash somewhere.
 */
export const DEFAULT_MIN_PLACEHOLDER_CELLS = 2

/** Options for {@link withRenderFallback}. */
export interface RenderFallbackOptions {
  /**
   * Extracted main-text characters below which the static body counts as a
   * shell. Defaults to 1500.
   *
   * Measured on ten sites: the pages worth rendering came back at 0–1,401
   * characters of static main text, and the two that render *worse* than their
   * source came back at 17,640 and 40,023. The default sits in the empty gap
   * between those two clusters, which is what makes one threshold safe.
   */
  readonly minTextChars?: number
  /**
   * A table skeleton with at most this many rows counts as unfilled.
   * Defaults to 3.
   */
  readonly sparseTableRows?: number
  /**
   * Placeholder cells one table must hold — and outnumber real cells — before
   * the page counts as a shell. Defaults to
   * {@link DEFAULT_MIN_PLACEHOLDER_CELLS}.
   *
   * This is the test that catches a server-side grid whose prices are all
   * `--`. Raise it if a page legitimately renders mostly dashes.
   */
  readonly minPlaceholderCells?: number
  /**
   * Value of one populated cell in the comparison, in text characters.
   * Defaults to {@link DEFAULT_CELL_WEIGHT}.
   */
  readonly cellWeight?: number
  /**
   * Status codes that retry through the renderer even though the fetch itself
   * succeeded — challenge pages answer 403/429/503 and resolve only once their
   * JavaScript runs. Defaults to `[403, 429, 503]`; pass `[]` to never retry on
   * status alone (every such page then costs one browser launch).
   */
  readonly retryOnStatus?: readonly number[]
  /** Replace the shell test entirely. */
  readonly judge?: (result: WebFetchResult) => boolean
  /** Observability hook: called once per decision that matters. */
  readonly onDecision?: (decision: RenderDecision) => void
}

/** One recorded decision, for tests and host observability. */
export interface RenderDecision {
  /** Why the renderer ran, or why it did not. */
  readonly reason: 'shell' | 'status' | 'primary-error' | 'not-needed' | 'render-lost' | 'render-failed'
  /** Signals of the static body, when the primary succeeded. */
  readonly static?: ContentSignals
  /** Signals of the rendered body, when the renderer ran. */
  readonly rendered?: ContentSignals
  /** True when the rendered body replaced the static one. */
  readonly usedRendered: boolean
}

/** Composite provider id, so registration stays stable when the chain changes. */
export function withRenderFallback(
  primary: WebFetchProvider,
  renderer: WebFetchProvider,
  options: RenderFallbackOptions = {},
): WebFetchProvider & { readonly providers: readonly WebFetchProvider[]; dispose(): Promise<void> } {
  const minTextChars = options.minTextChars ?? 1500
  const sparseTableRows = options.sparseTableRows ?? 3
  const minPlaceholderCells = options.minPlaceholderCells ?? DEFAULT_MIN_PLACEHOLDER_CELLS
  const cellWeight = options.cellWeight ?? DEFAULT_CELL_WEIGHT
  const retryOnStatus = options.retryOnStatus ?? [403, 429, 503]

  const signalsOf = (result: WebFetchResult): ContentSignals =>
    result.body.kind === 'html'
      ? contentSignals(result.body.content, minPlaceholderCells)
      : { textChars: 0, tableCount: 0, rowCount: 0, dataCells: 0, placeholderCells: 0, unfilledTableCount: 0, imageCount: 0 }

  const looksLikeShell = (result: WebFetchResult): boolean => {
    if (options.judge !== undefined) return options.judge(result)
    if (result.body.kind !== 'html') return false
    const signals = signalsOf(result)
    if (mainTextChars(result.body.content, signals) < minTextChars) return true
    // A skeleton with rows but not one populated cell. The cell condition
    // matters: on MDN the static body carries a two-row table — a `<th>` header
    // and one real row — and a bare row-count test renders that page for
    // nothing, which costs two seconds and buys a body that then loses.
    if (signals.tableCount >= 1 && signals.rowCount <= sparseTableRows && signals.dataCells === 0) return true
    // A skeleton the server shipped with placeholder cells: rows exist, and so
    // do some real cells — the name column — but the values are all `--`.
    return signals.unfilledTableCount >= 1
  }

  const score = (result: WebFetchResult, signals: ContentSignals): number =>
    (result.body.kind === 'html' ? mainTextChars(result.body.content, signals) : 0) + signals.dataCells * cellWeight

  return {
    id: primary.id,
    providers: [primary, renderer],
    dispose: async () => {
      for (const provider of [primary, renderer]) {
        const disposable = provider as unknown as { dispose?: () => Promise<void> }
        if (typeof disposable.dispose === 'function') {
          await disposable.dispose().catch(() => undefined)
        }
      }
    },
    available(): boolean {
      return primary.available() || renderer.available()
    },
    async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
      const report = (decision: RenderDecision): void => {
        options.onDecision?.(decision)
      }

      let first: WebFetchResult
      try {
        first = await primary.fetch(request, signal)
      } catch (error: unknown) {
        // A cancellation is the caller's decision, not a backend failure.
        if (signal?.aborted) throw error
        // A policy refusal is a decision. Rendering must not reverse it.
        if (isPolicyError(error)) throw error
        try {
          const rendered = await renderer.fetch(request, signal)
          report({ reason: 'primary-error', rendered: signalsOf(rendered), usedRendered: true })
          return { ...rendered, rendered: true }
        } catch (renderError: unknown) {
          if (signal?.aborted) throw renderError
          report({ reason: 'render-failed', usedRendered: false })
          throw error instanceof WebError ? error : new WebError(String(error), 'WEB_PROVIDER_ERROR', { cause: error })
        }
      }

      const statusRetry = retryOnStatus.includes(first.statusCode)
      if (!statusRetry && !looksLikeShell(first)) {
        report({ reason: 'not-needed', static: signalsOf(first), usedRendered: false })
        return first
      }

      const staticSignals = signalsOf(first)
      let rendered: WebFetchResult
      try {
        rendered = await renderer.fetch(request, signal)
      } catch {
        // The static body is worse than a rendered one but better than nothing.
        report({ reason: 'render-failed', static: staticSignals, usedRendered: false })
        return first
      }

      const renderedSignals = signalsOf(rendered)
      if (score(rendered, renderedSignals) > score(first, staticSignals)) {
        report({
          reason: statusRetry ? 'status' : 'shell',
          static: staticSignals,
          rendered: renderedSignals,
          usedRendered: true,
        })
        return { ...rendered, rendered: true }
      }
      // Rendering lost. Keep what worked — this is the whole point.
      report({ reason: 'render-lost', static: staticSignals, rendered: renderedSignals, usedRendered: false })
      return first
    },
  }
}
