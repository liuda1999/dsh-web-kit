/**
 * Minimal host, no network, no browser.
 *
 * Proves the integration shape — register the tools, call them, read
 * `ToolOutcome` — without depending on a search engine being reachable. Run it
 * right after `npm install`:
 *
 *   npm run build && node examples/minimal-host.mjs
 *
 * The search provider here is a fake. Swap it for a real backend (or omit
 * `search` entirely for the default) and nothing else changes.
 */
import { createWebKit, webToolPromptSections } from 'dsh-web-kit'

/** A stand-in search provider: the only contract is `{ id, available, search }`. */
const fakeSearch = {
  id: 'fake-search',
  available: () => true,
  async search(request) {
    return {
      sources: [
        { url: 'https://example.com/a', title: 'Result A', snippet: `Query was: ${request.query}` },
        { url: 'https://example.com/b', title: 'Result B' },
      ],
      truncated: false,
    }
  },
}

// No fetch provider: this example must not touch the network.
const kit = createWebKit({ search: { kind: 'custom', provider: fakeSearch }, disableFetch: true })

// --- what a host does with the definitions ---------------------------------
const registry = new Map()
for (const def of kit.tools) {
  registry.set(def.name, { schema: def.parameters, run: def.handler })
}

console.log('registered:', [...registry.keys()].join(', '))
console.log('system-prompt sections:')
for (const section of webToolPromptSections({ search: true, fetch: false })) console.log('  -', section)

// --- a call ------------------------------------------------------------------
const out = await registry.get('web_search').run({ queries: ['hello world'] })
console.log(`\nisError=${out.isError} sources=${out.value.sources.length}`)
console.log(out.text)

// --- a call the model got wrong ------------------------------------------------
const bad = await registry.get('web_search').run({ query: 'hello world' })
console.log(`\nwrong field -> isError=${bad.isError} code=${bad.code}`)
console.log('  ', bad.text)

await kit.dispose()
console.log('\ndisposed; the process should now exit by itself')
