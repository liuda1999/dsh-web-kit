# dsh-web-kit

Standalone `web_search` / `web_fetch` capability for Node.js / TypeScript,
extracted from **DeepSeek Harness** (`deepseek-harness` v0.2.1-alpha.1, MIT).

No Cordis. No DeepSeek runtime. Providers are plain objects, the runtime is a
plain class, and the tools are JSON Schema plus a handler that any agent
framework can register.

See [ATTRIBUTION.md](ATTRIBUTION.md) for exactly which file came from where and
what was changed.

---

## Install

```sh
# from the packed tarball (single machine, no registry)
npm install ./dsh-web-kit-0.6.0.tgz

# or drop the folder in and link it
npm install /path/to/dsh-web-kit

# optional: enables the browser backend (Baidu). Uses Edge/Chrome if installed.
npm install playwright
```

Node `^22.19 || >=24`. ESM only. `playwright` is an **optional** dependency —
without it everything still works, you just lose the browser backend. Building
the tarball yourself:

```sh
npm install && npm run build && npm pack   # -> dsh-web-kit-0.6.0.tgz
```

---

## Quick start

```ts
import { createWebKit } from 'dsh-web-kit'

// Zero config: scrape Bing over plain HTTP, backed by Bing in a real browser if
// HTTP ever stops answering. No API key, no server, and no Playwright install
// needed to work.
const kit = createWebKit()

// Once you run SearXNG locally, switch to it — it is the stable free option.
// const kit = createWebKit({ search: { kind: 'searxng', options: { baseUrl: 'http://localhost:8080' } } })

const [search, fetch] = kit.tools

const out = await search.handler({ queries: ['deepseek harness web capability'] })
console.log(out.text)

const page = await fetch.handler({ url: 'https://example.com' })
console.log(page.text)
```

Register with your framework:

```ts
for (const def of kit.tools) {
  myAgent.registerTool({
    name: def.name,
    description: def.description,
    schema: def.parameters,
    run: def.handler,        // (args, { signal }) => Promise<ToolOutcome>
  })
}
```

`ToolOutcome` is `{ text, isError, value?, meta?, code? }`. On failure `text` is
`Error: <message>` and `code` carries the machine-routable `WebError` code.

Add the trust sections to your system prompt — they are what stops fetched text
from being read as instructions:

```ts
import { webToolPromptSections } from 'dsh-web-kit'
const sections = webToolPromptSections({ search: true, fetch: true })
```

**Embedding it in your own agent** — one kit per process, `dispose()` on every
exit path, cancellation, OpenAI-compatible `tools` conversion, where it writes,
and the traps: see [EMBEDDING.md](EMBEDDING.md). Runnable hosts are in
[`examples/`](examples/): `minimal-host.mjs` (offline),
`openclaw-tool-host.mjs` (real search + fetch + lifecycle),
`openai-function-calling.mjs`.

---

## Which engines actually work (measured 2026-10-10, mainland-China network)

Every backend below was probed live for this package — HTTP status, response
size, whether the result blocks survive in the server-rendered HTML, and
whether repeated queries keep working. "Usable" means the parser extracted real
results with real destination URLs, not just that the request returned 200.

