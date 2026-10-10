/**
 * Regression tests for page extraction on structurally complex pages.
 *
 * Earlier fixtures were hand-written paragraphs: every page was `<p>` text with
 * a little chrome around it. Nothing exercised a table cell, an image, or a form
 * control — and those are exactly the pages that lose content, because their
 * text does not live in text nodes. These fixtures are the missing cases.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Resolved as URLs: this repository can sit under a path with non-ASCII
// directories, which trips the relative specifier resolver.
const DIST = new URL('../dist/', import.meta.url)
const { extractMainContent, cleanPageHtml, EXTRACT_MODES } = await import(DIST + 'filter/extract.js')
const { renderBody } = await import(DIST + 'tools/html.js')

const fixtures = new URL('./fixtures/', import.meta.url)
const load = (name) => readFileSync(fileURLToPath(new URL(name, fixtures)), 'utf8')

/** All four modes, loosest to strictest. */
const ALL_MODES = ['full', 'gentle', 'standard', 'aggressive']

/**
 * The cases, as declarative expectations.
 *
 * `required` is keyed by what its presence proves, so a failure names the
 * content type that regressed rather than a line number. `modes` names the modes
 * that must keep everything — the stricter ones intentionally drop whole
 * categories, and there are separate tests for that.
 */
const CASES = [
  {
    name: 'API reference: tables, code block, definition list, details',
    file: 'complex-api-reference.html',
    modes: ['full', 'gentle', 'standard', 'aggressive'],
    required: {
      'table row': /frequency_penalty/,
      'table footnote (colspan)': /HTTP 400 before scheduling/,
      'code block': /Authorization: Bearer/,
      'definition term': /Nucleus sampling cutoff/,
      'details summary': /Why the range is narrower/,
      'details body': /KV cache/,
      'concluding prose': /validated before the request reaches/,
    },
    // Chrome every mode must remove: it is either unexecuted code or an ad.
    forbidden: {
      'tracking script': /trackingPixel/,
      'ad slot': /Sponsored placement/,
    },
  },
  {
    name: 'Illustrated article: figures, captions, inline SVG diagram',
    file: 'complex-illustrated.html',
    // `standard` deliberately drops embedded media, so SVG labels are not
    // expected to survive it — see the category-dropping test below.
    modes: ['full', 'gentle'],
    required: {
      'image alt': /three worker lanes draining one bounded queue/,
      'figcaption': /Figure 1:/,
      'picture source fallback': /Figure 2:/,
      'svg text labels': /IngestStage/,
      'svg third label': /DrainStage/,
      'second image alt': /exponential backoff and jitter/,
      'surrounding prose': /idempotent end to end/,
      'closing prose': /dead letter queue and an operator alert/,
    },
    forbidden: {},
  },
  {
    name: 'Settings console: form controls hold the entire page body',
    file: 'complex-settings-console.html',
    // `aggressive` is the one mode allowed to drop this genre outright.
    modes: ['full', 'gentle', 'standard'],
    required: {
      'field label': /Bind host/,
      'input value': /127\.0\.0\.1/,
      'second input value': /8080/,
      'placeholder fallback': /https:\/\/upstream\.example\.com/,
      'select options': /throughput/,
      'select sibling option': /latency/,
      'textarea body': /Rotated the upstream certificate/,
      'submit button': /Save changes/,
      'field group legend': /Scheduling/,
    },
    forbidden: {
      // Recovered values must never include hidden inputs: that is where
      // frameworks park CSRF tokens and secrets.
      'csrf token': /8f14e45fceea167a5a36dedd4bea2543/,
      'hidden revision': /7719/,
      'password value': /super-secret-value/,
    },
  },
  {
    name: 'Embedded media: iframe sample, captions, canvas fallback',
    file: 'complex-media-embed.html',
    modes: ['full', 'gentle'],
    required: {
      'iframe title': /Resizable two column grid sample/,
      'caption track label': /English captions/,
      'second caption track': /Chinese captions/,
      'canvas fallback text': /does not support the canvas preview/,
      'prose after embed': /reproduce the sample/,
      'closing prose': /starting from an unstyled list/,
    },
    forbidden: {},
  },
  {
    name: 'Dashboard: several equal-weight sections, no single article',
    file: 'complex-dashboard.html',
    modes: ['full', 'gentle', 'standard', 'aggressive'],
    required: {
      'metric card': /Nodes reporting/,
      'metric value': /99\.2%/,
      'alert table row': /Disk pressure above ninety percent/,
      'alert table second row': /Certificate expires in nine days/,
      'activity list item': /rebalanced four shards/,
      'runbook note': /on-call rotation/,
    },
    forbidden: {},
  },
]

