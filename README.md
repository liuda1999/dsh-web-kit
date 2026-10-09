# dsh-web-kit

Standalone `web_search` / `web_fetch` capability for Node.js / TypeScript,
extracted from **DeepSeek Harness** (`deepseek-harness` v0.2.1-alpha.1, MIT).

No Cordis. No DeepSeek runtime. Providers are plain objects, the runtime is a
plain class, and the tools are JSON Schema plus a handler that any agent
framework can register.

See [ATTRIBUTION.md](ATTRIBUTION.md) for exactly which file came from where and
what was changed.

Built for one job: give a **locally-running, self-hosted agent** working
`web_search` / `web_fetch` **without paying for a search API**. Every backend
here was probed live from a mainland-China network; see
[Which engines actually work](#which-engines-actually-work-measured-2026-10-10-mainland-china-network)
for the measurements, including the ones that failed.

---

## Install

```sh
npm install github:liuda1999/dsh-web-kit

# or from a packed tarball (single machine, no registry)
npm install ./dsh-web-kit-0.2.0.tgz
```

Node `^22.19 || >=24`. ESM only. Building the tarball yourself:

```sh
npm install && npm run build && npm pack   # -> dsh-web-kit-0.2.0.tgz
```

---

## Quick start

```ts
import { createWebKit } from 'dsh-web-kit'

// Zero config: defaults to the free Bing HTML backend, no API key, no server.
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
| **百度** `www.baidu.com` | 200, but only **4** titles extractable, all behind `baidu.com/link?url=` redirect wrappers; class names are build hashes (`title_4tuoE`, `cosc-title`) that change on every frontend release; adding `&rn=20` collapsed the page to 1,438 B with zero results. | ❌ not implemented |
| **搜狗 PC** `www.sogou.com` | 302 straight to `/antispider`. | ❌ |
| **搜狗 移动** `m.sogou.com` | 200, 340 KB — but **zero** external anchors; results live in JSON/JS blobs and need a renderer. | ❌ |
| **头条搜索** `so.toutiao.com` | 200, 2 MB — but 0 `<h3>` and 0 result anchors; JS-rendered. | ❌ |
| **神马** `m.sm.cn` | 200, some real anchors, but result markup sits inside JS templates and a "未找到相关结果" branch; not verified stable. | ❌ |
| **夸克** `quark.sm.cn` | 200 but only ~6 results and time-filter chrome dominates the markup. | ❌ |
| **Yandex** | Redirected to SmartCaptcha. | ❌ |
| **Mojeek / Startpage / Brave / searx.be** | `UND_ERR_CONNECT_TIMEOUT` — unreachable from this network. | ❌ |
| **DuckDuckGo** `html.duckduckgo.com` | `UND_ERR_CONNECT_TIMEOUT` — unreachable from this network. | ⚠️ `ddg-html` kept for non-CN users |
| **SearXNG** (self-hosted) | Not deployed here. It is the only option that is neither scraped nor paid. | ✅ `searxng` — recommended long-term |

**Bottom line:** for a personal single-machine deployment in mainland China,
`bing-html` is the only zero-credential backend measured to be both parseable
and durable. `so360-html` works in short bursts and is worth chaining behind it
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

## Search: choosing a backend without an API key

Upstream DeepSeek Harness ships three search providers — **DeepSeek, Exa, and
Perplexity — all of which require a paid API key**. None of them is usable if
you want zero third-party credential, so this kit ships two new providers
instead.

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

---

## Configuration reference

| Option | Default | Notes |
|---|---|---|
| `search` | `bing-html` | `bing-html` / `so360-html` / `searxng` / `ddg-html` / `custom`; pass `false` to register none |
| `fetch` | see below | partial overrides for the HTTP fetch provider |
| `disableFetch` | `false` | register no fetch provider |
| `searchMaxResults` | `8` | sources per `web_search` |
| `searchMaxQueries` | `4` | queries per `web_search` |
| `fetchMaxOutputChars` | `200_000` | converted source chars and complete output |

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
[ OK ] REQUIRED fetch      HTTP 200, 577 chars of html, 834ms
[ OK ] REQUIRED bing-html  9 results, first has title+snippet, 176ms
[WARN] info     ddg-html   unreachable on many CN networks; not fatal
[WARN] info     searxng    not available at http://localhost:8080
PASS — 4 checks, 0 required failure(s)
```

Exit code `1` means the default search backend is unusable right now — fix it
before blaming the model. It also asserts result *quality* (first hit must have
both title and snippet), so a degrading parse warns before it fully breaks.

Wire it into a cron/task scheduler at whatever cadence you like; it costs one
HTTP request per backend.

---

## Differences from upstream

| Area | Upstream | Here |
|---|---|---|
| DI framework | Cordis (`ctx.web`, `ctx.effect`, `Service`) | plain class + disposers |
| `using` declarations | required (Explicit Resource Management) | explicit `try/finally` |
| Proxy policy | `packages/util/http-proxy`, 681 lines, mounted + reloadable | `src/proxy.ts`, ~90 lines, standard env vars |
| Tool registration | `ctx.tools.register(defineTool(...))`, dsh schema DSL | JSON Schema + handler |
| Config schema | schemastery + Cordis `Config` | plain options object |
| Search providers | DeepSeek / Exa / Perplexity (all need an API key) | SearXNG / Bing HTML / DuckDuckGo HTML (no key) + custom |
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
`WEB_PROVIDER_ERROR`

---

## Security notes

- The public-address pinning is the SSRF defence. Do not remove it to "make
  localhost work" — point at a public URL instead.
- Fetched content is **untrusted data**. Keep the trust notice in your prompt;
  the toolkit marks it, it does not neutralize it.
- `NO_PROXY` and proxy env vars are read per request, so a changed environment
  takes effect without a restart.