| Engine | Measured result | In this package |
|---|---|---|
| **Bing** `cn.bing.com` | **200**, 9–10 results, stable across ~25 requests and 3+ minutes. Chinese and English queries both work. | ✅ `bing-html` — **default** |
| **360 搜索** `www.so.com` | **200** and 3–6 results for the first ~5 queries (`data-mdurl` gives the real URL, no redirect needed) — then **every** later request returned a 6 KB `访问异常页面` throttle page; still blocked after 3 min and with a `Referer`. | ⚠️ `so360-html` — fallback only |
| **百度** `www.baidu.com` (plain HTTP) | 200, but only **4** titles extractable, all behind `baidu.com/link?url=` redirect wrappers; class names are build hashes (`title_4tuoE`, `cosc-title`) that change on every frontend release; adding `&rn=20` collapsed the page to 1,438 B with zero results. | ❌ unusable without a browser |
| **百度** `www.baidu.com` (real browser) | **8–11 results with real destination URLs** — every row carries the true target in its `mu` attribute. Rows without `mu` are not selected, which removes most placements — but *not* all: see the placement caveat below. | ✅ `browser` (`engine: 'baidu'`) |
| **搜狗 PC** `www.sogou.com` | 302 straight to `/antispider`. | ❌ |
| **搜狗 移动** `m.sogou.com` | 200, 340 KB — but **zero** external anchors; results live in JSON/JS blobs and need a renderer. | ❌ |
| **头条搜索** `so.toutiao.com` | 200, 2 MB — but 0 `<h3>` and 0 result anchors; JS-rendered. | ❌ |
| **神马** `m.sm.cn` | 200, some real anchors, but result markup sits inside JS templates and a "未找到相关结果" branch; not verified stable. | ❌ |
| **夸克** `quark.sm.cn` | 200 but only ~6 results and time-filter chrome dominates the markup. | ❌ |
| **Yandex** | Redirected to SmartCaptcha. | ❌ |
| **Mojeek / Startpage / Brave / searx.be** | `UND_ERR_CONNECT_TIMEOUT` — unreachable from this network. | ❌ |
| **DuckDuckGo** `html.duckduckgo.com` | `UND_ERR_CONNECT_TIMEOUT` — unreachable from this network. | ⚠️ `ddg-html` kept for non-CN users |
| **SearXNG** (self-hosted) | Not deployed here. It is the only option that is neither scraped nor paid. | ✅ `searxng` — recommended long-term |

### The same engines through a real browser

A browser changes the picture for one engine and one engine only. Re-measured
with Playwright driving Edge, JS executed and cookies set:

| Engine | plain HTTP | real browser |
|---|---|---|
| **Bing** `cn.bing.com` | 9–10 results, usable | **10/10** on four different queries, every row with title + URL + snippet |
| **百度** `www.baidu.com` | 4 rows, **all** redirect wrappers | **8–11 rows, real URLs** (e.g. `https://github.com/deepseek-free/...`) |
| **搜狗** `www.sogou.com` | 302 → `/antispider` | still → `/antispider`, even after visiting the homepage first |
| **360** `www.so.com` | throttled after ~5 queries | redirected to `qcaptcha.so.com` |

So the browser buys **Baidu**, which plain HTTP cannot use at all. Sogou and 360
stay blocked either way — they are not implemented, rather than shipped broken.

### Cost of the browser path, measured

Both paths are scrape-Bing, so the interesting question is what the browser buys
and what it costs. Five queries each, same machine, same network:

| Path | success | median latency | agreed on top result with the other |
|---|---|---|---|
| `bing-html` (HTTP) | **5/5** | **149 ms** | 4 of 5 |
| `browser:bing` | **5/5** | **5,558 ms** | 4 of 5 |

**37× slower for no better answer.** That is why the default is `http-first`:
take HTTP when it works, fall back to the browser when scraping breaks. A model
waiting on a tool call pays every one of those milliseconds.

### The Baidu placement caveat

Baidu rows are selected by their `mu` attribute, and rows with no `mu` are not
selected at all — which is why "placements are structurally excluded" used to be
true. It is not any more. Sampling five queries through `browser:baidu` put
`http://28608.recommend_list.baidu.com` **first three times out of five**: that
recommendation slot *has* a `mu`, and it points at a `recommend_list` subdomain
rather than `baidu.com/s?` or `/link?`, so both existing checks let it through
looking exactly like a source. Those hosts and Baidu's ad-tech hosts are now
dropped by `isEngineLink`, which is why `browser:baidu` answers with two fewer
rows than it used to — placements leaving, not results lost.

**Bottom line:** for a personal single-machine deployment in mainland China,
Bing is the only zero-credential backend measured to be both parseable and
durable, through two independent paths (plain HTTP and a real browser), so losing
one does not leave you with nothing. A real browser adds Baidu on top of it, with
the caveat above. `so360-html` works in short bursts and is worth chaining behind
as a fallback. Everything else measured either blocked, required JavaScript, or
was unreachable.

