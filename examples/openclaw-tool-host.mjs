/**
 * OpenClaw-style host: real search, real fetch, correct lifecycle.
 *
 * This is the shape to copy into a long-running agent process. It shows the
 * four things that bite when embedding:
 *
 *   1. one kit for the life of the process, not one per request
 *   2. dispose() on every exit path, or Node hangs on the browser child
 *   3. an explicit index dir, or the index lands in whatever cwd you started in
 *   4. routing on `code`, never on message text
 *
 *   npm run build && node examples/openclaw-tool-host.mjs [query...]
 */
import { createWebKit, webToolPromptSections } from 'dsh-web-kit'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const query = process.argv.slice(2).join(' ') || 'deepseek 开源 模型'

// The index is opt-in. Given explicitly, so it never depends on cwd.
const indexDir = await mkdtemp(join(tmpdir(), 'dsh-web-kit-example-'))

const kit = createWebKit({
  search: { kind: 'http-first' },          // scrape Bing over HTTP; browser only if that fails
  index: { dir: indexDir },                // remember fetched pages, searchable offline
  searchMaxResults: 5,
  fetchMaxOutputChars: 40_000,
})

const byName = new Map(kit.tools.map(def => [def.name, def]))

// Exit paths. Skipping these is how a host ends up not shutting down.
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  await kit.dispose()
  await rm(indexDir, { recursive: true, force: true })
}
process.on('SIGINT', () => { void shutdown().then(() => process.exit(0)) })
process.on('SIGTERM', () => { void shutdown().then(() => process.exit(0)) })

console.log('system prompt:')
for (const s of webToolPromptSections({ search: true, fetch: true })) console.log('  -', s)

// --- 1. search --------------------------------------------------------------
const search = byName.get('web_search')
const started = Date.now()
const found = await search.handler({ queries: [query] }, { signal: AbortSignal.timeout(30_000) })
console.log(`\nsearch ${Date.now() - started}ms isError=${found.isError} code=${found.code ?? '-'}`)

if (found.isError) {
  // Route on the code. `WEB_PROVIDER_UNAVAILABLE` means the tool is broken,
  // not that the internet lacks the answer — do not let the model conclude
  // the latter.
  console.error('search failed:', found.code, found.text)
  await shutdown()
  process.exitCode = 1
} else {
  for (const s of found.value.sources) console.log(`  - ${s.title ?? s.url}\n    ${s.url}`)

  // --- 2. fetch the first hit ----------------------------------------------
  const first = found.value.sources[0]
  if (first !== undefined) {
    const fetchTool = byName.get('web_fetch')
    const page = await fetchTool.handler({ url: first.url }, { signal: AbortSignal.timeout(30_000) })
    if (page.isError) {
      console.log(`\nfetch failed: ${page.code ?? '-'} ${page.text.slice(0, 120)}`)
    } else {
      console.log(`\nfetch ${page.value.statusCode} ${page.value.body.kind} ${page.value.body.content.length} chars`)
      console.log('  ', page.value.body.content.slice(0, 200).replace(/\s+/g, ' '))
    }
  }

  // --- 3. that page is now in the index; query it without the network ------
  // `kit.index` is the LocalIndexSearchProvider. This searches only what this
  // process has already fetched — no upstream call at all.
  const indexed = await kit.index.search({ query })
  console.log(`\nlocal-index hits (offline): ${indexed.sources.length}`)
  for (const s of indexed.sources.slice(0, 3)) console.log(`  - ${s.title ?? s.url}`)
}

await shutdown()
console.log('\nshut down cleanly')
