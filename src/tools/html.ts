/**
 * HTML to Markdown conversion for `web_fetch`.
 *
 * Extracted from DeepSeek Harness `packages/web/tool-web/src/fetch.ts` (MIT):
 * the Turndown configuration, the GFM table rules that refuse colspan
 * expansion, the lexical depth guard, and {@link renderBody}.
 *
 * @module dsh-web-kit/tools/html
 */

import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'
import { controlValue } from '../filter/controls.js'
import type { WebFetchBody } from '../types.js'

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})
turndown.use(gfm)
turndown.addRule('removeNonVisibleContent', {
  filter(node) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED'].includes(node.nodeName)) return true
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true
    if (node.nodeName === 'INPUT' && node.getAttribute('type')?.toLowerCase() === 'hidden') return true
    const declarations = node.getAttribute('style')?.split(';') ?? []
    return declarations.some((declaration) => {
      const separator = declaration.indexOf(':')
      if (separator === -1) return false
      const property = declaration.slice(0, separator).trim().toLowerCase()
      const value = declaration.slice(separator + 1).trim().toLowerCase().replace(/\s*!important\s*$/u, '')
      return (property === 'display' && value === 'none')
        || (property === 'visibility' && (value === 'hidden' || value === 'collapse'))
    })
  },
  replacement() {
    return ''
  },
})

/**
 * Write a form control's value into the Markdown.
 *
 * Turndown walks text nodes, and `<input>` has none — its content is a `value`
 * attribute — so a settings page converted to bare labels with every setting
 * missing. Sharing `controlValue` with the extractor keeps one policy for what
 * counts as readable across both paths.
 */
turndown.addRule('formControlValue', {
  filter(node) {
    return node.nodeName === 'INPUT' || node.nodeName === 'TEXTAREA'
  },
  replacement(content, node) {
    // A textarea already converts its own text node; only the empty ones need
    // the attribute fallback, which `content` being blank reveals.
    if (content.trim() !== '') return content
    const read = (name: string) => node.getAttribute(name)
    const value = controlValue(read)
    return value === '' ? '' : ` ${value} `
  },
})

/** Render one GFM table cell without interpreting HTML span counts. */
function renderTableCell(content: string, index: number): string {
  const prefix = index === 0 ? '| ' : ' '
  const escaped = content.trim().replace(/\n\r/g, '<br>').replace(/\n/g, '<br>').replace(/\|+/g, '\\|').padEnd(3, ' ')
  return `${prefix}${escaped} |`
}

/** Whether a row is the table's Markdown heading row. */
function isTableHeadingRow(row: HTMLTableRowElement): boolean {
  const cells = Array.from(row.cells)
  const section = row.parentElement as HTMLTableSectionElement
  const table = section.parentElement as HTMLTableElement
  return (section.nodeName === 'THEAD' || table.rows[0] === row)
    && cells.every(cell => cell.nodeName === 'TH')
}

/** Map an HTML table-cell alignment to the GFM separator marker. */
function tableBorder(cell: HTMLTableCellElement): string {
  const alignment = (cell.getAttribute('align') || cell.style.textAlign || '').toLowerCase()
  if (alignment === 'left') return ':---'
  if (alignment === 'right') return '---:'
  if (alignment === 'center') return ':---:'
  return '---'
}

turndown.addRule('tableCellWithoutSpanExpansion', {
  filter: ['th', 'td'],
  replacement(content, node) {
    const cell = node as HTMLTableCellElement
    const row = cell.parentNode as HTMLTableRowElement
    // GFM cannot represent spanning cells. Ignoring colspan keeps conversion
    // work and output proportional to the source instead of the numeric attribute.
    return renderTableCell(content, Array.prototype.indexOf.call(row.childNodes, cell))
  },
})
turndown.addRule('tableRowWithoutSpanExpansion', {
  filter: 'tr',
  replacement(content, node) {
    const row = node as HTMLTableRowElement
    const border = isTableHeadingRow(row)
      ? Array.from(row.cells, (cell, index) => renderTableCell(tableBorder(cell), index)).join('')
      : ''
    return `\n${content}${border.length > 0 ? `\n${border}` : ''}`
  },
})

