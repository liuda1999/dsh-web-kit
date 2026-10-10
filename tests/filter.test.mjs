// Content filtering, page extraction, and local index — all offline except one
// stub-server test. These are regression tests: the behaviour they pin down was
// found by measurement, not by reasoning.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'


import {
  canonicalUrl,
  cleanPageHtml,
  CachingFetchProvider,
  DEFAULT_EXTRACT_MODE,
  DEFAULT_FILTER_LEVEL,
  describeFilter,
  DocStore,
  EXTRACT_MODES,
  extractMainContent,
  FILTER_LEVELS,
  filterSources,
  htmlTitle,
  isEngineLink,
  keywordHit,
  LocalIndexSearchProvider,
  resolveRules,
  scoreSource,
  sourceHost,
  survived,
  tokenize,
  bm25,
  indexDoc,
  excerpt,
} from '../dist/index.js'

const ARTICLE_HTML = `<!doctype html>
<html><head><title>Deploying locally</title><script>var tracking = 1;</script></head>
<body>
  <nav class="navbar">Home News Sports Weather</nav>
  <div class="ad-banner">Buy cheap things now buy buy buy</div>
  <div id="sidebar">Related related related</div>
  <article>
    <h1>Deploying locally</h1>
    <p>${'The article body explains how to run the model on a local machine with limited memory. '.repeat(6)}</p>
    <p>A second paragraph with more detail about quantisation and context windows and batching.</p>
  </article>
  <footer>Copyright 2026 footer footer footer</footer>
  <div class="comment-list">Comments from readers go here</div>
</body></html>`

test('canonicalUrl: strips tracking params, www, trailing slash', () => {
  assert.equal(
    canonicalUrl('https://www.Example.com/a/path/?utm_source=x&spm=y&keep=1#frag'),
    'https://example.com/a/path?keep=1',
  )
  assert.equal(canonicalUrl('https://a.com/x/'), 'https://a.com/x')
  assert.equal(canonicalUrl('not a url'), 'not a url')
})

test('sourceHost: drops a leading www', () => {
  assert.equal(sourceHost('https://www.baike.baidu.com/item/x'), 'baike.baidu.com')
  assert.equal(sourceHost('nonsense'), '')
})

test('isEngineLink: flags interstitials, keeps real content on engine hosts', () => {
  assert.equal(isEngineLink('https://www.baidu.com/link?url=abc'), true)
  assert.equal(isEngineLink('https://www.baidu.com/baidu.php?url=abc'), true)
  assert.equal(isEngineLink('https://cn.bing.com/search?q=x'), true)
  assert.equal(isEngineLink('https://www.google.com/url?q=x'), true)
  // Real content that merely lives on an engine host must survive.
  assert.equal(isEngineLink('https://baike.baidu.com/item/DeepSeek'), false)
  assert.equal(isEngineLink('https://github.com/a/b'), false)
})

test('isEngineLink: drops Baidu recommendation slots and ad-tech hosts', () => {
  // Measured, not assumed: driving Baidu over a browser and sampling five
  // queries put one of these **first** three times out of five — a placement
  // ranking above every real source, indistinguishable from a result unless
  // the host says otherwise.
  assert.equal(isEngineLink('http://28608.recommend_list.baidu.com'), true)
  assert.equal(isEngineLink('https://8451.recommend_list.baidu.com/s?q=x'), true)
  assert.equal(isEngineLink('http://pos.baidu.com/ad'), true)
  assert.equal(isEngineLink('https://cpro.baidu.com/x'), true)
})

test('filterSources: recommendation slots are dropped, neighbours survive', () => {
  const sources = [
    { url: 'http://28608.recommend_list.baidu.com', title: '推荐位', snippet: 'x' },
    { url: 'https://baike.baidu.com/item/量子计算', title: '量子计算', snippet: 'x' },
    { url: 'https://docs.python.org/3/library/asyncio.html', title: 'asyncio', snippet: 'x' },
  ]
  const result = filterSources(sources, {})
  assert.deepEqual(result.kept.map(s => s.url), [
    'https://baike.baidu.com/item/量子计算',
    'https://docs.python.org/3/library/asyncio.html',
  ])
  assert.equal(result.dropped.length, 1)
  assert.equal(result.dropped[0].reason, 'engine-link')
})

