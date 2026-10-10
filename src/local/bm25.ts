/**
 * BM25 over locally stored documents, with Chinese-aware tokenisation.
 *
 * There is no segmenter dependency here. Chinese is handled the standard
 * no-dictionary way: emit every character **and** every adjacent bigram. Bigrams
 * carry most of the discriminative signal (`上海` beats either character alone),
 * and unigrams keep short queries from missing. Latin text is tokenised on
 * word boundaries. The result is not as good as a real segmenter and does not
 * try to be; it is good enough to find a page you already fetched.
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/local/bm25
 */

/** Term-frequency map for one document. */
export type TermFrequencies = ReadonlyMap<string, number>

/** A document prepared for scoring. */
export interface IndexedDoc {
  readonly id: string
  readonly terms: TermFrequencies
  readonly length: number
}

/** BM25 tuning parameters. */
export interface Bm25Options {
  /** Term-frequency saturation. Default `1.5`. */
  readonly k1?: number
  /** Length normalisation strength. Default `0.75`. */
  readonly b?: number
  /** Upper bound on returned hits. Default `10`. */
  readonly limit?: number
}

/** A scored hit. */
export interface Bm25Hit {
  readonly id: string
  readonly score: number
}

/** CJK unified ideographs (extension A excluded for brevity of matching). */
const CJK_RUN = /[㐀-鿿豈-﫿]+/g
/** Latin words and numbers. */
const LATIN_WORD = /[a-z0-9]+/g

/** Options for {@link tokenize}. */
export interface TokenizeOptions {
  /**
   * Also emit single CJK characters. Default `false`.
   *
   * Measured: with unigrams on, the query `量子计算 股票` matched a document
   * that merely contained `量` (in 量化) and another containing `计` (in 设计) —
   * two hits for a query with nothing to do with either. Single Chinese
   * characters are too common to discriminate anything, so they are off unless
   * you explicitly want the recall.
   */
  readonly unigrams?: boolean
}

/**
 * Split text into index terms: latin words, and CJK bigrams.
 *
 * Single characters are excluded unless `unigrams` asks for them — including a
 * lone Han character. Indexing every isolated 的 or 了 links nearly every
 * Chinese document to nearly every Chinese query, which is precisely why the
 * unigram option exists; a run of one is not a reason to bypass it.
 */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const lower = text.toLowerCase()
  const out: string[] = []
  const unigrams = options.unigrams ?? false

  for (const match of lower.matchAll(LATIN_WORD)) {
    out.push(match[0])
  }
  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0]
    if (run.length === 1) {
      if (unigrams) out.push(run)
      continue
    }
    for (let i = 0; i < run.length; i++) {
      if (unigrams) {
        const char = run[i]
        if (char !== undefined) out.push(char)
      }
      const bigram = run.slice(i, i + 2)
      if (bigram.length === 2) out.push(bigram)
    }
  }
  return out
}

/** Build a term-frequency map from tokens. */
export function termFrequencies(tokens: readonly string[]): TermFrequencies {
  const counts = new Map<string, number>()
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

/** Prepare a document for repeated scoring. */
export function indexDoc(id: string, tokens: readonly string[]): IndexedDoc {
  return { id, terms: termFrequencies(tokens), length: tokens.length }
}

/**
 * Rank documents against a query using BM25.
 *
 * Documents that match none of the query terms score 0 and are dropped, so an
 * unrelated corpus returns nothing rather than noise.
 */
export function bm25(docs: readonly IndexedDoc[], queryTokens: readonly string[], options: Bm25Options = {}): Bm25Hit[] {
  const k1 = options.k1 ?? 1.5
  const b = options.b ?? 0.75
  const limit = options.limit ?? 10
  if (docs.length === 0 || queryTokens.length === 0) return []

  const queryTerms = [...new Set(queryTokens)]
  const totalLength = docs.reduce((sum, doc) => sum + doc.length, 0)
  const avgLength = totalLength / docs.length

  const documentFrequency = new Map<string, number>()
  for (const term of queryTerms) {
    let df = 0
    for (const doc of docs) {
      if ((doc.terms.get(term) ?? 0) > 0) df += 1
    }
    documentFrequency.set(term, df)
  }

  const hits: Bm25Hit[] = []
  for (const doc of docs) {
    let score = 0
    for (const term of queryTerms) {
      const tf = doc.terms.get(term) ?? 0
      if (tf === 0) continue
      const df = documentFrequency.get(term) ?? 0
      // IDF can go non-positive when a term appears in every document; clamped
      // so a stopword contributes a small positive amount instead of penalising.
      const idf = Math.max(0.1, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)))
      const denominator = tf + k1 * (1 - b + (b * doc.length) / (avgLength || 1))
      score += (idf * (tf * (k1 + 1))) / (denominator || 1)
    }
    if (score > 0) hits.push({ id: doc.id, score })
  }

  hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  return hits.slice(0, limit)
}

/**
 * Build a readable excerpt around the query terms.
 *
 * @returns up to `window` characters centred on the first term match, or the
 *   document head when no term appears verbatim.
 */
export function excerpt(text: string, queryTokens: readonly string[], window = 240): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= window) return collapsed

  const lower = collapsed.toLowerCase()
  // Prefer longer terms: a bigram match is a far better anchor than a single
  // character that appears everywhere.
  const candidates = [...new Set(queryTokens)].sort((a, b) => b.length - a.length)
  for (const term of candidates) {
    const at = lower.indexOf(term.toLowerCase())
    if (at >= 0) {
      const start = Math.max(0, at - Math.floor(window / 3))
      const slice = collapsed.slice(start, start + window)
      return `${start > 0 ? '…' : ''}${slice}${start + window < collapsed.length ? '…' : ''}`
    }
  }
  return `${collapsed.slice(0, window)}…`
}
