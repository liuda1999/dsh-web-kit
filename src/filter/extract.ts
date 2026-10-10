/**
 * Page-level content filtering: extract the article body out of a web page.
 *
 * A fetched page is mostly not the article. Navigation, sidebars, comment
 * threads, "related posts", cookie banners and ad slots routinely outweigh the
 * text you actually want — and every byte of them is billed to the model as
 * context.
 *
 * Against that sits a worse failure: cutting away text the answer was in. So
 * this extraction is layered ({@link EXTRACT_MODES}) and bounded
 * ({@link maxLossRatio}): **if narrowing the page to the main block would
 * discard more than the allowed share of the cleaned page's text, narrowing is
 * abandoned and you get the whole cleaned page instead.** Losing boilerplate is
 * an optimisation; losing the article is a bug.
 *
 * The default mode is `gentle`, which removes only non-rendering tags and
 * high-confidence ad containers, then accepts the main block only when it is
 * clearly carrying the page. The looser class-name heuristics — the ones that
 * guess at "related" and "comment" — do not run until `standard`, because those
 * guesses are exactly what eats a paper's Related Work section or the comment
 * holding the right answer.
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/filter/extract
 */

import { controlValue, type AttributeReader } from './controls.js'

/**
 * How aggressively a page may be narrowed.
 *
 * The ladder is about **what a mode is willing to discard**. Stricter modes may
 * only remove what a looser one already removed; none of them may resurrect
 * content, which is what keeps `standard` a strict subset of `gentle`.
 *
 * - `full`       — strip tags that cannot render text (`script`, `style`).
 *                  Nothing else is touched: no cropping, no guessing, and no
 *                  content category is dropped at all.
 * - `gentle`     — default. Drops declared chrome, then crops to the main block
 *                  **only if** it clearly holds the page. Keeps images, form
 *                  values and embedded-media labels.
 * - `standard`   — also drops containers whose class/id looks like page chrome,
 *                  and discards embedded media (iframe/SVG/video) that most
 *                  often carries decoration. Images and form values stay.
 * - `aggressive` — pure prose only: no images, no form values, no media. Use
 *                  when you want sentences and nothing else.
 */
export type ExtractMode = 'full' | 'gentle' | 'standard' | 'aggressive'

/** Per-mode settings. See {@link EXTRACT_MODES}. */
export interface ExtractModeSpec {
  /**
   * Drop `<nav>`, `<footer>`, `<aside>` and friends — author-declared chrome.
   * Every mode except `full` does this; it is not a guess.
   */
  readonly semanticTags: boolean
  /**
   * Also drop subtrees whose class/id merely *looks* like chrome
   * (`related`, `comment`, `share`, ...). This is inference, it eats real
   * sections, and it is why `gentle` leaves it off.
   */
  readonly chromeHeuristics: boolean
  /** Narrow the page to the densest block. */
  readonly crop: boolean
  /** Share of the page's non-link text the chosen block must retain, or cropping is abandoned. */
  readonly maxLossRatio: number
  /** Minimum non-link characters a block needs to be a candidate. */
  readonly minBlockChars: number
  /**
   * Keep images, as `[image: alt]`.
   *
   * Their text lives in an attribute, so without this every diagram is absent
   * from the index even though its caption survived — you can search for the
   * caption and never find the picture's own description.
   */
  readonly includeImages: boolean
  /**
   * Keep form control text: `<input value>`, `<option>`, `<textarea>`, labels.
   *
   * A reference page rendered as controls is otherwise empty. This is the
   * default, because losing an entire genre of documentation costs more than
   * tolerating the odd search box.
   */
  readonly includeForms: boolean
  /**
   * Keep embedded media as text: SVG's `<text>` labels, `<iframe>` titles,
   * `<track>` caption labels, canvas fallback text.
   *
   * SVG in particular is how technical diagrams ship: an architecture drawing
   * is often nothing but `<text>` nodes, and deleting `<svg>` wholesale erases
   * the labels that made the figure searchable.
   */
  readonly includeMedia: boolean
}

