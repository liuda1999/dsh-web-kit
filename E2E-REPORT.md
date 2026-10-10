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
| 3 | SPA 页（MDN 等）静态抓取拿不到正文 | **结论已被后续实测证伪**：真因是默认 `maxBodyChars` 100k 截断，不是客户端渲染。MDN 提到 1M 后 168 → 2,790。真空壳页（抖音）仍需浏览器抓取，见 [SPA-PROBE.md](SPA-PROBE.md) | — |

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
| JS 渲染型文档站（MDN） | 176 —— 由默认 100k 截断造成，非 SPA 降级；1M 上限下为 2,790 |
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

**SPA 页（MDN 等）静态抓取拿不到正文 —— 该结论已作废。** 10 万字符 HTML →
176 字符正文，当时归因为"客户端渲染，结构性限制"。后续用 1M 上限重测：MDN
**168 → 2,790**、网易云音乐 **3,291 → 119,504**、豆瓣 9,768。真正的变量是
`maxBodyChars` 默认值把文档尾部（正文所在处）切掉了，不是渲染方式。

仍然成立的部分：纯客户端渲染且不带内嵌数据的页面（抖音热榜 0 字符、
Excalidraw 21 字符）在任何上限下都拿不到，这需要浏览器抓取；浏览器后端目前
只做搜索、不做抓取。详见 [SPA-PROBE.md](SPA-PROBE.md)。

---

_生成于 0.6.0；复核成本：`npm test` 串行约 73 秒。_

_(UTC)_

生成时间：2026-10-10 05:30:54 (UTC)

---

## 七、0.6.1 追加：面向"嵌入宿主"的复核

目标从"能力可用"变成"能被别的 agent 项目当内置工具用"，因此复核方式变成
**在独立宿主项目里安装 tarball 后实测**，而不是在本仓库内跑：

| 检查 | 结果 |
| --- | --- |
| `npm install ./dsh-web-kit-0.6.1.tgz --omit=optional` | 8 个包，无 playwright |
| 默认后端搜索（无 playwright） | 8 条结果，214 ms |
| `require('dsh-web-kit')`（CJS 宿主） | 121 个导出可用（Node 22.22） |
| TS 宿主 `tsc --strict --noEmit` | 0 错误（`@types/node` 已随包安装） |
| `AbortSignal` 取消 | 10 ms 返回，`WEB_ABORTED` |
| 两个 kit 实例并发 | 各 8 条，互不影响 |
| 索引目录显式指定 | 只写入指定目录，不碰 cwd |
| 未开索引时是否污染 cwd | 否（`.dsh-web-kit` 未创建） |
| `dispose()` 后进程退出 | 正常退出，不挂起 |

回归：全量 5 轮 + E2E/浏览器 4 轮 + 其余 4 轮，**除首轮 1 项未能复现的间歇
失败外全部通过**（130 项 / 128 通过 / 2 跳过）。该首轮失败项在此后 13 次运行
中一次未复现，判定为环境抖动，已如实记录而非抹平。

新增修复：工具层参数校验（`WEB_INVALID_ARGS`）—— 已用回退实验证伪（回退后
4 项转红）。

_生成于 0.6.1。_

---

## 八、0.7.0：空壳自动渲染 + 默认抓取上限 300K

**参数变更**：`maxBodyChars` 默认 100,000 → **300,000**（输出上限 `maxOutputChars`
200,000 不变，两道闸门职责分离）。

实测代价（同一进程，`--expose-gc`）：单页 RSS 增量 9.6 MB → 13.4 MB；进程常驻
60 MB → 75 MB。显存不受工具影响；真正会落到显存的是输出字符数（MDN 11,823 →
64,693），由 `maxOutputChars` 独立控制。

**新增 `BrowserFetchProvider` + `withRenderFallback`**（默认开启）：静态正文
<1500 字符或 `<table>` 骨架 ≤3 行 → 浏览器渲染 → 与静态比较，**只有赢才采用**。

