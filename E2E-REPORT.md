# 端到端验证报告 — dsh-web-kit 0.6.0

本轮目标：**保证国内环境至少有一个默认可用搜索方式**，修复当前存在的问题，完整重测多种不同类型页面，确认「搜索 / 抓取 / 本地索引查询」三段链路在真实网络上稳定可用。

生成时间：见文件末尾。所有数据来自本机真实网络请求，非模拟数据。

---

## 一、国内默认搜索链路（本轮首要目标）

### 采样：五个后端 × 五个查询，同一网络

| 后端 | 成功 | 中位耗时 | 备注 |
|---|---|---|---|
| `bing-html`（HTTP 直抓必应） | **5/5** | **149 ms** | 现为默认首选 |
| `browser:bing`（浏览器渲染必应） | **5/5** | 5,558 ms | 现为默认兜底 |
| `browser:baidu` | 5/5 | 6,361 ms | ⚠️ 3/5 首条是推广位（已修） |
| `so360-html` | **0/5** | — | 单 IP 约 5 次查询后即限流 |
| `createWebKit()` 默认链路 | 5/5 | 原 5,713 ms → **现 133 ms** | |

**结论：国内默认链路有两条独立路径**（HTTP 必应 + 浏览器必应），任一条存活即有搜索。360 与 DDG 均不可依赖：360 限流、DDG 在本机三个端点全部连接超时。

### 决策：默认从 `browser-first` 改为 `http-first`

两个路径都是「抓必应」，且首条结果 **4/5 一致**，但浏览器路径慢 **37 倍**（5,558 ms vs 149 ms），还额外依赖可选的 Playwright。默认路径的延迟是真金白银——模型在等这次工具调用。

```
改前：createWebKit() → browser:bing，5,713 ms
改后：createWebKit() → bing-html，133 ms（浏览器仅在 HTTP 失败时启动）
```

`browser-first` 保留为可选项。`http-first` 的兜底顺带从百度换成必应（百度推广位问题见下）。

### 修掉的缺陷：百度推广位排名超过真实结果

采样 `browser:baidu` 五个查询，**三次首条是 `http://28608.recommend_list.baidu.com`** —— 一个编号推荐位子域。它不是漏网之鱼：行按 `mu` 属性取真实 URL，这个推荐位**有** `mu`，且指向的不是 `baidu.com/s?` 也不是 `/link?`，于是两道现有检查都放行，看起来和正常结果一模一样。

修复：`isEngineLink` 增加推荐位子域与百度 ad-tech 主机（默认 `loose` 级别即 `drop`）。

```
DROP  http://28608.recommend_list.baidu.com
DROP  https://12345.recommend_list.baidu.com/s?q=x
DROP  http://pos.baidu.com/ad
keep  https://baike.baidu.com/item/量子计算/123     ← 合法来源不受影响
keep  https://zhuanlan.zhihu.com/p/28554133163
```

副作用（已确认）：`browser:baidu` 现在返回 **7 条**而非 9 条——少掉的是推广位，不是结果。

---

## 二、此前三项建议的修复

| # | 问题 | 修复 | 位置 |
|---|---|---|---|
| 1 | GFM 对含列表/标题/`<hr>` 单元格的表格**整块输出 HTML 源码**，并裹一层 `joplin-table-wrapper` | 自研 `table` 规则替代 GFM 的 HTML 回退 | `src/tools/html.ts` |
| 2 | `minChars` / `onlySuccessful` 无法经 `createWebKit` 透传，200 字符下限成为隐藏契约 | `WebKitOptions.index` 现在转发 | `src/index.ts` |
| 3 | SPA 页（MDN 等）静态抓取拿不到正文 | 浏览器后端只做搜索不做抓取，结构性限制；已固化为受测契约 | — |

修表格时自己引入的回归：`domino` 的 `querySelector` **不做标签名过滤**，无嵌套表格也返回非空值，导致我的规则每次提前 `return content`，把表头补齐和 caption 全废掉。改用 `getElementsByTagName` 后才真正生效。

**表格十种结构（修复后）**：嵌套列表 / `<h3>` / `<hr>` / `<blockquote>` 单元格由 HTML blob 变为真 Markdown 表格；无表头补空表头、`<caption>` 独立成行（GFM 原版会把数据行降级）；其余六种保持正确。

---

## 三、其余发现并修复的真实缺陷

1. **单字中文查询复辟**——`tokenize` 对孤立单字无条件产出，绕过 `unigrams` 开关，查询「的」又能命中。已封死。
2. **`search({ query: null })` 崩溃**——空查询的明确报错契约只在传字符串时成立。
3. **传错字段名会拿到「结构合法、内容无关」的结果**（最危险的一个）。`WebSearchRequest` 字段是 `query`（单数）；误传 `queries` 时 `URLSearchParams.set` 静默把 `undefined` 转成字符串，实测返回 9 条 "JavaScript undefined" 的百科页，**零报错**，且 `withFallback` 还伪装成降级成功。现在统一校验并明确拒绝。
4. **测试进程永不退出**（挂起 25 分钟的根因）——默认后端会拉起浏览器子进程，kit 未 `dispose()`，于是 15 个用例全绿但文件挂死至超时。补释放后 26.8 秒跑完。README 已加警告。

---

## 四、稳定性

### 六轮完整套件（`npm test`，串行）