/** Run one case in one mode and report what went missing. */
function runCase(testCase, mode) {
  const html = load(testCase.file)
  const result = extractMainContent(html, { mode })
  const missing = Object.entries(testCase.required)
    .filter(([, pattern]) => !pattern.test(result.text))
    .map(([label]) => label)
  const leaked = Object.entries(testCase.forbidden ?? {})
    .filter(([, pattern]) => pattern.test(result.text))
    .map(([label]) => label)
  return { result, missing, leaked }
}

test('complex pages keep the content their structure hides', () => {
  for (const testCase of CASES) {
    for (const mode of testCase.modes) {
      const { missing, leaked } = runCase(testCase, mode)
      assert.deepEqual(missing, [], `${testCase.name} [${mode}] lost: ${missing.join(', ')}`)
      assert.deepEqual(leaked, [], `${testCase.name} [${mode}] leaked: ${leaked.join(', ')}`)
    }
  }
})

test('extraction never returns less than the core prose, in any mode', () => {
  for (const testCase of CASES) {
    for (const mode of ALL_MODES) {
      const result = extractMainContent(load(testCase.file), { mode })
      assert.ok(result.text.length > 0, `${testCase.name} [${mode}] came back empty`)
      assert.equal(result.mode, mode)
    }
  }
})

test('the modes are nested: a stricter mode never keeps what a looser one dropped', () => {
  // Inferred from behaviour rather than from the spec table, so adding a mode
  // that breaks monotonicity fails here even if someone forgets to update it.
  for (const testCase of CASES) {
    const kept = new Map(ALL_MODES.map(mode => {
      const { result } = runCase(testCase, mode)
      const surviving = Object.entries(testCase.required)
        .filter(([, pattern]) => pattern.test(result.text))
        .map(([label]) => label)
      return [mode, new Set(surviving)]
    }))
    for (let i = 1; i < ALL_MODES.length; i += 1) {
      const looser = kept.get(ALL_MODES[i - 1])
      const stricter = kept.get(ALL_MODES[i])
      for (const label of stricter) {
        assert.ok(looser.has(label),
          `${testCase.name}: ${ALL_MODES[i]} keeps "${label}" but ${ALL_MODES[i - 1]} drops it`)
      }
    }
  }
})

test('mode `full` keeps every content category: it removes nothing but unrenderable tags', () => {
  // The specific contract it used to break: `full` advertised "no cropping, no
  // guessing" while a hard-coded drop-list silently deleted every form control,
  // SVG label and iframe title on the page.
  const full = EXTRACT_MODES.full
  assert.equal(full.crop, false)
  assert.equal(full.chromeHeuristics, false)
  assert.equal(full.semanticTags, false)
  assert.equal(full.includeImages, true)
  assert.equal(full.includeForms, true)
  assert.equal(full.includeMedia, true)

  const { result } = runCase(CASES[2], 'full')
  assert.match(result.text, /127\.0\.0\.1/, 'form values survive even in `full`')
  assert.equal(result.picked, null, 'and `full` still does not crop')
})

test('stricter modes progressively discard whole categories, not individual pages', () => {
  const page = load('complex-illustrated.html')
  const gentle = extractMainContent(page, { mode: 'gentle' }).text
  const standard = extractMainContent(page, { mode: 'standard' }).text
  const aggressive = extractMainContent(page, { mode: 'aggressive' }).text

  assert.match(gentle, /IngestStage/, 'gentle keeps SVG labels')
  assert.doesNotMatch(standard, /IngestStage/, 'standard drops embedded media')
  // Matched on the alt text only. The caption repeats the same words, so
  // asserting on the shared phrase would pass while proving nothing.
  assert.doesNotMatch(aggressive, /Pipeline with/, 'aggressive drops image alt text')
  assert.match(aggressive, /Figure 1:/, 'but a caption is words, so it stays')
  assert.match(aggressive, /idempotent end to end/, 'and never the prose')

  const form = load('complex-settings-console.html')
  assert.doesNotMatch(
    extractMainContent(form, { mode: 'aggressive' }).text,
    /127\.0\.0\.1/,
    'aggressive drops form values — that is what it is for',
  )
})

