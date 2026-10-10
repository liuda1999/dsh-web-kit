/**
 * Content-retention report for the page extractor.
 *
 * The unit tests assert expectations; this reports measurements. It runs every
 * fixture through every mode and prints what each one kept, so a change to the
 * modes can be read as a diff of consequences rather than a pass/fail verdict.
 *
 * Usage: `node scripts/extract-report.mjs [> report.md]`
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Resolved as URLs: this repository can sit under a non-ASCII path, which trips
// the relative specifier resolver.
const DIST = new URL('../dist/', import.meta.url)
const { extractMainContent, EXTRACT_MODES } = await import(DIST + 'filter/extract.js')

const fixtures = new URL('../tests/fixtures/', import.meta.url)
const load = (name) => readFileSync(fileURLToPath(new URL(name, fixtures)), 'utf8')

const MODES = ['full', 'gentle', 'standard', 'aggressive']

/** Probes grouped by the kind of page structure each one proves. */
const CASES = [
  {
    file: 'complex-api-reference.html',
    name: 'API 参考页',
    structure: '表格 / 代码块 / 定义列表 / details / 广告 / 脚本',
    probes: {
      '表格单元格': /frequency_penalty/,
      '表格脚注(colspan)': /HTTP 400 before scheduling/,
      '代码块': /Authorization: Bearer/,
      '定义列表': /Nucleus sampling cutoff/,
      'details 摘要': /Why the range is narrower/,
      'details 正文': /KV cache/,
    },
  },
  {
    file: 'complex-illustrated.html',
    name: '图文混排文章',
    structure: 'figure / figcaption / picture / 内联 SVG 架构图',
    probes: {
      '图片 alt': /Pipeline with three worker lanes/,
      '第二张图 alt': /exponential backoff and jitter/,
      '图注': /Figure 1:/,
      'SVG 文字标签': /IngestStage/,
      'SVG 第三个标签': /DrainStage/,
      '正文段落': /idempotent end to end/,
    },
  },
  {
    file: 'complex-settings-console.html',
    name: '设置控制台(表单密集)',
    structure: 'input / select / textarea / checkbox / password / hidden',
    probes: {
      '字段标签': /Bind host/,
      'input 值': /127\.0\.0\.1/,
      'placeholder 兜底': /upstream\.example\.com/,
      'select 选项': /throughput/,
      'textarea 正文': /Rotated the upstream certificate/,
      '提交按钮': /Save changes/,
      '分组 legend': /Scheduling/,
    },
  },
  {
    file: 'complex-media-embed.html',
    name: '嵌入媒体页',
    structure: 'iframe 示例 / video 字幕轨 / canvas 回退文本',
    probes: {
      'iframe 标题': /Resizable two column grid sample/,
      '字幕轨标签': /English captions/,
      '第二字幕轨': /Chinese captions/,
      'canvas 回退文本': /does not support the canvas preview/,
      '正文段落': /starting from an unstyled list/,
    },
  },
  {
    file: 'complex-dashboard.html',
    name: '仪表盘(无主文章块)',
    structure: '指标卡 / 告警表格 / 活动列表 / 运维备注',
    probes: {
      '指标卡标签': /Nodes reporting/,
      '指标值': /99\.2%/,
      '告警表格行': /Disk pressure above ninety percent/,
      '活动列表项': /rebalanced four shards/,
      '运维备注': /on-call rotation/,
    },
  },
]

/** Secrets that must never be recovered from any page, in any mode. */
const SECRETS = [
  ['CSRF token (hidden input)', /8f14e45fceea167a5a36dedd4bea2543/],
  ['隐藏版本号 (hidden input)', /7719/],
  ['密码输入框取值', /super-secret-value/],
]

const tick = (hit) => (hit ? '✓' : '✗')

const lines = []
lines.push('# 正文抽取保留率实测报告')
lines.push('')
lines.push(`生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')} (UTC)`)
lines.push('')
lines.push('每一列是在同一份 fixture 上切换 mode，`✓` 表示该项内容在 `extractMainContent().text` 中存活。')
lines.push('')

lines.push('## 模式策略')
lines.push('')
lines.push('| 模式 | semanticTags | chromeHeuristics | crop | includeImages | includeForms | includeMedia | maxLossRatio |')
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
for (const mode of MODES) {
  const spec = EXTRACT_MODES[mode]
  lines.push(`| \`${mode}\` | ${spec.semanticTags} | ${spec.chromeHeuristics} | ${spec.crop} | ${spec.includeImages} | ${spec.includeForms} | ${spec.includeMedia} | ${spec.maxLossRatio} |`)
}
lines.push('')

for (const testCase of CASES) {
  lines.push(`## ${testCase.name}`)
  lines.push('')
  lines.push(`结构：${testCase.structure}`)
  lines.push('')
  const labels = Object.keys(testCase.probes)
  lines.push(`| 内容项 | ${MODES.map(m => `\`${m}\``).join(' | ')} |`)
  lines.push(`| --- | ${MODES.map(() => '---').join(' | ')} |`)
  for (const label of labels) {
    const pattern = testCase.probes[label]
    const marks = MODES.map(mode => tick(pattern.test(extractMainContent(load(testCase.file), { mode }).text)))
    lines.push(`| ${label} | ${marks.join(' | ')} |`)
  }
  lines.push('')
  lines.push('| 指标 | ' + MODES.map(m => `\`${m}\``).join(' | ') + ' |')
  lines.push('| --- | ' + MODES.map(() => '---').join(' | ') + ' |')
  const rows = {
    '选中块 `picked`': r => `\`${r.picked ?? '—'}\``,
    '回退原因 `fallback`': r => `\`${r.fallback}\``,
    '保留率 `retained`': r => r.retained.toFixed(3),
    '文本长度': r => String(r.text.length),
  }
  for (const [label, render] of Object.entries(rows)) {
    const values = MODES.map(mode => render(extractMainContent(load(testCase.file), { mode })))
    lines.push(`| ${label} | ${values.join(' | ')} |`)
  }
  lines.push('')
}

lines.push('## 安全边界')
lines.push('')
lines.push('以下取值存在于 fixture 源码中，任何模式都不得将其写入文本：')
lines.push('')
lines.push('| 敏感项 | ' + MODES.map(m => `\`${m}\``).join(' | ') + ' |')
lines.push('| --- | ' + MODES.map(() => '---').join(' | ') + ' |')
for (const [label, pattern] of SECRETS) {
  const html = load('complex-settings-console.html')
  const marks = MODES.map(mode => tick(!pattern.test(extractMainContent(html, { mode }).text)))
  lines.push(`| ${label} 未泄漏 | ${marks.join(' | ')} |`)
}
lines.push('')

const report = lines.join('\n')
console.log(report)