### Recommended: chain them

```ts
import { createWebKit, BingHtmlSearchProvider, So360HtmlSearchProvider, withFallback } from 'dsh-web-kit'

const kit = createWebKit({
  search: {
    kind: 'custom',
    provider: withFallback(
      new BingHtmlSearchProvider(),
      new So360HtmlSearchProvider({ timeoutMs: 15_000 }),
    ),
  },
})
```

`withFallback` tries providers in order and treats "returned zero sources" as a
failure — that is exactly how a silent scraping break presents itself, so the
pessimistic reading is the correct one.

---

## Browser automation

The browser backend drives a real browser (Playwright) instead of an HTTP
client. It exists for one measured reason: **over plain HTTP, Baidu gives you
only `baidu.com/link?url=` redirect wrappers, and only a real browser resolves
them.** Its second benefit is durability — a browser receives the same page a
person does, so JS-rendered result layouts are not a problem.

```ts
import { createWebKit } from 'dsh-web-kit'

// Default: scrape Bing over HTTP, fall back to a browser if that ever stops
// answering. Same as { kind: 'http-first' }.
const kit = createWebKit()

// Explicit choices:
createWebKit({ search: { kind: 'browser', options: { engine: 'baidu' } } })
createWebKit({ search: { kind: 'http-first', options: { engine: 'baidu' } } })  // Baidu as the net
createWebKit({ search: { kind: 'browser-first' } })              // slower; see note below
```

Costs, stated plainly:

- **Playwright is optional.** Not installed → the browser provider throws a
  typed `WEB_PROVIDER_UNAVAILABLE` and `http-first` falls through to the browser.
  Nothing else degrades.
- **Browser resolution order** is `msedge` → `chrome` → Playwright's bundled
  Chromium. On Windows you almost always already have Edge, so there is nothing
  to download. If not: `npx playwright install chromium`.
- **Latency**: the difference is not marginal. Sampling five queries through
  both paths on a Chinese network: scrape-Bing over HTTP answered in **149 ms
  median**, the same query through a browser in **5,558 ms** — **37×**. Both
  agreed on the top result for four of the five. That measurement is why the
  default puts HTTP first and keeps the browser as a fallback.
- **Baidu placements: most are structural, the rest needed a rule.** Rows carry
  their real target in a `mu` attribute and rows without one are never
  selected — which is how most ads and every `baidu.com/link?url=` wrapper
  disappear before the filter ever runs. That was the whole story until it was
  sampled: driving Baidu over a browser for five queries put
  `http://28608.recommend_list.baidu.com` **first three times out of five**. It
  has a `mu`, and the `mu` points somewhere that is not `baidu.com/s?` or
  `/link?`, so it sailed through both existing checks looking exactly like a
  source. Those recommendation subdomains and Baidu's ad-tech hosts are now
  dropped by `isEngineLink` (see the regression test), so `engine: 'baidu'`
  returns two fewer rows than it used to — placements leaving, not results.

```ts
import { BrowserSearchProvider } from 'dsh-web-kit'

const provider = new BrowserSearchProvider({ engine: 'baidu', timeoutMs: 60_000 })
const { sources } = await provider.search({ query: 'deepseek 本地部署', maxResults: 5 })
await provider.dispose()   // closes the browser this provider owns
```

---

## Content filtering

Scraped result pages and fetched articles both carry material that is not an
answer. Two filters ship, both on by default — and both are deliberately weak,
because **losing one real source costs more than seeing one poor one**.

### There is no built-in site blacklist

Worth stating plainly, since "filter" usually implies one:

- `blockedHosts`, `blockedKeywords`, `allowedHosts` are **empty by default**.
  Nothing is blocked until you name it. They are your policy, not ours.
- The only hard-coded direction is nine entries matching a search engine's *own*
  redirect and navigation paths, plus its placement and ad-tech hosts (host
  **and** path are matched), e.g. `baidu.com/link?url=…` and
  `28608.recommend_list.baidu.com` are dropped while `baike.baidu.com/item/…` is
  kept.