/**
 * Count a table's columns from the DOM, deliberately not expanding `colspan`.
 *
 * Matches {@link renderTableCell}: cells are emitted per source cell, so the
 * count here is the count Markdown will get. A raw-text cell *(below)* emits
 * pipes that look like columns but are escaped, so counts stay honest.
 */
function tableColCount(table: HTMLTableElement): number {
  let max = 0
  for (const row of Array.from(table.rows)) max = Math.max(max, row.cells.length)
  return max
}

/**
 * Override GFM's `table` rule, whose fallback ruins whole tables.
 *
 * The plugin decides a table holding certain block content cannot be Markdown,
 * and emits `node.outerHTML` — the entire table as raw markup — wrapped in
 * `<div class="joplin-table-wrapper">`. Reasonable for a note-taking app whose
 * renderer re-parses HTML; wrong here, where the output goes to a model's
 * context or a search index and arrives as one opaque blob tagged with a
 * private class name.
 *
 * The cell and row rules above already produce a valid GFM table, so there is
 * no case left where falling back to source beats a slightly flattened one.
 */
/**
 * Whether any descendant carries this tag name.
 *
 * Hand-rolled rather than `querySelector`, because the DOM turndown walks
 * answers selectors loosely: asking a plain two-cell `<table>` for
 * `querySelector('table')` returns its own `<tbody>`, and asking a table with no
 * caption for `querySelector('caption')` returns something too. Every table
 * therefore looked nested, which silently disabled the whole rule.
 */
function hasDescendant(node: unknown, tag: string): boolean {
  const children = (node as { childNodes?: ArrayLike<unknown> }).childNodes
  if (children === undefined) return false
  for (const child of Array.from(children)) {
    if ((child as { nodeName?: string }).nodeName === tag) return true
    if (hasDescendant(child, tag)) return true
  }
  return false
}

/**
 * Text of a direct child by tag name, or `''` when absent.
 *
 * `<caption>` is only ever a direct child of `<table>`, so no descent is needed
 * — which also avoids the mis-selecting described in {@link hasDescendant}.
 */
function directChildText(node: unknown, tag: string): string {
  const children = (node as { childNodes?: ArrayLike<unknown> }).childNodes
  if (children === undefined) return ''
  for (const child of Array.from(children)) {
    if ((child as { nodeName?: string }).nodeName === tag) {
      return ((child as { textContent?: string }).textContent ?? '').replace(/\s+/g, ' ').trim()
    }
  }
  return ''
}

/** Matches a GFM column-divider row, whatever alignment marks it carries. */
const DIVIDER_ROW = /^\s*\|?\s*:?-{3,}:?\s*\|/

turndown.addRule('tableWithoutHtmlFallback', {
  filter: 'table',
  replacement(content, node) {
    const table = node as HTMLTableElement
    // Nested tables have no Markdown form; the inner table converted itself.
    if (hasDescendant(table, 'TABLE')) return content
    // A lone cell is a layout box, not data.
    if (table.rows.length === 1 && tableColCount(table) <= 1) return content

    const lines = content.replace(/\n+/g, '\n').trim()
    if (lines === '') return ''

    const rows = lines.split('\n')
    if (!DIVIDER_ROW.test(rows[1] ?? '')) {
      // No heading row was authored, and GFM tables require one. Supply a blank
      // header rather than dropping the table the way the plugin does.
      const columns = tableColCount(table)
      if (columns === 0) return content
      rows.unshift(`|${'     |'.repeat(columns)}`, `|${' --- |'.repeat(columns)}`)
    }

    // GFM's own caption rule erases the caption from `content`, so read it back
    // from the document rather than losing it.
    const caption = directChildText(table, 'CAPTION')
    return `\n\n${caption !== '' ? `${caption}\n\n` : ''}${rows.join('\n')}\n\n`
  },
})
const MAX_CONVERSION_DEPTH = 512