十站点实测：6 个渲染胜（东方财富 0→22 表行、业绩报表 2→54 行、同花顺 5→1152
字符、B站 515→5146、巨潮 17→52 行），2 个静态胜（网易云 17640→484、MDN
40023→28320），2 个渲染也救不了（抖音、国家统计局 403）。未触发页面 82–681 ms，
触发页面 2.1–3.0 s。

### 两个自己引入、被全量测试抓出的缺陷

| 缺陷 | 修复 | 证伪 |
| --- | --- | --- |
| 回退链绕过 SSRF 策略（跨源重定向被拒后浏览器跟着跳） | 策略类错误不回退，能力类错误照常 | 移除检查后对应断言转红 |
| 缓存层包在回退链内侧 → 索引存空壳、检索不到刚抓的页 | 缓存包在整个链外 | 装配顺序修正后测试恢复 |

### 回归

156 项 / 154 通过 / 0 失败 / 2 跳过（DDG 不可达、360 限流，环境限制）。
**连续 4 次全量运行一致**。`npm run check` 8 项 0 必需失败。

宿主项目（无 playwright）复验：安装 8 包、搜索 8 条、抓取 229,474 字符、
空壳页优雅降级（`rendered: undefined`，不崩不挂）、`dispose()` 后正常退出。

_生成于 0.7.0。_

---

## 九、0.7.1：发布后审计发现的修正（文档与文案）

对 0.7.0 做了一次发布后审计（远端 69 文件与本地逐字节一致、Release 资产
154,505 B 与本地 tgz 一致、无令牌泄漏），发现四处问题。本版修正其中由用户
确认的两类（安全表述 + 文案），另有一处量化后决定只记录不改代码。

### 修正

| # | 问题 | 处理 |
| --- | --- | --- |
| P1 | README 的 SSRF 段宣称"地址被 pin 进连接，DNS 无法在校验与连接之间改变"，该保证**只对 HTTP provider 成立**；新增的渲染路径做不到（浏览器自行解析 DNS、自行跟随重定向）。相邻段落给出强保证而新路径无此能力，会造成虚假安全感 | 限定该保证的适用范围；Render assist 段与 Security notes 各补一条，明确列出三个无法从页内修补的缺口（校验/连接之间的 DNS rebinding、页面自身脚本请求、重定向链中途不可观测） |
| P3a | 缺少 playwright 时，抓取场景报 "browser **search** requires..." —— 复用搜索 provider 文案，把读者引向错误的文档章节 | 文案按用途分说：`missingPlaywrightMessage(purpose)`；`BrowserFetchProvider` 建池时声明 `purpose:'fetch'` |
| P3b | `isError: true` 时 `value` 为 `undefined`，EMBEDDING 只说"检查 isError"，未明说宿主读 `value.statusCode` 会抛 TypeError（本次审计实测踩中） | 明确写入取值约定 |

### 记录但不改代码

**评分口径不对称**：静态侧用 `extract(rawHTML)`，渲染侧用
`extract(cleanedHTML)`（renderer 默认清洗），两侧口径不同。实测东方财富
`1401 → 705`（−50%），渲染侧被系统性低估。

方向是保守的（更倾向保留静态，**不会错误采用更差的渲染结果**）。四个站点
量化后 shell 判定**全部不变**（网易云/巨潮/MDN 偏差 0%）。统一口径会让静态
侧数值下降、推高浏览器启动率，而收益未获证实，故维持现状并记录。

### 验证

新增 2 项测试（共 158 项 / 156 通过 / 0 失败 / 2 跳过），两条均已证伪：
去掉 `purpose` 传递 → 第 11 项转红；把消息改回恒用 "browser search" →
第 10 项转红。宿主项目（无 playwright）实测两种语境消息确实分说。

_生成于 0.7.1。_
