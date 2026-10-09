/**
 * Shared HTML text helpers for the scraping search providers.
 * NEW CODE — not present in DeepSeek Harness.
 * @module dsh-web-kit/search/html-text
 */

/** Named entities that appear in search result text. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ensp;': ' ',
  '&emsp;': ' ',
  '&hellip;': '…',
  '&mdash;': '—',
  '&ndash;': '–',
  '&middot;': '·',
}

/** Remove every tag, leaving the text content. */
export function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, '')
}

/** Decode named and numeric HTML entities, then strip any remaining tags. */
export function decodeEntities(input: string): string {
  let text = input.replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
    const code = Number.parseInt(hex, 16)
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
  })
  text = text.replace(/&#(\d+);/g, (_match, dec: string) => {
    const code = Number.parseInt(dec, 10)
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
  })
  for (const [entity, replacement] of Object.entries(NAMED_ENTITIES)) {
    text = text.split(entity).join(replacement)
  }
  return stripTags(text).replace(/\s+/g, ' ').trim()
}

/** Collapse whitespace without touching entities or tags. */
export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}
