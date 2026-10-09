# Attribution

This package is a derivative work of **DeepSeek Harness**
(`https://github.com/deepseek-ai/deepseek-harness`), version `0.2.1-alpha.1`,
licensed under the **MIT License**.

## Provenance of each file

| File in this package | Origin in DeepSeek Harness | Change |
|---|---|---|
| `src/errors.ts` | `packages/llm/llm/src/error.ts` (`HarnessError`, `errorChain`, `isHarnessError`) | verbatim behaviour; dropped the context-overflow/quota classifiers, which are LLM-adapter concerns |
| `src/types.ts` | `packages/web/web/src/types.ts` | verbatim; `WebError extends HarnessError` retargeted to the local base |
| `src/runtime.ts` | `packages/web/web/src/index.ts` (`WebRuntime`) | **Cordis removed**: no longer a `Service`; registration returns a disposer instead of relying on `ctx.effect`. Selection semantics unchanged. Added `listSearchProviders()` / `listFetchProviders()`. |
| `src/timeout.ts` | `packages/util/timeout/src/index.ts` | kept `TimeoutReason`, `deadline`, `timeoutOf`; dropped `idleWatchdog` and `clampTimeout`; `Symbol.dispose` became a plain `dispose()` so no `using` syntax is required |
| `src/proxy.ts` | `packages/util/http-proxy/src/*` (681 lines) | **rewritten and reduced** to standard `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` handling. See the module doc for what was dropped. |
| `src/fetch/policy.ts` | `packages/web/web-fetch-http/src/policy.ts` | verbatim |
| `src/fetch/network.ts` | `packages/web/web-fetch-http/src/network.ts` | verbatim; only the `WebError` import retargeted |
| `src/fetch/provider.ts` | `packages/web/web-fetch-http/src/provider.ts` | `using d = deadline(...)` became `try/finally`; `proxyRouteFor` retargeted. Logic unchanged. |
| `src/tools/trust.ts` | `packages/web/tool-web/src/trust.ts` | verbatim |
| `src/tools/html.ts` | `packages/web/tool-web/src/fetch.ts` (Turndown setup, table rules, depth guard, `renderBody`) | extracted verbatim into its own module |
| `src/tools/fetch.ts` | `packages/web/tool-web/src/fetch.ts` (formatting, output cap, meta) | verbatim logic; Cordis/`ctx.tools` removed |
| `src/tools/search.ts` | `packages/web/tool-web/src/search.ts` (validation, merge, formatting) | verbatim logic; `ctx.web` became an injected `WebRuntime` |
| `src/tools/definitions.ts` | `packages/web/tool-web/src/{search,fetch}.ts` tool registrations | **rewritten** as JSON Schema + handler; names, descriptions, and prose are preserved verbatim |
| `src/search/searxng.ts` | — | **new code**. Upstream ships DeepSeek / Exa / Perplexity providers, all of which require an API key. |
| `src/search/bing-html.ts` | — | **new code**, for the same reason |
| `src/search/ddg-html.ts` | — | **new code**, for the same reason |
| `src/search/so360-html.ts` | — | **new code**. 360 搜索 (www.so.com) parser. Measured: works for ~5 queries per IP, then throttled. |
| `src/search/fallback.ts` | — | **new code**. Provider chaining; treats zero results as failure. |
| `src/search/html-text.ts` | — | **new code**, shared entity decoding for the scraping providers |

### Engines evaluated and rejected

Measured live on a mainland-China network (2026-10-10) and deliberately **not**
implemented, with the reason recorded so this is not re-litigated later:

- **百度** — build-hash class names (`title_4tuoE`, `cosc-title`) plus
  `baidu.com/link?url=` redirect wrappers; `&rn=20` collapsed the page to zero results.
- **搜狗** — PC redirects to `/antispider`; mobile returns 340 KB with zero
  external anchors (results in JSON/JS).
- **头条 / 神马 / 夸克** — result markup is JS-rendered or template-bound.
- **Yandex** — SmartCaptcha. **Mojeek / Startpage / Brave** — unreachable.
| `src/turndown-plugin-gfm.d.ts` | `packages/web/tool-web/src/turndown-plugin-gfm.d.ts` | verbatim |

## License

MIT License

Copyright (c) 2026 DeepSeek-AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Trademarks

"DeepSeek" is a trademark of DeepSeek AI. This package is not affiliated with
or endorsed by DeepSeek AI.