test('scoreSource: rewards a title, snippet and https; punishes junk', () => {
  const good = { url: 'https://a.com/doc.html', title: 'A full title here', snippet: 's'.repeat(100) }
  const bad = { url: 'http://a.com/tag/x', title: '', snippet: '', sponsored: true }
  assert.ok(scoreSource(good) > scoreSource(bad))
})

// ---------------------------------------------------------------------------
// Laxness guarantees.
//
// These exist because the previous version deleted anything it suspected, which
// is the wrong trade for a personal search tool: losing one real source costs
// more than seeing one poor one. Each test below names a specific thing that
// used to be removed and must now survive.
// ---------------------------------------------------------------------------

test('default level is loose: a missing title is NOT grounds for removal', () => {
  const rows = [
    { url: 'https://a.com/1', title: 'Has a title', snippet: 's' },
    { url: 'https://b.com/1', title: '', snippet: 'this row has no title at all' },
  ]
  const outcome = filterSources(rows)
  assert.equal(outcome.level, DEFAULT_FILTER_LEVEL)
  assert.equal(DEFAULT_FILTER_LEVEL, 'loose')
  assert.equal(outcome.dropped.length, 0)
  // It is not even relegated at this level: absent titles are common enough on
  // real SERP rows that treating them as a signal loses legitimate sources.
  assert.equal(outcome.demoted.length, 0)
  assert.equal(outcome.kept.length, 2)
})

test('level off: literally nothing is removed', () => {
  const rows = [
    { url: 'https://a.com/1', title: 'A', snippet: 's' },
    { url: 'https://a.com/1?utm_source=x', title: 'A', snippet: 'same page, tracked copy' },
    { url: 'https://www.baidu.com/link?url=abc', title: 'Wrapper', snippet: 's' },
    { url: 'https://ad.com/p', title: 'Buy now', snippet: 's', sponsored: true },
    { url: 'not a url at all', title: 'Broken', snippet: 's' },
  ]
  const outcome = filterSources(rows, { level: 'off' })
  assert.equal(outcome.kept.length, 5)
  assert.equal(outcome.demoted.length, 0)
  assert.equal(outcome.dropped.length, 0)
})

test('suspicious rows are relegated, not deleted — they still reach the model', () => {
  const rows = [
    { url: 'https://a.com/1', title: 'Clean one', snippet: 'a substantive snippet long enough to pass' },
    { url: 'https://b.com/1', title: '' },
    { url: 'https://c.com/1', title: 'Suspicious one', snippet: '' },
  ]
  const outcome = filterSources(rows, { level: 'balanced', minSnippetChars: 10 })
  assert.equal(outcome.dropped.length, 0, 'balanced must not drop anything')
  assert.equal(outcome.kept.length, 1)
  assert.equal(outcome.demoted.length, 2)
  assert.deepEqual(outcome.demoted.map(d => d.reason), ['no-title', 'short-snippet'])
  // Order: clean rows first, relegated ones behind them. Nothing is lost.
  assert.equal(survived(outcome).length, 3)
  assert.equal(survived(outcome)[0]?.url, 'https://a.com/1')
})

test('strict still removes: the levels differ only in what they are allowed to delete', () => {
  const rows = [
    { url: 'https://a.com/1', title: 'Clean one', snippet: 's' },
    { url: 'https://b.com/1', title: '' },
  ]
  const outcome = filterSources(rows, { level: 'strict' })
  assert.equal(outcome.kept.length, 1)
  assert.equal(outcome.dropped.length, 1)
  assert.equal(outcome.dropped[0]?.reason, 'no-title')
})