| 轮次 | tests | pass | fail | skipped |
|---|---|---|---|---|
| 1–6 | 121 | 119 | **0** | 2 |

六轮完全一致，每轮约 73 秒。跳过的两项恒为 DDG 不可达 + 360 限流——都是环境限制，两项的解析器本身有离线 fixture 与合成页测试兜着。

`--test-concurrency=1` 是必需配置：并发跑多个测试文件会争抢浏览器资源导致挂起。

### 端到端链路曾间歇失败，根因是 gnu.org

此前出现过几次 `fail`。抓到完整堆栈后确认：**gnu.org 的两个页面反复 `UND_ERR_CONNECT_TIMEOUT` / `fetch failed`** —— 该站在本机网络不稳定，而测试要求 17 个第三方站点同时健康。

两处改动，都不是掩盖：

1. **移除 gnu.org 依赖**：大文档改用 `dev.mysql.com`（213 KB，触发 100K 字符截断）、长内容改用 `postgresql.org`。替代站点实测可达（45 KB/2.9 s、213 KB/9.3 s），而 gnu.org 同时探测直接超时。
2. **不可用站点计入阈值而非直接失败**：传输类错误重试 3 次仍失败 → 记入 `unavailable` 并**打印**；`MAX_UNAVAILABLE = 1`，超过即失败。内容类失败（状态码、body kind、短语缺失）**照常第一次就红**，不重试。

这个设计的证伪性做了实测验证：故意让一个站点不可达、且另两个站点同时抽风时 → `unavailable=3` → **测试失败**（不是静默通过）。

以下日志来自那次验证，同时也是重试机制真实救回一个页面的证据：

```
[retries] 1990 年代古早 HTML: WEB_FETCH_TIMEOUT on attempt 1, retrying
          1990 年代古早 HTML: ok on attempt 2          ← 重试救回
          长内容组织首页: ... attempt 3, retrying
[unavailable] 长内容组织首页; 1MB 手册 (截断); 极短纯文本
→ fail（3 > MAX_UNAVAILABLE）
```

修复后六轮：**`[retries]` 与 `[unavailable]` 一次都没出现**。

---

## 五、多类型页面链路实测

所有可入索引的页面写进**同一个索引**，每个查询必须把自己的页面排到 top-1。这条设计是为了防假成功：只断言「返回了东西」的话，第三节第 3 项那个 `undefined` 缺陷永远暴露不出来。

| 页面类型 | 状态 |
|---|---|
| 极简静态 HTML | 171 字符，低于 200 下限，不入索引 |
| 1990 年代古早 HTML | 1,018，探针 `bibliography` |
| 表格密集型（IANA） | 2,309，探针 `policy-reserved` |
| 超大文档·截断（nodejs api/fs） | 15,306，探针 `mkdtempdisposablesync` |
| JS 渲染型文档站（MDN） | 176，SPA 降级 |
| 表单页面 | 276，探针 `instructions` |
| JSON 接口 | 313，探针 `slideshow` |
| 表格+代码块混合（Python 文档） | 12,244，探针 `floating-point` |
| 长内容命令索引（PostgreSQL） | 正常入索引 |
| 中文门户首页 | 1,226，探针 `article-cell` |
| SQLite 语法表格文档 | 426，探针 `create-virtual-table-stmt` |
| 中文列表信息流 | 5,529，探针 `stream-stream` |
| XML 文档 | 100，低于下限 |
| 纯文本 RFC（超大） | 83,677，探针 `content-transfer-encoding` |
| 超大手册·截断（MySQL refman） | 213 KB 源，触发 100K 字符截断 |
| 极短纯文本 | 29，低于下限 |

探针词运行时从索引实际文本动态选取（优先长词、且必须是该页独有），不硬编码——本轮就因为硬编码旧文案而假失败过一次。

反向与边界断言：不存在的词必须 0 命中；单字「的」0 命中；200 字符索引下限双向钉住；跨源重定向明确拒绝并指明真实目标（SSRF）；同源重定向正常跟随；SPA 页降级而非失败。

### 搜索链路（`npm run check`）

```
[ OK ] REQUIRED fetch      HTTP 200, 577 chars of html, 809ms
[ OK ] REQUIRED default    bing-html: 10 results, first has title+snippet, 175ms
[ OK ] info     bing-html  10 results, first has title+snippet, 125ms
[ OK ] info     browser:bing   7 results, first has title+snippet, 3731ms
[ OK ] info     browser:baidu  7 results, first has title+snippet, 4375ms
[WARN] info     so360-html throttled by 360 after 296ms
[WARN] info     ddg-html   unreachable after 10350ms
[WARN] info     searxng    not running (localhost:8080)
PASS — 8 checks, 0 required failure(s)
```

---

## 六、未修的一项

**SPA 页（MDN 等）静态抓取仍拿不到正文**：10 万字符 HTML → 176 字符正文。浏览器后端只做搜索、不做抓取，属结构性限制。已写成受测契约，日后若接入浏览器抓取，该测试会变红提醒更新而非悄悄漂走。要解决需让浏览器后端同时承担 `WebFetchProvider`，改动较大，等您拍板。

---

_生成于 0.6.0；复核成本：`npm test` 串行约 73 秒。_

_(UTC)_

生成时间：2026-10-10 05:30:54 (UTC)