export const EXTRACT_MODES: Readonly<Record<ExtractMode, ExtractModeSpec>> = Object.freeze({
  full: {
    semanticTags: false, chromeHeuristics: false, crop: false, maxLossRatio: 0, minBlockChars: 0,
    includeImages: true, includeForms: true, includeMedia: true,
  },
  gentle: {
    semanticTags: true, chromeHeuristics: false, crop: true, maxLossRatio: 0.65, minBlockChars: 200,
    includeImages: true, includeForms: true, includeMedia: true,
  },
  standard: {
    semanticTags: true, chromeHeuristics: true, crop: true, maxLossRatio: 0.65, minBlockChars: 200,
    includeImages: true, includeForms: true, includeMedia: false,
  },
  aggressive: {
    semanticTags: true, chromeHeuristics: true, crop: true, maxLossRatio: 0.9, minBlockChars: 400,
    includeImages: false, includeForms: false, includeMedia: false,
  },
})

/** The mode used when none is given. Gentle: remove the obvious, keep the rest. */
export const DEFAULT_EXTRACT_MODE: ExtractMode = 'gentle'

/** Options for {@link extractMainContent}. */
export interface ExtractOptions {
  /** See {@link EXTRACT_MODES}. Default `'gentle'`. */
  readonly mode?: ExtractMode
  /** Override the mode's {@link ExtractModeSpec.maxLossRatio}. 1 disables the guard. */
  readonly maxLossRatio?: number
  /** Override the mode's {@link ExtractModeSpec.minBlockChars}. */
  readonly minBlockChars?: number
  /** Override whether `<img>` alt text is recovered. See {@link ExtractModeSpec.includeImages}. */
  readonly includeImages?: boolean
  /** Override whether form control text is recovered. See {@link ExtractModeSpec.includeForms}. */
  readonly includeForms?: boolean
  /** Override whether embedded media labels are recovered. See {@link ExtractModeSpec.includeMedia}. */
  readonly includeMedia?: boolean
}

/**
 * Tags whose subtree can never hold readable prose, in any mode.
 *
 * Kept deliberately short. Each name here is something that either does not
 * render (`template`, `noscript`) or renders as code rather than prose
 * (`script`, `style`). Everything else is a per-mode decision now.
 */
const NON_RENDERING_TAGS = new Set(['script', 'style', 'noscript', 'template'])

/**
 * Embedded media: content that is drawn rather than written.
 *
 * Dropped from `standard` up. Not dropped in `gentle`, because {@link
 * ExtractModeSpec.includeMedia} exists precisely for the cases where these do
 * carry text — an SVG diagram's labels, an iframe's title.
 */
const MEDIA_TAGS = new Set(['svg', 'canvas', 'iframe', 'object', 'embed', 'audio', 'video'])

/**
 * Form controls that are containers.
 *
 * `<input>` is absent on purpose: it is a void element, so there is no subtree
 * to suppress — it is either rewritten to text or left as an empty tag.
 */
const FORM_TAGS = new Set(['form', 'select', 'textarea', 'button', 'datalist', 'output', 'progress'])

/**
 * Names substituted for content that cannot be expressed as words.
 *
 * English regardless of page language, matching the existing omission marker in
 * `tools/html.ts`, so calling code can key off one stable vocabulary.
 */
const IMAGE_NAME = 'image'
const EMBED_NAME = 'embedded'
const CAPTION_TRACK_NAME = 'caption track'

/**
 * Render one substituted marker, naming the source when it has a name.
 *
 * `[image: three worker lanes]` rather than a bare marker: the alt text is the
 * only description the picture has, and a marker without it tells the reader
 * something is missing without saying what.
 */
function marker(name: string, label: string): string {
  return label === '' ? ` [${name}] ` : ` [${name}: ${label}] `
}