test('short boilerplate titles are never treated as duplicates', () => {
  // Two unrelated sites both titled "首页" are not one document. Before the
  // length floor existed, the second row here silently vanished.
  const rows = [
    { url: 'https://a.example/', title: '首页' },
    { url: 'https://b.example/', title: '首页' },
    { url: 'https://c.example/', title: 'Home' },
  ]
  const outcome = filterSources(rows, { level: 'strict' })
  assert.equal(outcome.dropped.length, 0)
  assert.equal(outcome.kept.length, 3)
})

test('real duplicate titles still collapse across levels', () => {
  const long = '如何在本地部署 DeepSeek 模型的完整指南与显存要求'
  const rows = [
    { url: 'https://a.example/p', title: long },
    { url: 'https://b.example/p', title: `${long}！` },
  ]
  assert.equal(filterSources(rows, { level: 'strict' }).kept.length, 1)
  const loose = filterSources(rows, { level: 'loose' })
  assert.equal(loose.kept.length, 1)
  assert.equal(loose.demoted.length, 1, 'loose keeps it, but behind the first')
  assert.equal(loose.dropped.length, 0, 'loose never drops it')
})

test('English keywords match on word boundaries so ad never hits read', () => {
  assert.equal(keywordHit('ad', 'How I read the ad slot'), true)
  assert.equal(keywordHit('ad', 'Threading made easy'), false)
  assert.equal(keywordHit('ad', 'A load-and-update pipeline'), false)
  assert.equal(keywordHit('spam', 'Email delivery report'), false)
  // CJK has no boundaries, so it stays a substring match.
  assert.equal(keywordHit('广告', '这是一篇关于广告投放的文章'), true)
})

test('no hard-coded site blocklist exists: an empty policy blocks nothing', () => {
  const rows = [
    { url: 'https://zhihu.com/p/1', title: 'A', snippet: 's' },
    { url: 'https://juejin.cn/post/1', title: 'B', snippet: 's' },
    { url: 'https://baike.baidu.com/item/x', title: 'C', snippet: 's' },
    { url: 'https://zh.wikipedia.org/wiki/x', title: 'D', snippet: 's' },
  ]
  for (const level of ['loose', 'balanced', 'strict']) {
    const outcome = filterSources(rows, { level })
    assert.equal(outcome.kept.length, 4, `level ${level} should not blacklist any site by itself`)
  }
})

test('allowed hosts are exempt from every soft rule', () => {
  const rows = [
    { url: 'https://trusted.example/1', title: 'First', snippet: 's' },
    { url: 'https://trusted.example/2', title: 'Second', snippet: 's' },
    { url: 'https://trusted.example/3', title: 'Third', snippet: 's' },
  ]
  // Without a policy, the host cap relegates everything after the first.
  const withoutPolicy = filterSources(rows, { level: 'balanced', maxPerHost: 1 })
  assert.equal(withoutPolicy.kept.length, 1)
  assert.equal(withoutPolicy.demoted.length, 2)

  // Explicitly trusting a host means "I want all of it".
  const allowed = filterSources(rows, { level: 'balanced', maxPerHost: 1, allowedHosts: ['trusted.example'] })
  assert.equal(allowed.kept.length, 3)
  assert.equal(allowed.demoted.length, 0)
  assert.equal(allowed.dropped.length, 0)
})

test('per-rule overrides beat the level, so one disagreement needs no new level', () => {
  const rows = [{ url: 'https://ad.com/p', title: 'Buy now', snippet: 's', sponsored: true }]
  assert.equal(filterSources(rows, { level: 'strict' }).kept.length, 0)
  const overridden = filterSources(rows, { level: 'strict', rules: { sponsored: 'demote' } })
  assert.equal(overridden.kept.length, 0)
  assert.equal(overridden.demoted.length, 1, 'I want ads ranked last, not deleted')
})

