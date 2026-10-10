
> dsh-web-kit@0.6.0 report
> tsc -p tsconfig.json && node scripts/extract-report.mjs

# 正文抽取保留率实测报告

生成时间：2026-10-10 00:01:42 (UTC)

每一列是在同一份 fixture 上切换 mode，`✓` 表示该项内容在 `extractMainContent().text` 中存活。

## 模式策略

| 模式 | semanticTags | chromeHeuristics | crop | includeImages | includeForms | includeMedia | maxLossRatio |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `full` | false | false | false | true | true | true | 0 |
| `gentle` | true | false | true | true | true | true | 0.65 |
| `standard` | true | true | true | true | true | false | 0.65 |
| `aggressive` | true | true | true | false | false | false | 0.9 |

## API 参考页

结构：表格 / 代码块 / 定义列表 / details / 广告 / 脚本

| 内容项 | `full` | `gentle` | `standard` | `aggressive` |
| --- | --- | --- | --- | --- |
| 表格单元格 | ✓ | ✓ | ✓ | ✓ |
| 表格脚注(colspan) | ✓ | ✓ | ✓ | ✓ |
| 代码块 | ✓ | ✓ | ✓ | ✓ |
| 定义列表 | ✓ | ✓ | ✓ | ✓ |
| details 摘要 | ✓ | ✓ | ✓ | ✓ |
| details 正文 | ✓ | ✓ | ✓ | ✓ |

| 指标 | `full` | `gentle` | `standard` | `aggressive` |
| --- | --- | --- | --- | --- |
| 选中块 `picked` | `—` | `article` | `article` | `article` |
| 回退原因 `fallback` | `mode` | `none` | `none` | `none` |
| 保留率 `retained` | 1.000 | 0.955 | 0.955 | 0.955 |
| 文本长度 | 1201 | 1011 | 1011 | 1011 |

## 图文混排文章

结构：figure / figcaption / picture / 内联 SVG 架构图

| 内容项 | `full` | `gentle` | `standard` | `aggressive` |
| --- | --- | --- | --- | --- |
| 图片 alt | ✓ | ✓ | ✓ | ✗ |
| 第二张图 alt | ✓ | ✓ | ✓ | ✗ |
| 图注 | ✓ | ✓ | ✓ | ✓ |
| SVG 文字标签 | ✓ | ✓ | ✗ | ✗ |
| SVG 第三个标签 | ✓ | ✓ | ✗ | ✗ |
| 正文段落 | ✓ | ✓ | ✓ | ✓ |

| 指标 | `full` | `gentle` | `standard` | `aggressive` |
| --- | --- | --- | --- | --- |
| 选中块 `picked` | `—` | `article` | `article` | `article` |
| 回退原因 `fallback` | `mode` | `none` | `none` | `none` |
| 保留率 `retained` | 1.000 | 0.958 | 0.957 | 0.951 |
| 文本长度 | 1224 | 1007 | 973 | 846 |

## 设置控制台(表单密集)

结构：input / select / textarea / checkbox / password / hidden

| 内容项 | `full` | `gentle` | `standard` | `aggressive` |
| --- | --- | --- | --- | --- |
| 字段标签 | ✓ | ✓ | ✓ | ✗ |
| input 值 | ✓ | ✓ | ✓ | ✗ |
| placeholder 兜底 | ✓ | ✓ | ✓ | ✗ |
| select 选项 | ✓ | ✓ | ✓ | ✗ |
| textarea 正文 | ✓ | ✓ | ✓ | ✗ |
| 提交按钮 | ✓ | ✓ | ✓ | ✗ |
| 分组 legend | ✓ | ✓ | ✓ | ✗ |

| 指标 | `full` | `gentle` | `standard` | `aggressive` |
| --- | --- | --- | --- | --- |
| 选中块 `picked` | `—` | `main` | `main` | `—` |
| 回退原因 `fallback` | `mode` | `none` | `none` | `no-block` |
| 保留率 `retained` | 1.000 | 0.943 | 0.943 | 1.000 |
| 文本长度 | 749 | 615 | 615 | 268 |

## 嵌入媒体页

结构：iframe 示例 / video 字幕轨 / canvas 回退文本

| 内容项 | `full` | `gentle` | `standard` | `aggressive` |
| --- | --- | --- | --- | --- |
| iframe 标题 | ✓ | ✓ | ✗ | ✗ |
| 字幕轨标签 | ✓ | ✓ | ✗ | ✗ |
| 第二字幕轨 | ✓ | ✓ | ✗ | ✗ |
| canvas 回退文本 | ✓ | ✓ | ✗ | ✗ |
| 正文段落 | ✓ | ✓ | ✓ | ✓ |

| 指标 | `full` | `gentle` | `standard` | `aggressive` |
| --- | --- | --- | --- | --- |
| 选中块 `picked` | `—` | `article` | `article` | `article` |
| 回退原因 `fallback` | `mode` | `none` | `none` | `none` |
| 保留率 `retained` | 1.000 | 0.951 | 0.939 | 0.939 |
| 文本长度 | 733 | 604 | 475 | 475 |

## 仪表盘(无主文章块)

结构：指标卡 / 告警表格 / 活动列表 / 运维备注

| 内容项 | `full` | `gentle` | `standard` | `aggressive` |
| --- | --- | --- | --- | --- |
| 指标卡标签 | ✓ | ✓ | ✓ | ✓ |
| 指标值 | ✓ | ✓ | ✓ | ✓ |
| 告警表格行 | ✓ | ✓ | ✓ | ✓ |
| 活动列表项 | ✓ | ✓ | ✓ | ✓ |
| 运维备注 | ✓ | ✓ | ✓ | ✓ |

| 指标 | `full` | `gentle` | `standard` | `aggressive` |
| --- | --- | --- | --- | --- |
| 选中块 `picked` | `—` | `main` | `main` | `main` |
| 回退原因 `fallback` | `mode` | `none` | `none` | `none` |
| 保留率 `retained` | 1.000 | 0.970 | 0.970 | 0.970 |
| 文本长度 | 971 | 852 | 852 | 852 |

## 安全边界

以下取值存在于 fixture 源码中，任何模式都不得将其写入文本：

| 敏感项 | `full` | `gentle` | `standard` | `aggressive` |
| --- | --- | --- | --- | --- |
| CSRF token (hidden input) 未泄漏 | ✓ | ✓ | ✓ | ✓ |
| 隐藏版本号 (hidden input) 未泄漏 | ✓ | ✓ | ✓ | ✓ |
| 密码输入框取值 未泄漏 | ✓ | ✓ | ✓ | ✓ |

