# Embedding dsh-web-kit in your own agent

How to drop this into a host project — OpenClaw, a custom agent loop, a
FastAPI sidecar, anything — as the built-in `web_search` / `web_fetch` tools.

Everything here was measured against a real install (`npm install
./dsh-web-kit-<version>.tgz`) in a separate project, not read off the source.
Numbers quoted below come from that run.

---

## 1. The whole integration, minus the boilerplate

```js
import { createWebKit, webToolPromptSections } from 'dsh-web-kit'

const kit = createWebKit()                    // scrape Bing over HTTP, no API key
for (const def of kit.tools) {
  myAgent.registerTool({ name: def.name, description: def.description, schema: def.parameters, run: def.handler })
}
systemPrompt.push(...webToolPromptSections({ search: true, fetch: true }))
// ...on shutdown:
await kit.dispose()
```

`kit.tools` is `[web_search, web_fetch]`. Each is
`{ name, description, parameters, handler }` — plain JSON Schema plus an async
handler, no framework types anywhere.

`handler(args, { signal })` returns
`{ text, isError, value?, meta?, code? }`:

- `text` — what you give the model. On failure it is `Error: <message>`.
- `isError` — check this, do not parse `text`.
- `value` — the structured result (`{ sources, truncated }` / `{ url, statusCode, body, truncated }`).
- `code` — the machine-routable error code. Route on this.

---

## 2. Lifecycle: one kit per process, dispose on exit

**Create the kit once, not per request.** `createWebKit()` itself is cheap, but
the default backend keeps a browser fallback behind it and launching Edge costs
seconds. Hold one instance for the life of the process.

**You must call `dispose()`.** A browser backend leaves a child process; until
it is released Node will not exit. The failure mode is a test suite that goes
green and then hangs for 25 minutes, which is exactly what happened here before
this was noticed.

```js
const kit = createWebKit()
process.on('SIGINT', async () => { await kit.dispose(); process.exit(0) })
process.on('SIGTERM', async () => { await kit.dispose(); process.exit(0) })
process.on('beforeExit', () => { void kit.dispose() })
```

Verified: after `dispose()` the host process exits on its own (exit code 0, no
hang), and with `playwright` **not installed** the whole path still works —
search returned 8 sources in 207 ms.

Two kits side by side also work: two instances searching concurrently returned
8 sources each. A multi-session host can hold one kit per session.

---

## 3. Cancellation

Pass the host's `AbortSignal` through; it is honoured end to end.

```js
const out = await tool.handler(args, { signal: controller.signal })
```

Measured: aborting 1 ms into a search returned in 10 ms with
`isError: true` and `code: 'WEB_ABORTED'`. Wire this to your request timeout —
otherwise a hung upstream holds an agent turn open.

---

## 4. Arguments the model got wrong

A model mis-naming a field is the common case, not the edge case. Validation
rejects it with `code: 'WEB_INVALID_ARGS'` and a message that names the right
field, so the next turn can self-correct:

| call | result |
| --- | --- |
| `{ queries: ['a'] }` | works |
| `{ query: 'a' }` | `WEB_INVALID_ARGS` — *"the field is `queries` (plural), an array of strings"* |
| `{}`, `null`, `{ queries: 'a' }` | `WEB_INVALID_ARGS` |
| `{ queries: [1] }` | `WEB_INVALID_ARGS` — `queries[0] must be a string` |
| `{ url: null }` (fetch) | `WEB_INVALID_ARGS` |

Before this existed the same call produced
`Cannot read properties of undefined (reading 'length')` — technically an
error, but one the model cannot act on, so it retries the same broken call.

---

## 5. OpenAI-compatible tool calling

The schemas are already plain JSON Schema, so they drop straight into a
`tools` array:

```js
const tools = kit.tools.map(def => ({
  type: 'function',
  function: { name: def.name, description: def.description, parameters: def.parameters },
}))
const choice = await fetch(`${baseUrl}/chat/completions`, { /* ...tools... */ })
// then: await tool.handler(JSON.parse(call.function.arguments))
```

This is the path for any OpenAI-compatible gateway — including a local one.
See [`examples/openai-function-calling.mjs`](examples/openai-function-calling.mjs).