test('FILTER_LEVELS tie: stricter levels never resurrect rows a looser one dropped', () => {
  const rows = [
    { url: 'https://a.com/1', title: 'Keep me', snippet: 's' },
    { url: 'not-a-url', title: 'Broken', snippet: 's' },
    { url: 'https://a.com/1', title: 'Keep me', snippet: 'dup' },
  ]
  const counts = ['off', 'loose', 'balanced', 'strict'].map(level => filterSources(rows, { level }).kept.length)
  assert.deepEqual(counts, [3, 1, 1, 1], JSON.stringify(counts))
})

test('describeFilter and resolveRules report what happened', () => {
  const rows = [
    { url: 'https://a.com/1', title: 'Clean', snippet: 's' },
    { url: 'https://www.baidu.com/link?url=1', title: 'Wrapper', snippet: 's' },
    { url: 'https://b.com/1', title: '' },
  ]
  const outcome = filterSources(rows, { level: 'balanced' })
  assert.equal(outcome.dropped.length, 1)
  assert.equal(outcome.demoted.length, 1)
  const text = describeFilter(outcome)
  assert.match(text, /dropped engine-link×1/)
  assert.match(text, /relegated no-title×1/)

  const { rules } = resolveRules({ level: 'balanced', rules: { 'no-title': 'keep' } })
  assert.equal(rules['no-title'], 'keep')
  assert.equal(rules['duplicate-url'], 'drop', 'unrelated rules keep their default')
  assert.equal(FILTER_LEVELS.off['invalid-url'], 'keep')
})

// ---------------------------------------------------------------------------
// Page extraction, layered the same way.
// ---------------------------------------------------------------------------

const RELATED_WORK_HTML = `<!doctype html>
<html><body>
  <div class="ad-slot">Sponsored placement</div>
  <div class="container">
    <article>
      <h1>A formal approach</h1>
      <p>${'We prove the termination property holds for every well-typed term in the calculus. '.repeat(8)}</p>
      <section class="related-work">
        <h2>Related Work</h2>
        <p>${'Prior formulations differ in how they treat the fixed point operator, notably those of Smith and Lee. '.repeat(4)}</p>
      </section>
      <section class="comments-area">
        <h2>Comments</h2>
        <p>The accepted correction to this argument was posted here by the reviewer.</p>
      </section>
    </article>
  </div>
</body></html>`

test('gentle keeps Related Work and Comments: the loose class guesses did not run', () => {
  const result = extractMainContent(RELATED_WORK_HTML)
  assert.equal(result.mode, 'gentle')
  assert.equal(DEFAULT_EXTRACT_MODE, 'gentle')
  assert.match(result.text, /Related Work/)
  assert.match(result.text, /Prior formulations differ/)
  assert.match(result.text, /accepted correction to this argument/)
  // Actual ads are still removed even at the loosest cropping mode.
  assert.doesNotMatch(result.text, /Sponsored placement/)
})

test('standard applies the wider class guesses and loses exactly those blocks', () => {
  const standard = extractMainContent(RELATED_WORK_HTML, { mode: 'standard' })
  assert.doesNotMatch(standard.text, /Prior formulations differ/, 'class="related-work" is dropped here')
  assert.doesNotMatch(standard.text, /accepted correction/, 'class="comments-area" is dropped here')

  // And it is narrower than letting those guesses run at all. `full` is the
  // right baseline: it applies no cropping and no loose guesses.
  const full = extractMainContent(RELATED_WORK_HTML, { mode: 'full' })
  assert.ok(
    standard.text.length < full.text.length,
    `standard (${standard.text.length}) should be narrower than full (${full.text.length})`,
  )
  const gentle = extractMainContent(RELATED_WORK_HTML)
  assert.ok(
    gentle.text.length > standard.text.length,
    `gentle (${gentle.text.length}) should keep more than standard (${standard.text.length})`,
  )
})