/**
 * Structural chrome tags (`nav`, `footer`, `aside`, ...).
 *
 * Not a guess. `<footer>` says what it is; the author declared it. Removing
 * these is safe enough that every cropping mode does it — including `gentle`.
 * The risky bucket is {@link CHROME_PATTERN}, which infers intent from class
 * names, and that one waits for `standard`.
 */
const CHROME_TAGS = new Set(['nav', 'header', 'footer', 'aside', 'dialog', 'menu'])

/**
 * Tags that are containers worth scoring as candidate article bodies.
 *
 * `body` is deliberately absent: it accumulates every descendant's text, so it
 * always scores highest, and choosing it selects the page unchanged — cropping
 * that crops nothing, which also defeats the `maxLossRatio` guard.
 */
const BLOCK_TAGS = new Set(['article', 'main', 'section', 'div', 'td'])

/** Containers that strongly imply article content; scored with a bonus. */
const SEMANTIC_TAGS = new Set(['article', 'main'])

/** Void elements: they never have a matching close tag. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
])

/**
 * Near-certain ad slots. Applied even in `gentle`, because these strings have no
 * innocent reading.
 *
 * Note the deliberate absence of words like `related`, `comment`, `share`,
 * `social`, `recommend`, `promo` and `widget`: those appear on real content
 * containers often enough (a paper's "Related Work", the comment holding the
 * accepted answer) that deleting their subtrees costs more than it saves. They
 * live in {@link CHROME_PATTERN}, which only runs from `standard`.
 */
const AD_PATTERN =
  /(^|[\s_-])((google[-_]?)?ad(s|vert|vertise|vertisement|sense|slot|box|wrap|container)?|sponsor(ed)?|promoted| advertisement| doubanad| bytedance[-_]?ad| dfp[-_]?ad)([\s_-]|$)/i

/** Broader guesses at page chrome. Used from `standard` up. */
const CHROME_PATTERN =
  /(^|[\s_-])(ad|ads|advert|advertis|banner|sidebar|side-bar|comment|comments|share|sharing|social|related|recommend|promo|sponsor|footer|header|navbar|nav|menu|breadcrumb|popup|modal|overlay|cookie|consent|newsletter|subscribe|pagination|pager|widget|toolbar|tabbar)([\s_-]|$)/i

/** One matched HTML tag. */
const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g

/**
 * Whole subtrees whose *content* is not markup and must be removed literally.
 *
 * `<script>` bodies are CDATA in practice: they contain `<`, `&&`, comparisons
 * like `a<b`, sometimes even the literal text `</script`. Walking them with a
 * tag stack — as the rest of this module does — goes wrong on all three: a
 * comparison looks like a tag, and a `<script` inside a string inflates the
 * nesting depth so the real closing tag no longer ends suppression. Observed
 * symptom: a ~50 KB NUXT hydration payload survived cleaning and was counted as
 * article text, which both bloated output and skewed the `retained` ratio that
 * guards against over-cropping. A dedicated non-greedy sweep has none of this.
 */
