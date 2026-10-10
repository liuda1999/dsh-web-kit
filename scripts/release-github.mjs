/**
 * Create the GitHub release for the current version and attach the packed
 * tarball. Separate from push-github.mjs because a release is a decision, not a
 * consequence of pushing.
 *
 * Usage: node scripts/release-github.mjs <token>
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OWNER = 'liuda1999'
const REPO = 'dsh-web-kit'

const token = process.argv[2]
if (token === undefined) {
  console.error('usage: node scripts/release-github.mjs <token>')
  process.exit(2)
}

const { version } = JSON.parse(readFileSync(ROOT + 'package.json', 'utf8'))
const tag = `v${version}`
const assetPath = `${ROOT}dsh-web-kit-${version}.tgz`

const BODY = `## ${tag}

This release is about **being a component inside somebody else's agent** — an
OpenClaw-style host, a custom loop, an OpenAI-compatible gateway — rather than a
standalone capability. Everything below was measured in a **separate host
project that installed the tarball**, not inside this repository.

### Embedding

- **[EMBEDDING.md](https://github.com/${OWNER}/${REPO}/blob/main/EMBEDDING.md)** —
  the integration contract: one kit per process, \`dispose()\` on every exit
  path, \`AbortSignal\` pass-through, OpenAI-compatible \`tools\` conversion,
  where it writes on disk, the env vars that silently override provider
  selection, ESM/CJS, and what to do when a scraper returns zero results.
- **Three runnable hosts** in \`examples/\`: \`minimal-host.mjs\` (offline, fake
  provider), \`openclaw-tool-host.mjs\` (real search + fetch + lifecycle +
  index dir), \`openai-function-calling.mjs\` (schema conversion, and a real
  tool-calling round trip when \`OPENAI_BASE_URL\` is set).

### Fixed

- **Bad tool arguments are now refused legibly.** \`handler({ query: 'x' })\` —
  a model using the singular field, the single most common mistake — threw
  \`Cannot read properties of undefined (reading 'length')\`. Technically an
  error, but one the model cannot act on, so it retries the same broken call.
  Both tools now reject with \`code: 'WEB_INVALID_ARGS'\` and a message naming
  the right field: *"the field is \\\`queries\\\` (plural), an array of strings"*.
  Falsified by reverting the fix: 4 assertions go red.
- **\`playwright\` is no longer a hard dependency.** It was listed in
  \`dependencies\` *and* \`optionalDependencies\`, so every host that ran
  \`npm install dsh-web-kit\` pulled it in. Now optional only — verified: a host
  installed with \`--omit=optional\` gets 8 packages, no playwright, and the
  default backend still returns 8 sources in 214 ms.
- **\` @types/node\` moved into \`dependencies\`.** The shipped \`.d.ts\`
  references \`node:dns\` and the \`NodeJS\` namespace, so a TypeScript host
  without it got 20+ errors from inside \`node_modules\`. Verified clean:
  \`tsc --strict --noEmit\` in a fresh host project now reports 0 errors.

### Measured in a host project

| | |
| --- | --- |
| install (\`--omit=optional\`) | 8 packages, no playwright |
| default search, no playwright | 8 sources, 214 ms |
| \`require('dsh-web-kit')\` (CJS host) | 121 exports (Node 22.22) |
| TypeScript host | \`tsc --strict\` clean |
| \`AbortSignal\` cancel | 10 ms, \`WEB_ABORTED\` |
| two concurrent kits | 8 sources each |
| index dir given explicitly | writes only there, never cwd |
| index off | nothing created in cwd |
| after \`dispose()\` | process exits, no hang |

### Regression

Full suite 5 runs, E2E + browser 4 runs, remaining 4 runs: **130 assertions,
128 pass, 0 fail, 2 skipped** (DuckDuckGo unreachable and 360 rate-limited from
this network — both environmental). One intermittent failure occurred in the
very first run and did not reproduce in the 13 runs after it; it is recorded
here rather than smoothed over. \`npm run check\`: 8 checks, 0 required
failures.

\`\`\`sh
npm install ./dsh-web-kit-${version}.tgz   # or unpack dsh-web-kit-${version}-src.zip
npm run check                             # verify your own network before relying on it
\`\`\`
`

const api = async (path, init = {}) => {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-web-kit-release',
      'content-type': 'application/json',
      ...init.headers ?? {},
    },
  })
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${(await response.text()).slice(0, 400)}`)
  }
  return response.status === 204 ? null : response.json()
}

const release = await api(`/repos/${OWNER}/${REPO}/releases`, {
  method: 'POST',
  body: JSON.stringify({
    tag_name: tag,
    name: `${tag} — embedding guide, examples, validated tool arguments`,
    body: BODY,
    draft: false,
    prerelease: false,
  }),
})
console.log(`release: ${release.html_url}`)

// Assets go to a different host and are not JSON.
const asset = readFileSync(assetPath)
const upload = await fetch(`https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=dsh-web-kit-${version}.tgz`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-web-kit-release',
    'content-type': 'application/gzip',
  },
  body: asset,
})
if (!upload.ok) {
  console.error(`asset upload -> ${upload.status} ${(await upload.text()).slice(0, 300)}`)
  process.exit(1)
}
console.log(`asset: dsh-web-kit-${version}.tgz (${Math.round(asset.length / 1024)} KB)`)