test('mode full: nothing is cropped, the whole cleaned page comes back', () => {
  const full = extractMainContent(RELATED_WORK_HTML, { mode: 'full' })
  assert.equal(full.picked, null)
  assert.equal(full.fallback, 'mode')
  assert.equal(full.retained, 1)
  assert.match(full.text, /Related Work/)
  assert.match(full.text, /Prior formulations differ/)
  assert.doesNotMatch(full.text, /Sponsored placement/)
})

test('loss-ratio guard: cropping is abandoned when it would discard most of the page', () => {
  // One dense passage next to a large mass of links. The passage scores highest
  // on text density, so it wins the block contest — but keeping only it would
  // throw away most of the non-link text on the page, so `gentle` must refuse.
  // One dense passage beside a large list. The passage wins the density contest
  // — most of the list sits inside anchors, whose text the heuristic discounts —
  // but keeping only it would discard most of the page's non-link prose, so
  // `gentle` refuses to crop. This is the case the guard exists for.
  const links = Array.from(
    { length: 60 },
    (_, i) =>
      `<li>推荐阅读第 ${i} 篇，这是一段位于链接之外、描述该篇内容的摘要说明文字。` +
      `<a href="/x${i}">这是一条长度大致相当的推荐条目标题文字内容</a></li>`,
  ).join('')
  const page = `<html><body>
    <div id="bulk"><ul>${links}</ul></div>
    <div id="edge"><article><h1>Small note</h1><p>${'This is the only concentrated passage in the document. '.repeat(12)}</p></article></div>
  </body></html>`
  const gentle = extractMainContent(page)
  assert.equal(gentle.fallback, 'loss-ratio', 'must not trade the page away for one block')
  assert.equal(gentle.picked, null)
  assert.equal(gentle.retained, 1)
  assert.match(gentle.text, /推荐阅读第/, 'the rest of the page comes back intact')

  // The same guard is one knob to relax.
  const allowed = extractMainContent(page, { maxLossRatio: 1 })
  assert.equal(allowed.fallback, 'none')
  assert.ok(allowed.retained < 1)
})

test('EXTRACT_MODES step up by what they are willing to infer, not just by volume', () => {
  assert.equal(EXTRACT_MODES.full.semanticTags, false, 'full infers nothing at all')
  assert.equal(EXTRACT_MODES.gentle.semanticTags, true, 'declared chrome is not a guess')
  assert.equal(EXTRACT_MODES.gentle.chromeHeuristics, false, 'class-name guesses stay off by default')
  assert.equal(EXTRACT_MODES.standard.chromeHeuristics, true)
  // Cropping tolerance widens across the aggressive end only.
  assert.equal(EXTRACT_MODES.gentle.maxLossRatio, EXTRACT_MODES.standard.maxLossRatio)
  assert.ok(EXTRACT_MODES.standard.maxLossRatio < EXTRACT_MODES.aggressive.maxLossRatio)
})

test('extractMainContent: never returns less than the cleaned page', () => {
  const tiny = '<html><body><p>Too small to be an article.</p></body></html>'
  const result = extractMainContent(tiny)
  assert.equal(result.picked, null)
  assert.equal(result.fallback, 'no-block')
  assert.equal(result.retained, 1)
  assert.match(result.text, /Too small to be an article/)

  // Malformed input degrades rather than throwing.
  assert.doesNotThrow(() => extractMainContent('<div><p>unclosed'))
  assert.equal(extractMainContent('').text, '')
})

test('extractMainContent: keeps the article, drops nav, ads, comments and footer', () => {
  const result = extractMainContent(ARTICLE_HTML)
  assert.equal(result.picked, 'article')
  assert.match(result.text, /article body explains/)
  assert.doesNotMatch(result.text, /Buy cheap things/)
  assert.doesNotMatch(result.text, /Home News Sports/)
  assert.doesNotMatch(result.text, /Copyright 2026/)
  assert.doesNotMatch(result.text, /Comments from readers/)
  assert.doesNotMatch(result.text, /tracking = 1/)
  assert.ok(result.text.length > 200)
})