const RAW_TEXT_SUBTREE = /<(script|style|noscript|template|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

/**
 * An unterminated one — everything to the end of the document.
 *
 * Fetched pages are truncated to a byte limit, and that limit routinely lands
 * inside a `<script>`. The block then has no closing tag, so the paired sweep
 * above cannot remove it and its body is read as prose. Cutting to the end is
 * the right answer here: what follows an unclosed script is the truncated
 * remnant, and swallowing a few tags beats treating 50 KB of JavaScript as an
 * article.
 */
const RAW_TEXT_UNTERMINATED = /<(script|style|noscript|template|textarea)\b[^>]*>[\s\S]*$/i

/** Remove CDATA-style subtrees, including ones a truncation left unclosed. */
function removeRawTextSubtrees(html: string): string {
  return html.replace(RAW_TEXT_SUBTREE, ' ').replace(RAW_TEXT_UNTERMINATED, ' ')
}

/**
 * `<textarea>` is listed in {@link RAW_TEXT_SUBTREE}: its body is CDATA, so the
 * tag scanner cannot walk it. When its text is being kept, it has to be
 * rewritten **before** that sweep runs, or the sweep takes the text with it.
 */
const TEXTAREA_PAIR = /<textarea\b[^>]*>([\s\S]*?)<\/textarea\s*>/gi

/** One embedded subtree: its tag name, raw attributes, and inner markup. */
const EMBEDDED_SUBTREE = /<(svg|canvas|video|audio)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi

/** A `<track>` element, whose `label` names the caption or subtitle track. */
const TRACK_TAG = /<track\b[^>]*\blabel\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi

/** SVG elements whose body is text rather than geometry. */
const SVG_TEXT = /<(text|tspan|title|desc)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi

/**
 * Recover text hidden in drawn or CDATA content, as ordinary text nodes.
 *
 * Both consumers downstream — {@link htmlToText} and whatever renders the HTML
 * — then see it without special cases, which is the point of doing it here
 * rather than in each of them.
 */
function recoverEmbeddedText(html: string, spec: ExtractModeSpec): string {
  let out = html

  if (spec.includeForms) {
    out = out.replace(TEXTAREA_PAIR, (_match, body: string) => {
      const value = htmlToText(body)
      return value === '' ? ' ' : ` ${value} `
    })
  }

  if (spec.includeMedia) {
    out = out.replace(EMBEDDED_SUBTREE, (_match, tag: string, _attrs: string, body: string) => {
      if (tag.toLowerCase() === 'svg') {
        const labels = svgLabels(body)
        return labels === '' ? ' ' : ` ${labels} `
      }
      // canvas/video/audio: their fallback text plus any caption track labels.
      const tracks: string[] = []
      TRACK_TAG.lastIndex = 0
      for (const track of body.matchAll(TRACK_TAG)) tracks.push(track[2] ?? track[3] ?? '')
      const parts = [htmlToText(body), ...tracks]
        .map(part => part.trim())
        .filter(part => part !== '')
      return parts.length === 0 ? ' ' : ` ${parts.join(' ')} `
    })
  }

  return out
}

/** The words inside an SVG: anything that is not geometry carries meaning. */
function svgLabels(body: string): string {
  const labels: string[] = []
  SVG_TEXT.lastIndex = 0
  for (const match of body.matchAll(SVG_TEXT)) {
    const text = htmlToText(match[2] ?? '')
    if (text !== '') labels.push(text)
  }
  return labels.join(' ')
}

/** Read attributes out of a raw attribute string, reporting absence as `null`. */
function attrsReader(attrs: string): AttributeReader {
  return name => {
    const value = attribute(attrs, name)
    return value === '' ? null : value
  }
}

/**
 * Extra text to write next to a tag whose content lives in its attributes, or
 * `null` to leave the tag as it is.
 *
 * Always **appended beside** the tag, never substituted for it. Replacing
 * `<img>` with its alt text would strip the only thing a later Markdown
 * conversion needs to emit `![alt](src)`, trading a real picture for a mention
 * of one. Keeping both costs one line and loses nothing.
 *
 * The inverse: leaving the tag alone contributes nothing to a plain-text view,
 * because stripping tags discards attributes with them. Hence this function.
 */
function tagAnnotation(tag: string, attrs: string, spec: ExtractModeSpec): string | null {
  switch (tag) {
    case 'input': {
      if (!spec.includeForms) return null
      const value = controlValue(attrsReader(attrs))
      return value === '' ? null : ` ${value} `
    }
    case 'img': {
      if (!spec.includeImages) return null
      const alt = htmlToText(attribute(attrs, 'alt'))
      // A diagram with no alt text still happened. Say so rather than vanishing.
      return marker(IMAGE_NAME, alt)
    }
    case 'iframe':
    case 'object':
    case 'embed': {
      if (!spec.includeMedia) return null
      const read = attrsReader(attrs)
      const label = htmlToText(read('title') ?? read('aria-label') ?? '')
      return label === '' ? null : marker(EMBED_NAME, label)
    }
    case 'track': {
      if (!spec.includeMedia) return null
      const label = htmlToText(attribute(attrs, 'label'))
      // Unlike an unlabelled image, an unnamed track says nothing worth keeping.
      return label === '' ? null : marker(CAPTION_TRACK_NAME, label)
    }
    default:
      return null
  }
}

/** A container element and its accumulated text statistics. */
interface Block {
  readonly tag: string
  /** Offset just past the opening tag. */
  readonly start: number
  /** Offset of the matching closing tag. */
  readonly end: number
  readonly textLen: number
  readonly linkLen: number
}

/** Bounded mutable frame used while scanning. */
interface Frame {
  tag: string
  start: number
  textLen: number
  linkLen: number
}

/** Read one attribute value out of a raw attribute string. */
function attribute(attrs: string, name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs)
  if (match === null) return ''
  return match[2] ?? match[3] ?? ''
}