- Page extraction has a 27-word list of class/id fragments, but it **does not
  run at the default level** — see below.

Everything else is either structurally certain (an ad row the scraper flagged)
or *soft*: recorded, ranked last, and reported to you.

### Result filtering — three outcomes, not two

Each rule resolves to `keep`, `demote` or `drop`. A demoted row **still reaches
the model**, just behind every clean row — so the default level costs you
ranking on a bad day and never costs you content. `maxResults` truncation then
drops demoted rows first, without ever having hidden them.

| Rule | `off` | `loose` *(default)* | `balanced` | `strict` |
|---|---|---|---|---|
| `invalid-url` | keep | **drop** | **drop** | **drop** |
| `sponsored` (row the scraper flagged as paid) | keep | **drop** | **drop** | **drop** |
| `engine-link` (redirect wrapper / self-nav) | keep | **drop** | **drop** | **drop** |
| `duplicate-url` (after stripping `utm_*` etc.) | keep | **drop** | **drop** | **drop** |
| `duplicate-title` ( ≥ 8 chars; shorter never matches) | keep | demote | demote | **drop** |
| `no-title` | keep | keep | demote | **drop** |
| `short-snippet`, `host-cap`, `low-score` | keep | keep | demote | **drop** |
| `blocked-*` / `not-allowed-host` (only if you set them) | keep | drop | drop | drop |

```ts
import { filterSources, survived } from 'dsh-web-kit'

const outcome = filterSources(rows)          // level 'loose'
outcome.kept      // clean rows
outcome.demoted   // suspicious rows — still returned, behind the clean ones
outcome.dropped   // removed, each with a reason
survived(outcome) // kept ++ demoted, i.e. exactly what the model will see
```

Nothing is removed silently: `withFilter(provider)` reports the counts in the
result's `content` field. Silent removal would be indistinguishable from the web
having nothing to say — the exact failure mode this package exists to avoid.

Disagree with one rule without changing level:

```ts
filterSources(rows, { level: 'strict', rules: { sponsored: 'demote' } })
```

`scoreSource` normally only *orders* rows; it removes nothing until you set
`minScore` or move to `balanced`/`strict`. English keywords match on word
boundaries, so the keyword `ad` does not hit the word "read".

### Page filtering — four modes, and a guard against over-cropping

Each mode decides **which categories of content may be dropped**. Nothing is
removed except by that decision, so a stricter mode can only lose what a looser
one was already willing to lose.

| Mode | removes | crops | class/id guesses | images | forms | media | **`maxLossRatio`** |
|---|---|---|---|---|---|---|---|
| `full` | non-rendering tags only | no | no | keep | keep | keep | — |
| **`gentle`** *(default)* | + `<nav>` `<footer>` `<aside>` + ad slots | yes | **no** | keep | keep | keep | **0.65** |
| `standard` | same | yes | **yes** | keep | keep | **drop** | 0.65 |
| `aggressive` | same | yes | yes | **drop** | **drop** | drop | 0.9 |

The last three columns exist because some page types hold their content outside
text nodes, which means stripping tags erases the content itself:

- **forms** — `<input value>`, `<option>`, `<textarea>`: a settings reference
  rendered as controls is mostly form.
- **images** — `<img alt>`: a diagram's only description.
- **media** — SVG `<text>` labels, `<iframe title>`, `<track label>`, canvas
  fallback text: how architecture diagrams and embedded samples ship.

A page built entirely from form controls previously came back as a few orphan
paragraphs with every value missing, in **every** mode — including `full`, which
advertised "no cropping, no guessing" while a hard-coded drop-list deleted them.
That is fixed: `full` now really only removes tags that cannot render text.

```ts
extractMainContent(html)                        // gentle: keeps Related Work
extractMainContent(html, { mode: 'standard' })  // drops it
extractMainContent(html, { mode: 'full' })      // nothing cropped, ever
extractMainContent(html, { mode: 'aggressive', includeForms: true })  // but keep the values
```