test('extractMainContent: falls back to the cleaned page rather than emptiness', () => {
  const result = extractMainContent('<html><body><p>Too small to be an article.</p></body></html>')
  assert.equal(result.picked, null)
  assert.match(result.text, /Too small to be an article/)
})

test('cleanPageHtml: removes comments and script/style subtrees', () => {
  const cleaned = cleanPageHtml('<div>a</div><!-- hidden --><script>x()</script><p>b</p>')
  assert.doesNotMatch(cleaned, /hidden/)
  assert.doesNotMatch(cleaned, /x\(\)/)
  assert.match(cleaned, /<p>b<\/p>/)
})

test('htmlTitle: reads the document title', () => {
  assert.equal(htmlTitle('<title>  Hello <b>world</b> </title>'), 'Hello world')
  assert.equal(htmlTitle('<html></html>'), '')
})

test('tokenize: CJK bigrams by default, no single characters', () => {
  assert.deepEqual(tokenize('本地部署'), ['本地', '地部', '部署'])
  assert.deepEqual(tokenize('DeepSeek ollama'), ['deepseek', 'ollama'])
  // Isolated characters are excluded too, not just ones inside longer runs.
  // They used to be emitted unconditionally, which bypassed `unigrams` and let
  // every lone 的 link every page containing one — a real page then answered a
  // one-character query it had nothing to do with. Opting in still works:
  assert.deepEqual(tokenize('量'), [])
  assert.deepEqual(tokenize('量', { unigrams: true }), ['量'])
  assert.equal(tokenize('本地部署', { unigrams: true }).includes('本'), true)
})

test('bm25: ranks the matching document first', () => {
  const docs = [
    indexDoc('a', tokenize('DeepSeek 本地部署 需要 Ollama 与足够显存')),
    indexDoc('b', tokenize('多智能体 架构设计 需要 角色隔离 与 独立采样')),
  ]
  const hits = bm25(docs, tokenize('本地部署 DeepSeek'))
  assert.equal(hits[0]?.id, 'a')
})

test('bm25: an unrelated query returns nothing (single-char CJK regression)', () => {
  const docs = [
    indexDoc('a', tokenize('本文讲解如何使用 Ollama 在本地部署 DeepSeek 模型，包括显存要求与量化选择。')),
    indexDoc('b', tokenize('多智能体系统的架构设计需要角色隔离、独立采样与可追溯的思维链。')),
  ]
  // '量' appears in 量化 and '计' in 设计, so unigram matching used to return
  // both documents for this query. Bigram-only matching returns neither.
  assert.equal(bm25(docs, tokenize('量子计算 股票')).length, 0)
  assert.equal(bm25(docs, tokenize('本地部署')).length, 1)
})

test('excerpt: centres the window on the match and marks elision', () => {
  const text = `${'filler '.repeat(200)}量子计算${'filler '.repeat(200)}`
  const snippet = excerpt(text, tokenize('量子计算'), 60)
  assert.match(snippet, /量子计算/)
  assert.ok(snippet.startsWith('…'))
  assert.ok(snippet.endsWith('…'))
})