/** True when the element's class or id marks it as chrome, at the given strictness. */
function isChrome(attrs: string, pattern: RegExp | undefined): boolean {
  if (pattern === undefined) return false
  const cls = attribute(attrs, 'class')
  const id = attribute(attrs, 'id')
  return pattern.test(cls) || pattern.test(id)
}

/**
 * Remove comments and every non-content subtree.
 *
 * @param html the page.
 * @param options mode-derived settings.
 * @returns the page with boilerplate subtrees excised.
 */
export function cleanPageHtml(html: string, options: ExtractOptions = {}): string {
  const spec = resolveSpec(options)
  const classPattern = spec.chromeHeuristics ? CHROME_PATTERN : AD_PATTERN

  // What this mode is allowed to remove. Content categories are opt-*out*: a
  // tag is dropped only because the mode said so, never because it sits in a
  // hard-coded list of things nobody reads.
  const dropTags = new Set<string>(NON_RENDERING_TAGS)
  if (!spec.includeMedia) for (const tag of MEDIA_TAGS) dropTags.add(tag)
  if (!spec.includeForms) for (const tag of FORM_TAGS) dropTags.add(tag)
  if (spec.semanticTags) for (const tag of CHROME_TAGS) dropTags.add(tag)

  // Recover embedded text before comment/raw-text sweeps: both would take it.
  const withoutComments = removeRawTextSubtrees(
    recoverEmbeddedText(html.replace(/<!--[\s\S]*?-->/g, ''), spec),
  )

  const out: string[] = []
  let cursor = 0
  let suppress: string | undefined
  let suppressDepth = 0

  TAG_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG_PATTERN.exec(withoutComments)) !== null) {
    const [full, slash, rawTag, , selfClose] = match
    if (slash === undefined || rawTag === undefined || full === undefined) continue
    const tag = rawTag.toLowerCase()

    if (suppress !== undefined) {
      if (slash === '/' && tag === suppress) {
        suppressDepth -= 1
        if (suppressDepth <= 0) {
          suppress = undefined
          cursor = match.index + full.length
        }
      } else if (slash === '' && tag === suppress && selfClose !== '/') {
        suppressDepth += 1
      }
      continue
    }

    if (slash === '/') continue

    // Attribute-borne content, annotated in place for any tag shape: `<img>`,
    // `<input>`, `<track>` are void, while `<iframe>` and `<object>` are not.
    // Nothing here suppresses a subtree, so whatever the author put inside
    // those elements still flows through.
    const annotation = tagAnnotation(tag, match[3] ?? '', spec)
    if (annotation !== null) {
      out.push(withoutComments.slice(cursor, match.index), full, annotation)
      cursor = match.index + full.length
      continue
    }
    if (VOID_TAGS.has(tag) || selfClose === '/') continue

    if (dropTags.has(tag) || isChrome(match[3] ?? '', classPattern)) {
      suppress = tag
      suppressDepth = 1
      out.push(withoutComments.slice(cursor, match.index))
      continue
    }
  }
  out.push(withoutComments.slice(cursor))
  return out.join('')
}