---

## 6. Where it writes, and what it reads

Two things a host should pin down before shipping.

**Index directory.** The local index is **off by default**. If you turn it on
without `dir`, it defaults to `.dsh-web-kit/index` **under the current working
directory** — which for a service is wherever the process happened to start,
and may not be writable. Always pass an explicit dir:

```js
const kit = createWebKit({ index: { dir: '/var/lib/myagent/web-index' } })
```

Verified: with `dir` set, one fetch wrote exactly one document into that
directory and a follow-up `local-index` search found it; with the index off,
nothing was created in cwd at all.

**Environment variables.** `DSH_WEB_SEARCH_PROVIDER` and
`DSH_WEB_FETCH_PROVIDER` are read at construction and override provider
selection. In a host this is a trap — an unrelated variable in the deployment
environment silently changes which backend answers. Either leave them unset or
set them deliberately.

---

## 7. Module format and types

- **ESM.** `import { createWebKit } from 'dsh-web-kit'`.
- **CJS works too**, if your Node can `require()` ESM (Node ≥ 22.12 has it on
  by default). Verified on Node 22.22: `require('dsh-web-kit')` returned 121
  exports and a working `createWebKit`. On older Node, use dynamic `import()`.
- **TypeScript**: ships `.d.ts`. `@types/node` is a real dependency, so a TS
  host does not have to add it separately.
- **Node** `^22.19 || >=24`.

---

## 8. Content: what the model actually sees

`web_fetch` returns the page as **converted Markdown-in-HTML for rendering, but
`value.body.content` is the page body as fetched** — scripts, chrome and all.
That matches upstream DeepSeek behaviour and is deliberate: the tool is not the
place where content is judged.

If your host wants cleaned article text, call it yourself:

```js
import { extractMainContent } from 'dsh-web-kit'
const { text } = extractMainContent(page.value.body.content)
```

Measured on `https://example.com`: 577 chars raw → 171 chars of article text.

Keep `webToolPromptSections()` in the system prompt. Fetched content is
untrusted data; the notice is what stops it being read as instructions.

---

## 8b. Render assist: it may launch a browser during a fetch

By default `web_fetch` renders the page in a real browser **when the static body
comes back as a shell**, and keeps the rendered DOM only when it beats what HTTP
already returned. This is invisible to your tool wiring and visible in three
other places:

- **Latency**: a page that triggers costs 2–3 s instead of ~0.2 s. Pages that
  do not trigger are unaffected.
- **The flag**: `value.rendered === true` tells you a browser ran. If a fetch
  unexpectedly takes seconds, this is why — surface it in your logs and you
  will never have to guess.
- **Resources**: a browser process (200–400 MB) exists for the duration. One
  browser is reused across calls and closed by `dispose()`.

Turn it off with `createWebKit({ render: false })` if your host cannot afford
either. With the local index enabled, rendered bodies are what get indexed —
the cache wraps the whole chain, so you never index an empty shell.

It degrades silently and safely: with Playwright absent, nothing is ever
launched and every fetch is plain HTTP.

---

## 9. No Playwright? Everything still works

`playwright` is an **optional** dependency and is imported lazily. Without it:

- all HTTP backends (`bing-html`, `so360-html`, `ddg-html`, `searxng`) work,
- the default `http-first` backend works — its browser half simply never runs,
- render assist never launches and every fetch stays HTTP,
- `browser` / `browser-first` fail with an actionable error telling you to
  `npm install playwright`.

Install it only if you need Baidu, a JS-rendered page, or render assist.

---

## 10. Health-check it

The free backends are scrapers; they break silently when markup changes, and a
scraper returning zero results is the worst failure for an agent — the model
concludes "the internet has no information about this". Run the self-check at
host startup and periodically:

```sh
npx dsh-web-check        # exit 1 = the default backend is not producing results
```

---

## 11. Things not to do

- **Do not** disable the public-address pinning to make localhost work. That
  pinning is the SSRF defence.
- **Do not** create a kit per request — see §2.
- **Do not** treat `sources: []` as "no such information". Check `isError` and
  `code` first; an empty result from a broken scraper looks identical to a
  genuine zero-hit query.