test('local index: stores, searches, and clears', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-index-'))
  try {
    const store = new DocStore(dir)
    assert.equal(await store.size(), 0)

    await store.put({ url: 'https://a.example/deepseek', title: 'DeepSeek 本地部署指南', text: '如何使用 Ollama 在本地部署 DeepSeek 模型。' })
    await store.put({ url: 'https://b.example/agent', title: '多智能体架构', text: '多智能体系统的架构设计需要角色隔离与独立采样。' })
    assert.equal(await store.size(), 2)

    const provider = new LocalIndexSearchProvider({ store })
    assert.equal(provider.id, 'local-index')

    const hit = await provider.search({ query: '本地部署 DeepSeek' })
    assert.equal(hit.sources.length, 1)
    assert.equal(hit.sources[0]?.url, 'https://a.example/deepseek')
    assert.match(hit.sources[0]?.snippet ?? '', /Ollama/)

    const unrelated = await provider.search({ query: '量子计算 股票' })
    assert.equal(unrelated.sources.length, 0)

    const empty = new LocalIndexSearchProvider({ store: new DocStore(join(dir, 'empty')) })
    const none = await empty.search({ query: 'anything' })
    assert.equal(none.sources.length, 0)
    assert.match(none.content ?? '', /empty/)

    await store.clear()
    assert.equal(await store.size(), 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * A fetch provider that returns whatever it is told. Used instead of a real
 * server because the HTTP provider's SSRF guard deliberately refuses to fetch
 * loopback addresses — which is correct, and would make a localhost stub
 * useless here.
 */
function stubFetch(result) {
  return {
    id: 'stub',
    available: () => true,
    async fetch(request) {
      return { url: request.url, ...result }
    },
  }
}

const OK_RESULT = { statusCode: 200, body: { kind: 'html', content: ARTICLE_HTML }, truncated: false }
const URL_UNDER_TEST = 'https://example.test/deploy'

test('caching fetch: indexes what it reads without changing the result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cache-'))
  try {
    const store = new DocStore(dir)
    const caching = new CachingFetchProvider(stubFetch(OK_RESULT), store)

    const result = await caching.fetch({ url: URL_UNDER_TEST })
    assert.equal(result.statusCode, 200)
    // The wrapper is transparent: callers see the untouched body.
    assert.match(result.body.content, /Buy cheap things/)

    const stored = await store.getByUrl(URL_UNDER_TEST)
    assert.ok(stored !== null, 'fetch should have been indexed')
    assert.equal(stored?.title, 'Deploying locally')
    assert.match(stored?.text ?? '', /article body explains/)
    // Indexing stores the extracted article, not the page chrome.
    assert.doesNotMatch(stored?.text ?? '', /Buy cheap things/)

    // And the indexed page is now findable offline.
    const provider = new LocalIndexSearchProvider({ store })
    const found = await provider.search({ query: 'quantisation' })
    assert.ok((found?.sources.length ?? 0) > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('CachingFetchProvider: skips non-2xx responses and tiny bodies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skip-'))
  try {
    const store = new DocStore(dir)
    const errorResult = { statusCode: 500, body: { kind: 'html', content: ARTICLE_HTML }, truncated: false }
    await new CachingFetchProvider(stubFetch(errorResult), store).fetch({ url: URL_UNDER_TEST })
    assert.equal(await store.size(), 0)

    const tinyResult = { statusCode: 200, body: { kind: 'html', content: '<p>hi</p>' }, truncated: false }
    await new CachingFetchProvider(stubFetch(tinyResult), store).fetch({ url: URL_UNDER_TEST })
    assert.equal(await store.size(), 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('createWebKit: index option wires caching fetch and exposes the index', async () => {
  const { createWebKit } = await import('../dist/index.js')
  const kit = createWebKit({ search: false, index: { dir: join(await mkdtemp(join(tmpdir(), 'dsh-kit-')), 'idx') } })
  assert.ok(kit.index !== undefined)
  assert.equal(kit.index?.id, 'local-index')
  assert.deepEqual(kit.web.listFetchProviders(), ['http'])
  await kit.dispose()
})

test('withFilter: reports what it removed instead of removing silently', async () => {
  const { withFilter } = await import('../dist/index.js')
  const inner = {
    id: 'stub',
    available: () => true,
    async search() {
      return {
        sources: [
          { url: 'https://a.com/x', title: 'Real', snippet: 's' },
          { url: 'https://www.baidu.com/link?url=1', title: 'Wrapper', snippet: 's' },
        ],
        truncated: false,
      }
    },
  }
  const result = await withFilter(inner).search({ query: 'q' })
  assert.equal(result.sources.length, 1)
  assert.match(result.content ?? '', /Filter \(loose\)/)
  assert.match(result.content ?? '', /dropped engine-link×1/)
})
