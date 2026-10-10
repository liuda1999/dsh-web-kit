/**
 * Markdown rendering, especially the tables that used to arrive as raw HTML.
 *
 * The GFM plugin decides that a table holding certain block content cannot be
 * Markdown and emits the whole `<table>` as source markup wrapped in a private
 * `<div class="joplin-table-wrapper">`. Fine for a note app that re-parses
 * HTML; wrong for anything feeding a model or an index. These tests pin the
 * replacement, including the cases where the fix could have "won" by simply
 * deleting the table — hence every case also asserts the content survived.
 *
 * Runs offline against `dist/`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const DIST = new URL('../dist/', import.meta.url).href
const { renderBody } = await import(DIST + 'tools/html.js')

/** Render a fragment to trimmed Markdown. */
function md(html) {
  return renderBody({ kind: 'html', content: html }, 1_000_000).text.trim()
}

/** Source markup leaked into the output — the exact thing being prevented. */
function assertNoMarkupBlob(text, label) {
  assert.doesNotMatch(text, /joplin-table-wrapper/, `${label}: GFM wrapper div leaked`)
  assert.doesNotMatch(text, /<table|<tbody|<thead|<tr>|<th>|<div class=/i, `${label}: raw HTML table leaked`)
}

/** A GFM table only exists as a table if the divider row does. */
function assertIsGfmTable(text, label) {
  assert.match(text, /^\s*\|[\s:|-]+\|\s*$/m, `${label}: no divider row, so no Markdown table`)
}

/** Every row rendered by these helpers starts and ends with a pipe. */
function countRows(text) {
  return text.split('\n').filter(line => line.trimStart().startsWith('|')).length
}

const TABLE_CASES = {
  // Each of these triggers GFM's "must stay HTML" verdict: UL/OL, headings, HR,
  // and BLOCKQUOTE are all on its list.
  'list in cell': {
    html: '<table><tr><th>Item</th><th>Note</th></tr><tr><td><ul><li>alpha</li><li>beta</li></ul></td><td>kept</td></tr></table>',
    expectContent: ['alpha', 'beta', 'kept', 'Item'],
  },
  'heading in cell': {
    html: '<table><tr><th>Opt</th></tr><tr><td><h3>Deployment tier</h3></td></tr></table>',
    expectContent: ['Deployment tier'],
  },
  'hr in cell': {
    html: '<table><tr><th>Opt</th></tr><tr><td>above<hr>below</td></tr></table>',
    expectContent: ['above', 'below'],
  },
  'blockquote in cell': {
    html: '<table><tr><th>Note</th></tr><tr><td><blockquote>quoted policy</blockquote></td></tr></table>',
    expectContent: ['quoted policy'],
  },
  'fenced code in cell': {
    html: '<table><tr><th>Opt</th></tr><tr><td><pre><code>npm run check</code></pre></td></tr></table>',
    expectContent: ['npm run check'],
  },
  'ordered list in cell': {
    html: '<table><tr><th>Steps</th></tr><tr><td><ol><li>first do this</li></ol></td></tr></table>',
    expectContent: ['first do this'],
  },
  'no heading row': {
    html: '<table><tr><td>alpha row</td><td>1</td></tr><tr><td>beta row</td><td>2</td></tr></table>',
    expectContent: ['alpha row', 'beta row'],
  },
  'with caption': {
    html: '<table><caption>Server tiers</caption><tr><th>Tier</th></tr><tr><td>gold</td></tr></table>',
    expectContent: ['Server tiers', 'gold'],
  },
  'nested table': {
    html: '<table><tr><th>Outer</th></tr><tr><td><table><tr><td>inner cell</td><td>b</td></tr></table></td></tr></table>',
    expectContent: ['inner cell'],
  },
  'plain thead': {
    html: '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tr><td>alpha-headed</td><td>7</td></tr></table>',
    expectContent: ['alpha-headed', 'Name', 'Value'],
  },
}

test('tables holding block content convert to Markdown, not to source markup', () => {
  for (const [name, spec] of Object.entries(TABLE_CASES)) {
    const text = md(spec.html)
    assertNoMarkupBlob(text, name)
    for (const needle of spec.expectContent) {
      assert.match(text, RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name}: lost "${needle}"`)
    }
  }
})

test('every overflow table still produces a real GFM table', () => {
  // Excluding the deliberately non-tabular shapes below.
  const tabular = { ...TABLE_CASES }
  delete tabular['single cell is not a table']
  for (const [name, spec] of Object.entries(tabular)) {
    const text = md(spec.html)
    if (/^\s*\|/.test(text)) assertIsGfmTable(text, name)
  }
})

test('a table with no authored heading row gets an empty one, not no table', () => {
  const text = md(TABLE_CASES['no heading row'].html)
  assertIsGfmTable(text, 'no heading row')
  // Header + divider + two data rows.
  assert.equal(countRows(text), 4, `expected 4 rows, got:\n${text}`)
})

test('colspan is still not expanded into invented cells', () => {
  const wide = '<table><tr><th>Head</th></tr><tr><td colspan="3">spanning value</td></tr></table>'
  const text = md(wide)
  assertNoMarkupBlob(text, 'colspan')
  assert.match(text, /spanning value/)
  // One cell in, one cell out: no fabricated empty columns.
  assert.equal(text.split('\n')[1]?.trim().split('|').filter(part => part.trim() !== '').length, 1)
})

test('a single-cell table stays content rather than becoming a one-row table', () => {
  const box = '<table><tr><td>lone value</td></tr></table>'
  const text = md(box)
  assert.match(text, /lone value/)
  assertNoMarkupBlob(text, 'single cell')
})

test('the real IANA-style table page renders with no markup residue', () => {
  const page = readFileSync(new URL('./fixtures/complex-table-heavy.html', import.meta.url), 'utf8')
  const text = md(page)
  assertNoMarkupBlob(text, 'IANA-style page')
  assert.match(text, /reserved-names policy/, 'policy prose survived')
  assert.match(text, /Best Current Practice/, 'table data survived')
})

test('non-tabular Markdown still behaves', () => {
  const page = '<h2>Heading</h2><p>Body with <em>emphasis</em> and <code>inline</code>.</p>'
    + '<pre><code>block = true</code></pre><ul><li>bullet one</li></ul>'
  const text = md(page)
  assert.match(text, /^## Heading$/m)
  assert.match(text, /_emphasis_/)
  assert.match(text, /```[\s\S]*block = true[\s\S]*```/)
  assert.match(text, /^-\s+bullet one$/m)
})