Hidden inputs are never recovered — `<input type="hidden">` is where frameworks
park CSRF tokens, and reading it would copy secrets into both the model context
and the local index. Password fields likewise. See `UNREADABLE_INPUT_TYPES`.

`npm run report` measures every mode against every fixture in
`tests/fixtures/complex-*.html` and writes `EXTRACT-REPORT.md`.

**The loss guard.** Cropping is abandoned entirely when the winning block holds
less than `1 - maxLossRatio` of the page's non-link text; you get the cleaned
page and `fallback: 'loss-ratio'` explaining why. Losing boilerplate is an
optimisation; losing the article is a bug.

Measured on real pages (`raw` is the truncated HTML, `cleaned` is what survives
cleaning, `gentle` is what reaches the model):

| Page | raw | cleaned | gentle | retained | picked |
|---|---|---|---|---|---|
| `juejin.cn` article | 100,000 chars | 6,540 | 5,803 | **0.97** | `article` |
| `developer.baidu.com` article | 100,000 chars | 7,530 | 7,164 | **0.99** | `main` |
| `example.com` | 577 chars | 171 | 171 | 1.00 | *fell back* |

Two real defects were found while measuring this:

- **A 50 KB `window.__NUXT__=` payload was being read as prose.** `<script>`
  bodies contain `<`, `&&` and comparisons like `a<b`, which confuse a tag
  stack; worse, the 100 KB fetch limit routinely cuts them off mid-block so no
  closing tag exists. Raw-text subtrees are now swept with a dedicated regex,
  including an unterminated case (`<(script…)>…$`). `full` output for the
  juejin article fell from 58,737 to 6,540 chars, and `retained` from a
  nonsensical 0.10 to the truthful 0.97.
- **The loss guard never fired.** The scan's total was computed wrong — a
  balanced document leaves nothing to accumulate into — making the denominator
  zero, which `Math.max(1, …)` turned into "100% retained". A sentinel root
  frame fixes it, and the guard now genuinely fires (there is a regression test
  using a link-heavy page where the density heuristic picks wrong).

---

## Local index (search what you already fetched)

Enable `index` and every fetched page is stored and becomes searchable offline
with BM25. No service, no API, nothing leaves the machine.

```ts
import { createWebKit } from 'dsh-web-kit'

const kit = createWebKit({ index: { dir: '.dsh-web-kit/index' } })

await kit.web.fetch({ url: 'https://example.com/article' })  // stored as you read

const found = await kit.index.search({ query: 'quantisation' })
// -> sources drawn from your own fetched pages
```

Chinese tokenisation is dictionary-free: **bigrams only** by default. That is a
measured decision — with single characters included, the query `量子计算 股票`
matched a document containing `量` (in 量化) and another containing `计` (in 设
计), returning two hits for a query related to neither. Bigrams alone return
zero. Pass `{ unigrams: true }` if you want the recall back.

Isolated characters — a `的` set off by punctuation rather than part of a longer
run — are excluded the same way. They were not, at first: `tokenize` special-
cased one-character runs and emitted them regardless of `unigrams`, which put
every stray `的` into the index and made a real Chinese news page answer the
one-character query `的`. Same trade-off as above, opt in with `unigrams`.

Two knobs decide what is worth remembering, and both are forwarded through
`createWebKit({ index })`:

```ts
const kit = createWebKit({
  index: {
    dir: '.dsh-web-kit/index',
    minChars: 0,        // default 200; pages below it are usually shells
    onlySuccessful: true, // default true; non-2xx is skipped
  },
})
```

The default `minChars: 200` exists because most short pages are not pages: a
redirect stub, a login wall, an empty SPA shell. But it also discards genuinely
answer-sized documents — a short reference entry is often ~170 characters — so
`0` is there for indexes built from small pages. Either way the behaviour is
asserted in both directions in `tests/index-options.test.mjs`.

You can also compose it: `withFallback(liveProvider, kit.index)` searches the
web first and your own archive second.

