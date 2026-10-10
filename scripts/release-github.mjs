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

**Default search backend is now \`http-first\`** — scrape-Bing over plain HTTP
first, a real browser only as a fallback. Measured on a mainland-China network
across five queries: HTTP answered in **149 ms median** against **5,558 ms**
through the browser, **37× faster**, with both paths agreeing on the top result
four times out of five. Latency on the default path is a real cost when a model
is waiting on the tool call.

Bing remains reachable by two independent paths, so losing one does not leave
you with no search at all. 360 Search throttles a single IP after roughly five
queries and DuckDuckGo is unreachable from many CN networks — both are measured
and documented, neither is in the default chain.

### Fixed

- **Baidu recommendation slots no longer outrank real results.** Sampling five
  queries through \`browser:baidu\` put \`http://28608.recommend_list.baidu.com\`
  **first three times out of five**: it carries a \`mu\` attribute pointing
  outside \`baidu.com/s?\` and \`/link?\`, so both existing checks let it through
  looking exactly like a source. Those hosts and Baidu's ad-tech hosts are now
  dropped by \`isEngineLink\`. \`browser:baidu\` returns two fewer rows than
  before — placements leaving, not results lost.
- **Tables with list / heading / \`<hr>\` cells** are Markdown now. GFM falls back
  to emitting the whole table as raw HTML wrapped in
  \`<div class="joplin-table-wrapper">\`; a local rule replaces that fallback.
  Empty-header padding and \`<caption>\` handling also work, where GFM demoted
  the data rows.
- **Single-character CJK queries could match everything.** \`tokenize\` emitted
  any isolated Han character regardless of the \`unigrams\` switch — the old
  bug returning through a new path. Isolated characters are no longer terms.
- **A mistyped request no longer returns confidently wrong results.**
  \`WebSearchRequest\` takes \`query\`, and passing \`queries\` instead made
  \`URLSearchParams.set\` stringify \`undefined\`, producing nine real-looking
  results about "JavaScript undefined" with no error. Validated centrally now.
- \`search({ query: null })\` raised a \`TypeError\` instead of the documented
  empty-query error.
- \`minChars\` and \`onlySuccessful\` are now forwarded through
  \`createWebKit({ index })\`; the 200-character storage floor is documented and
  asserted in both directions rather than being unreachable.

### Documents

- \`dispose()\` is documented as mandatory: the browser is a child process, and
  an undisposed kit finishes all its work and then never exits.
- \`README\`'s "Baidu placements are excluded structurally" claim was measured and
  found false; it now states what actually happens.

### Tests

121 assertions, 119 pass, 0 fail, 2 skipped (DuckDuckGo unreachable and 360
rate-limited from this network — both environmental). Six consecutive full runs
agree. \`npm run check\` reports 8 checks with 0 required failures.

\`\`\`sh
npm install ./dsh-web-kit-${version}.tgz   # or npm install ./dsh-web-kit-${version}-src.zip, unpacked
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
    name: `${tag} — http-first default, Baidu placement filtering`,
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