/**
 * Merge caller overrides into the mode's defaults.
 *
 * Overrides are per-content-category so that disagreeing with one decision —
 * "keep the form values even in aggressive" — never means inventing a new mode.
 */
function resolveSpec(options: ExtractOptions): ExtractModeSpec {
  const base = EXTRACT_MODES[options.mode ?? DEFAULT_EXTRACT_MODE]
  return {
    ...base,
    includeImages: options.includeImages ?? base.includeImages,
    includeForms: options.includeForms ?? base.includeForms,
    includeMedia: options.includeMedia ?? base.includeMedia,
  }
}

/** A candidate block with its density score. */
interface ScoredBlock extends Block {
  readonly score: number
}

/** Whole-document text statistics, in the same units as a {@link ScoredBlock}. */
interface BlockScan {
  /** Candidates above the floor, best-scoring first. */
  readonly blocks: readonly ScoredBlock[]
  /** Non-link text in the entire document — the denominator 'retained' needs. */
  readonly textLen: number
  /** Link text in the entire document. */
  readonly linkLen: number
}

/**
 * Scan every block element and score how much non-link text each holds.
 *
 * The scan also totals the document's non-link text. That figure — not the raw
 * page text — is what 'what share is this block?' must divide by: both sides
 * have to exclude link text, or every navigation-heavy page looks like it is
 * about to lose everything and the loss guard refuses to crop at all.
 */
function scanBlocks(html: string): BlockScan {
  // A sentinel root frame. Without it, the outermost real element has no parent
  // to hand its totals to when it closes, and every total ends up zero — which
  // silently disabled the maxLossRatio guard, since a zero denominator was
  // clamped to 1 and made every block look like it retained 100%.
  const stack: Frame[] = [{ tag: '#root', start: 0, textLen: 0, linkLen: 0 }]
  const blocks: ScoredBlock[] = []
  let cursor = 0
  let linkDepth = 0

  TAG_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG_PATTERN.exec(html)) !== null) {
    const full = match[0]
    const slash = match[1]
    const rawTag = match[2]
    if (rawTag === undefined) continue
    const tag = rawTag.toLowerCase()
    const isClose = slash === '/'
    const selfClose = match[4] === '/'

    // Text between the previous tag and this one belongs to the current frame.
    const text = html.slice(cursor, match.index)
    if (text.length > 0 && stack.length > 0) {
      const length = text.replace(/\s+/g, ' ').trim().length
      if (length > 0) {
        const top = stack[stack.length - 1]
        if (top !== undefined) {
          if (linkDepth > 0) top.linkLen += length
          else top.textLen += length
        }
      }
    }
    cursor = match.index + full.length

    if (isClose) {
      const frame = stack.pop()
      if (tag === 'a' && linkDepth > 0) linkDepth -= 1
      if (frame === undefined) continue
      const parent = stack[stack.length - 1]
      if (parent !== undefined) {
        parent.textLen += frame.textLen
        parent.linkLen += frame.linkLen
      }
      if (BLOCK_TAGS.has(frame.tag) && frame.textLen > 0) {
        blocks.push({
          tag: frame.tag,
          start: frame.start,
          end: match.index,
          textLen: frame.textLen,
          linkLen: frame.linkLen,
          score: 0,
        })
      }
      continue
    }
    if (VOID_TAGS.has(tag) || selfClose) continue

    stack.push({ tag, start: cursor, textLen: 0, linkLen: 0 })
    if (tag === 'a') linkDepth += 1
  }

  // Unclosed frames never got the chance to add themselves to a parent, so sum
  // what is left. Each contributes only what it holds: nothing was double-counted
  // on the way in, because only a matching close tag rolls a frame upward.
  let totalText = 0
  let totalLink = 0
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) continue
    totalText += frame.textLen
    totalLink += frame.linkLen
  }

  return {
    blocks: blocks
      .map(block => ({
        ...block,
        score: (block.textLen - block.linkLen) * (SEMANTIC_TAGS.has(block.tag) ? 1.5 : 1),
      }))
      .sort((a, b) => b.score - a.score),
    textLen: totalText,
    linkLen: totalLink,
  }
}