**Known boundary — two different limits that look identical:**

- *Truncation, not rendering.* `maxBodyChars` defaults to 100,000, which cuts
  the tail off large documents, and the tail is usually where the prose is.
  Raise it and the "SPA" mostly disappears: MDN goes from **168 → 2,790**
  chars, NetEase Music from **3,291 → 119,504**. An earlier version of this
  README blamed client rendering for what was the body cap — measured, wrong,
  corrected. See [SPA-PROBE.md](SPA-PROBE.md).
- *Genuine client rendering.* Pages shipping an empty shell (Douyin's hot list,
  Excalidraw) return **0 chars at any cap**; the HTML has no content until a
  browser runs the scripts. The browser backend covers *search*, not *fetch*, so
  this kit cannot read those yet. What it can still do: the bootstrap JSON many
  of them embed is readable from the raw HTML — see the probe report.

---

## Search: choosing a backend without an API key

Upstream DeepSeek Harness ships three search providers — **DeepSeek, Exa, and
Perplexity — all of which require a paid API key**. None of them is usable if
you want zero third-party credential, so this kit ships its own providers
instead — SearXNG, Bing HTML, 360 HTML, DuckDuckGo HTML, plus a browser backend
that unlocks Baidu.

### `searxng` — recommended

Self-hosted [SearXNG](https://docs.searxng.org/) metasearch. SearXNG queries
upstream engines server-side; **your client needs no API key**.

```sh
docker run -d --name searxng -p 8080:8080 \
  -e SEARXNG_BASE_URL=http://localhost:8080/ \
  searxng/searxng
```

Recent SearXNG builds **disable the JSON format by default**. Enable it in
`settings.yml` (mount your own config, or edit it in the container):

```yaml
search:
  formats:
    - html
    - json
```

Verify before wiring it up:

```sh
curl 'http://localhost:8080/search?q=test&format=json' | head -c 400
```

If that returns HTML instead of JSON, the format is not enabled.

```ts
createWebKit({
  search: {
    kind: 'searxng',
    options: {
      baseUrl: 'http://localhost:8080',
      engines: 'bing,brave,duckduckgo',   // optional
      language: 'all',
      safeSearch: 0,
      timeoutMs: 30_000,
    },
  },
})
```

### `bing-html` — zero infrastructure, verified working from mainland China

Scrapes `https://cn.bing.com/search`. No key, no server, no setup.

**Measured during development** (the only zero-credential engine that was
reachable):

| Endpoint | Result |
|---|---|
| `https://cn.bing.com/search?q=…` | **200** — parses to 10 results |
| `https://html.duckduckgo.com/html/` | `UND_ERR_CONNECT_TIMEOUT` — unreachable |
| `https://lite.duckduckgo.com/lite/` | timeout — unreachable |
| `https://www.baidu.com/s?wd=…` | 302 (redirects; not parsed) |

It is still a scraper, so the same caveats apply: Bing may change the markup,
rate-limit you, or serve a challenge page. When that happens it throws
`WEB_PROVIDER_ERROR` with an explicit reason rather than reporting an empty web.

```ts
createWebKit({ search: { kind: 'bing-html', options: { market: 'zh-CN' } } })
```

### `ddg-html` — zero infrastructure, and fragile

Scrapes `https://html.duckduckgo.com/html/`. No key, no server, no setup — and
**no stability guarantee**:

- DuckDuckGo may change the markup or redirect wrapper at any time; the parser
  then returns zero results.
- Automated queries can be rate-limited or IP-blocked, silently.
- Scraping may conflict with the endpoint's terms of use.
- **It was unreachable from the network used during development**, so unlike
  `bing-html` it has no live verification — only stub-server and fixture tests.

Use it as a fallback, not as something you depend on. It throws
`WEB_PROVIDER_ERROR` with an explicit message when it parses nothing, so
breakage is visible rather than silent.

```ts
createWebKit({ search: { kind: 'ddg-html', options: { region: 'wt-wt' } } })
```

### `custom` — bring your own

```ts
createWebKit({ search: { kind: 'custom', provider: myProvider } })
```

`myProvider` must implement `WebSearchProvider` (`id`, `available()`,
`search(request, signal)`).

---

## Fetch

The HTTP fetch provider is the upstream one, unchanged in behaviour:

- **SSRF defence**: hostname resolves once, every answer must be a public
  unicast address (including NAT64 unwrapping), and the validated set is pinned
  into the connection so DNS cannot change between check and connect.
- Only HTTP(S); credentials in URLs are refused.
- Same-origin redirects only, capped; cross-origin redirects are reported, not
  followed.
- Byte cap (`5 MB`) and decoded-character cap (`100k`), with `truncated` set.
- Content-Type classification; unknown charset fails loudly rather than
  producing mojibake.
- Proxy support via `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`.

```ts
createWebKit({ fetch: { timeoutMs: 15_000, maxBodyChars: 50_000 } })
```

`web_fetch` converts HTML to Markdown (Turndown + GFM), strips non-visible
elements, and refuses to convert past a nesting depth of 512 to bound
synchronous work.

GFM's table handling is overridden. The plugin decides that a table containing a
list, a heading, a rule, or a blockquote cannot be Markdown, and emits the whole
`<table>` as source markup wrapped in `<div class="joplin-table-wrapper">` — the
right call for a note app that re-parses HTML, wrong for a model context or a
search index, both of which receive one opaque blob tagged with a private class
name. Any such table converts to a real GFM table instead, with a blank header
row supplied when none was authored, and the `<caption>` read back from the
document (GFM's own caption rule deletes it from the content it hands down).
Nested tables have no Markdown form and pass through as the inner table's own
output. `colspan` is still never expanded into invented cells.

---

## Configuration reference

| Option | Default | Notes |
|---|---|---|
| `search` | `http-first` | `http-first` / `browser-first` / `browser` / `bing-html` / `so360-html` / `searxng` / `ddg-html` / `local-index` / `custom`; pass `false` to register none |
| `fetch` | see below | partial overrides for the HTTP fetch provider |
| `disableFetch` | `false` | register no fetch provider |
| `filter` | `loose` | result filtering options or a level (`'off' \| 'loose' \| 'balanced' \| 'strict'`); pass `false` to disable |
| `index` | off | `{ dir, extract?, minChars? (200), onlySuccessful? (true) }` enables the local index and caching fetch; `extract` takes `mode: 'full' \| 'gentle' \| 'standard' \| 'aggressive'` |
| `searchMaxResults` | `8` | sources per `web_search` |
| `searchMaxQueries` | `4` | queries per `web_search` |
| `fetchMaxOutputChars` | `200_000` | converted source chars and complete output |

`createWebKit()` also returns `{ web, tools, index?, dispose }`. Call `dispose()`
when you are done — this is not optional tidiness:

```ts
const kit = createWebKit()
try {
  // ...use it
} finally {
  await kit.dispose()
}
```

Every backend that can reach a browser will eventually own one, and the browser
is a **child process**. Skip `dispose()` and your program finishes all its work,
reports nothing wrong, and then never exits, because the live browser still
holds the pipes Node is waiting on. This cost 25 minutes in the project's own
test suite before the cause was clear; the symptom was a file whose every test
passed while the process hung past its timeout.

Tune either filter without touching code:

```ts
// Worried about losing sources? Make it even looser — or off, to see what it was doing.
createWebKit({ filter: { level: 'off' } })
createWebKit({ filter: { rules: { 'duplicate-title': 'keep' } } })

// Indexing: keep the whole page rather than the extracted article.
createWebKit({ index: { dir: './idx', extract: { mode: 'full' } } })
```

Fetch defaults: `maxResponseBytes` 5,000,000 · `maxBodyChars` 100,000 ·
`timeoutMs` 30,000 · `maxRedirects` 5.
---

## Self-check (run this after deploying, and periodically)

The free backends are **scrapers**. When the upstream markup changes, or you get
rate-limited or served a captcha, the parser finds nothing — and the model then
concludes "no information exists" instead of "my tool is broken". That is the
one failure mode worth monitoring on a single-machine setup.

```sh
npm run check          # or: npx dsh-web-check
DSH_WEB_CHECK_QUERY="你的常用查询" npm run check
```

```
[ OK ] REQUIRED fetch         HTTP 200, 577 chars of html, 699ms
[ OK ] REQUIRED default       browser:bing: 7 results, first has title+snippet, 3617ms
[ OK ] info     bing-html     9 results, first has title+snippet, 198ms
[ OK ] info     browser:bing  7 results, first has title+snippet, 3401ms
[ OK ] info     browser:baidu 7 results, first has title+snippet, 4336ms
[WARN] info     so360-html    throttled by 360 after 287ms
[WARN] info     ddg-html      unreachable on many CN networks; not fatal
[WARN] info     searxng       not available at http://localhost:8080
PASS — 8 checks, 0 required failure(s)
```

Exit code `1` means the default search backend is unusable right now — fix it
before blaming the model. It also asserts result *quality* (first hit must have
both title and snippet), so a degrading parse warns before it fully breaks.

The `default` row runs whatever `createWebKit()` actually selects, end to end,
so it reflects reality rather than a hardcoded assumption. Wire it into a
cron/task scheduler at whatever cadence you like.

---

## Differences from upstream

| Area | Upstream | Here |
|---|---|---|
| DI framework | Cordis (`ctx.web`, `ctx.effect`, `Service`) | plain class + disposers |
| `using` declarations | required (Explicit Resource Management) | explicit `try/finally` |
| Proxy policy | `packages/util/http-proxy`, 681 lines, mounted + reloadable | `src/proxy.ts`, ~90 lines, standard env vars |
| Tool registration | `ctx.tools.register(defineTool(...))`, dsh schema DSL | JSON Schema + handler |
| Config schema | schemastery + Cordis `Config` | plain options object |
| Search providers | DeepSeek / Exa / Perplexity (all need an API key) | SearXNG / Bing HTML / 360 / DuckDuckGo / **browser (Bing + Baidu)** / local index — none needs a key |
| Content filtering | none at this layer | result filter (ads, interstitials, duplicates) + article extraction |
| Local index | session log only | offline BM25 index over fetched pages |
| Session events | `web/deepseek-search-llm-request` etc. | **removed** — no session log |
| System prompt | `ctx.systemPrompt.section(...)` | `webToolPromptSections()` returns strings |
| UI cards | `presentCall` / `presentResult` returning card unions | **removed**; `outcome.meta` carries the structured summary |

Multi-query merge, output prose, truncation footer, and every error code are
preserved verbatim.

---

## Error codes

Route on `outcome.code`, never on the message text.

`WEB_PROVIDER_UNAVAILABLE` · `WEB_PROVIDER_AMBIGUOUS` ·
`WEB_PROVIDER_CONFIGURED_MISSING` · `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` ·
`WEB_DUPLICATE_PROVIDER` · `WEB_ABORTED` · `WEB_SEARCH_TIMEOUT` ·
`WEB_INVALID_URL` · `WEB_BLOCKED_URL` · `WEB_REDIRECT_BLOCKED` ·
`WEB_FETCH_TOO_LARGE` · `WEB_FETCH_TIMEOUT` · `WEB_UNSUPPORTED_CONTENT_TYPE` ·
`WEB_PROVIDER_ERROR` · `WEB_INVALID_ARGS`

`WEB_INVALID_ARGS` is the tool-layer rejection: arguments of the wrong shape.
The message names the field the caller should have used — a model that sends
`query` instead of `queries` is told the field is `queries` (plural), which
lets it correct itself on the next turn.

---

## Security notes

- The public-address pinning is the SSRF defence. Do not remove it to "make
  localhost work" — point at a public URL instead.
- Fetched content is **untrusted data**. Keep the trust notice in your prompt;
  the toolkit marks it, it does not neutralize it.
- `NO_PROXY` and proxy env vars are read per request, so a changed environment
  takes effect without a restart.