/** Elements that never take a closing tag, so they do not grow the lexical stack. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** Elements whose contents HTML parses as text until their matching end tag. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'noscript'])

/** Whether a character can occur after a raw-text end-tag name. */
function isTagBoundary(char: string | undefined): boolean {
  return char === undefined || char === '>' || char === '/' || /\s/.test(char)
}

/** Find the matching raw-text end tag without interpreting markup-like body text. */
function findRawTextEnd(lowerHtml: string, name: string, from: number): number {
  const prefix = `</${name}`
  let candidate = lowerHtml.indexOf(prefix, from)
  while (candidate !== -1 && !isTagBoundary(lowerHtml[candidate + prefix.length])) {
    candidate = lowerHtml.indexOf(prefix, candidate + prefix.length)
  }
  return candidate
}

/** Lexically scan for nesting deeper than {@link MAX_CONVERSION_DEPTH}. */
export function exceedsConversionDepth(html: string): boolean {
  const lowerHtml = html.toLowerCase()
  const openElements: string[] = []
  let offset = 0
  let inComment = false

  while (offset < html.length) {
    const start = html.indexOf('<', offset)
    if (inComment) {
      const end = html.indexOf('-->', offset)
      if (end !== -1 && (start === -1 || end < start)) {
        inComment = false
        offset = end + 3
        continue
      }
    }
    if (start === -1) break
    if (!inComment && html.startsWith('<!--', start)) {
      inComment = true
      offset = start + 4
      continue
    }

    let cursor = start + 1
    const closing = html[cursor] === '/'
    if (closing) cursor += 1
    const nameStart = cursor
    while (/[a-zA-Z0-9-]/.test(html[cursor] ?? '')) cursor += 1
    if (cursor === nameStart || !/[a-zA-Z]/.test(html.charAt(nameStart))) {
      offset = start + 1
      continue
    }

    const name = lowerHtml.slice(nameStart, cursor)
    let quote: '"' | "'" | undefined
    while (cursor < html.length) {
      const char = html[cursor]
      cursor += 1
      if (quote !== undefined) {
        if (char === quote) quote = undefined
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        break
      }
    }
    if (html[cursor - 1] !== '>') break

    if (closing) {
      if (!inComment && openElements.at(-1) === name) openElements.pop()
    } else {
      let last = cursor - 2
      while (/\s/.test(html.charAt(last))) last -= 1
      if (!VOID_ELEMENTS.has(name) && html[last] !== '/') {
        openElements.push(name)
        if (openElements.length > MAX_CONVERSION_DEPTH) return true
        if (!inComment && RAW_TEXT_ELEMENTS.has(name)) {
          const end = findRawTextEnd(lowerHtml, name, cursor)
          if (end === -1) break
          offset = end
          continue
        }
      }
    }
    offset = cursor
  }
  return false
}

/** Marker substituted when HTML cannot be converted safely. */
export const OMISSION_MARKER = '[HTML content omitted: unable to convert safely.]'

export interface RenderedBody {
  /** Converted text, or the omission marker when conversion is unsafe. */
  readonly text: string
  /** Whether the source was cut before conversion to bound synchronous work. */
  readonly sourceTruncated: boolean
}

/**
 * Convert one fetched body to model-visible text, bounded to `maxInputChars`
 * of source.
 */
export function renderBody(body: WebFetchBody, maxInputChars: number): RenderedBody {
  const content = body.content.slice(0, maxInputChars)
  const sourceTruncated = content.length !== body.content.length
  switch (body.kind) {
    case 'html':
      if (exceedsConversionDepth(content)) return { text: OMISSION_MARKER, sourceTruncated }
      try {
        return { text: turndown.turndown(content), sourceTruncated }
      } catch {
        // turndown's DOM walk recurses per element; malformed markup the lexical
        // guard cannot model can still throw RangeError.
        return { text: OMISSION_MARKER, sourceTruncated }
      }
    case 'text':
      return { text: content, sourceTruncated }
    /* v8 ignore next 2 -- WebFetchBody is a closed union; unreachable, and only makes a new kind a compile error. */
    default:
      return assertNever(body, 'unhandled web fetch body kind')
  }
}

/** Exhaustiveness guard for closed unions. */
export function assertNever(value: never, message: string): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`)
}