/** Why {@link extractMainContent} did not narrow the page. */
export type ExtractFallback =
  /** It did narrow. */
  | 'none'
  /** The mode does not crop (e.g. `full`). */
  | 'mode'
  /** No block looked like an article. */
  | 'no-block'
  /** A block was found, but keeping it would have discarded too much text. */
  | 'loss-ratio'

/** The outcome of extracting one page's article body. */
export interface ExtractedContent {
  /** Cleaned HTML of the chosen block, or the cleaned page when cropping was abandoned. */
  readonly html: string
  /** Plain text of the same content. */
  readonly text: string
  /** Tag name of the chosen block, or `null` when it fell back to the page. */
  readonly picked: string | null
  /** Why it fell back. `'none'` means it did not. */
  readonly fallback: ExtractFallback
  /** Mode actually used. */
  readonly mode: ExtractMode
  /** Characters removed by cleaning relative to the input. */
  readonly cleanedChars: number
  /** Characters of visible text retained, 0–1. `1` when nothing was cropped. */
  readonly retained: number
  /** Plain text of the whole cleaned page — what was available before cropping. */
  readonly cleanedText: string
}

/**
 * Extract the article body from a page.
 *
 * Never throws, and never returns less than the cleaned page: if narrowing would
 * cost more text than {@link ExtractModeSpec.maxLossRatio} allows, you get the
 * cleaned page and `fallback: 'loss-ratio'` explaining why.
 */
export function extractMainContent(html: string, options: ExtractOptions = {}): ExtractedContent {
  const mode = options.mode ?? DEFAULT_EXTRACT_MODE
  const spec = EXTRACT_MODES[mode]
  const maxLossRatio = options.maxLossRatio ?? spec.maxLossRatio
  const minBlockChars = options.minBlockChars ?? spec.minBlockChars

  let cleaned: string
  try {
    // Forward every option, not just the mode: a per-category override has to
    // reach the cleaner or it silently does nothing.
    cleaned = cleanPageHtml(html, options)
  } catch {
    cleaned = html
  }
  const cleanedText = htmlToText(cleaned)

  if (!spec.crop) {
    return {
      html: cleaned,
      text: cleanedText,
      picked: null,
      fallback: 'mode',
      mode,
      cleanedChars: Math.max(0, html.length - cleaned.length),
      retained: 1,
      cleanedText,
    }
  }

  let picked: Block | undefined
  let fallback: ExtractFallback = 'no-block'
  try {
    const scan = scanBlocks(cleaned)
    const best = scan.blocks.find(block => block.textLen >= minBlockChars)
    if (best !== undefined) {
      if ((1 - estimateRetained(best, scan.textLen)) <= maxLossRatio) {
        picked = best
        fallback = 'none'
      } else {
        fallback = 'loss-ratio'
      }
    }
  } catch {
    picked = undefined
    fallback = 'no-block'
  }

  const body = picked === undefined ? cleaned : cleaned.slice(picked.start, picked.end)
  const text = picked === undefined ? cleanedText : htmlToText(body)
  return {
    html: body,
    text,
    picked: picked?.tag ?? null,
    fallback,
    mode,
    cleanedChars: Math.max(0, html.length - cleaned.length),
    retained: cleanedText.length > 0 ? Math.min(1, text.length / cleanedText.length) : 1,
    cleanedText,
  }
}

/**
 * Share of the document's non-link text a block holds.
 *
 * Both sides exclude link text, which is what makes the answer meaningful on
 * pages where navigation outweighs the article.
 */
function estimateRetained(block: Block, totalTextLen: number): number {
  return Math.min(1, block.textLen / Math.max(1, totalTextLen))
}

/** Strip tags and collapse whitespace, for the plain-text view. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