test('per-category overrides reclaim one category without inventing a mode', () => {
  const page = load('complex-settings-console.html')
  const strict = extractMainContent(page, { mode: 'aggressive' })
  const reclaimed = extractMainContent(page, { mode: 'aggressive', includeForms: true })

  assert.doesNotMatch(strict.text, /127\.0\.0\.1/)
  assert.match(reclaimed.text, /127\.0\.0\.1/, 'one flag restores the whole genre')
  assert.doesNotMatch(reclaimed.text, /8f14e45fceea167a5a36dedd4bea2543/, 'without leaking hidden inputs')

  const illustrated = load('complex-illustrated.html')
  const media = extractMainContent(illustrated, { mode: 'standard', includeMedia: true })
  assert.match(media.text, /IngestStage/, 'and the same applies to media')
})

test('malformed and truncated complex pages degrade instead of throwing', () => {
  assert.doesNotThrow(() => extractMainContent('<table><tr><td>unclosed cell', { mode: 'gentle' }))
  assert.doesNotThrow(() => extractMainContent('<figure><figcaption>no closing svg', { mode: 'gentle' }))
  // Truncation inside a script used to leave 50 KB of JavaScript reading as prose.
  const truncated = `<script>var x = {${'a:1,'.repeat(2000)}</script><p>Real sentence after truncation.</p>`
  const result = extractMainContent(truncated, { mode: 'gentle' })
  assert.doesNotMatch(result.text, /a:1,/)
  assert.match(result.text, /Real sentence after truncation/)
})

test('nested void elements inside dropped subtrees do not resurrect text', () => {
  const html = '<html><body><nav><img src="/spacer.gif" alt="Nav decoration image"></nav><main><p>Body prose.</p></main></body></html>'
  const result = extractMainContent(html, { mode: 'gentle' })
  assert.doesNotMatch(result.text, /Nav decoration image/, 'chrome is removed with its contents')
  assert.match(result.text, /Body prose/)
})

test('the Markdown path keeps images and form values too', () => {
  // The index path is not the only consumer: `web_fetch` renders Markdown, and
  // `<input>` has no text node for Turndown to walk.
  const form = renderBody({ kind: 'html', content: load('complex-settings-console.html') }, 200000)
  assert.match(form.text, /127\.0\.0\.1/, 'input values reach the model')
  assert.match(form.text, /throughput/, 'options reach the model')
  assert.doesNotMatch(form.text, /8f14e45fceea167a5a36dedd4bea2543/, 'hidden fields never do')

  const illustrated = renderBody({ kind: 'html', content: load('complex-illustrated.html') }, 200000)
  assert.match(illustrated.text, /!\[Pipeline with three worker lanes/, 'images reach the model as Markdown images')
  assert.match(illustrated.text, /IngestStage/, 'including SVG labels')

  const reference = renderBody({ kind: 'html', content: load('complex-api-reference.html') }, 200000)
  // Turndown escapes underscores, which is why the cell reads `frequency\_penalty`.
  assert.match(reference.text, /\| temperature \| float \| 0\.7 \|/, 'tables stay tables')
  assert.match(reference.text, /```[\s\S]*?Authorization: Bearer/, 'code stays fenced')
  // Note what this does not assert: `renderBody` converts the fetched body as
  // fetched, and this module's cleaning is not in its path — so the model still
  // sees the page's own chrome. `extractMainContent` exists to feed the local
  // index; routing `web_fetch` through it too would be a separate decision.
})

test('cleaning the HTML still leaves the image there — only its text view drops', () => {
  // Deliberate asymmetry. `includeImages` governs whether alt text is *read*
  // into the plain text; it does not delete `<img>` from the HTML, because a
  // later Markdown conversion can still render it. Removing it would be
  // irreversible, and this module's rule is that it may never return less.
  const page = load('complex-illustrated.html')
  assert.match(cleanPageHtml(page, { mode: 'gentle' }), /alt="Pipeline with/)
  assert.match(
    cleanPageHtml(page, { mode: 'aggressive' }),
    /alt="Pipeline with/,
    'even a mode that drops images from the text keeps the source tag',
  )
  assert.doesNotMatch(
    cleanPageHtml(page, { mode: 'gentle' }),
    /<nav/,
    'while declared chrome really is removed',
  )
  assert.doesNotMatch(
    extractMainContent(page, { mode: 'aggressive' }).text,
    /Pipeline with/,
    'and the text view reflects the mode',
  )
})
