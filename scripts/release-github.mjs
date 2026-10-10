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

**Pages that build their content in the browser are now readable.** Market
grids, data consoles and ranking boards ship an empty shell whose numbers only
exist after JavaScript runs. \`web_fetch\` now renders those in a real browser
automatically — and keeps the rendered DOM **only when it beats what HTTP
already returned**.

### Why it compares instead of just rendering

Measured on ten sites, two render *worse* than their source:

| Site | static | rendered | |
| --- | --- | --- | --- |
| \`quote.eastmoney.com\` grid | 1,401 chars, **0 rows** | 2,775 chars, **22 rows** | render wins |
| \`data.eastmoney.com\` reports | 623, 2 rows | 8,159, **54 rows** | render wins |
| \`iwencai.com\` | 5 | 1,152 | render wins |
| \`bilibili.com/video\` | 515 | 5,146 | render wins |
| \`cninfo.com.cn\` | 503, 17 rows | 1,843, **52 rows** | render wins |
| \`music.163.com\` | **17,640** | 484 | **static wins** |
| MDN | **40,023** | 28,320 | **static wins** |

A chain that swapped unconditionally would silently destroy working pages. The
trigger — main text under 1,500 characters, or a \`<table>\` skeleton holding 3
rows or fewer — sits in the empty gap between those clusters. Rows count as 50
characters each, because a row of figures is short and valuable.

Cost, stated plainly: a page that triggers takes **2–3 s** instead of **~0.2 s**
and starts a browser process. Pages that don't trigger are untouched. Nothing
launches at all when Playwright is absent. \`403\`/\`429\`/\`503\` also retry
through the renderer, since challenge pages often resolve once JavaScript runs
(\`retryOnStatus: []\` turns that off).

### Also in this release

- **\`maxBodyChars\` is now 300,000** (was 100,000). The old cap cut the tail off
  large documents, and the tail is where the prose lives — a previous release
  note blamed client rendering for what was actually this cap. The output cap
  \`maxOutputChars\` stays 200,000 and is independent, so widening what is
  fetched does not have to widen what reaches the model.
- **The rendered DOM is cleaned before it is returned.** \`douyin.com/hot\`
  renders to 799,426 characters, of which 13,702 survive cleaning; uncleaned,
  the swollen head pushes everything real out of the conversion window and the
  model receives a page title.
- **A rendered body is flagged** \`rendered: true\`, so a slow fetch can be
  explained instead of guessed at.
- With the local index on, rendered bodies are what get indexed.

### Two defects this release introduced and caught

- **The fallback chain was reversing SSRF decisions.** \`www.rust-lang.org\`
  redirects cross-origin and the HTTP provider refuses that on purpose; a
  browser follows redirects by definition, so falling back handed back the page
  the policy had just refused. Policy failures (\`WEB_REDIRECT_BLOCKED\`,
  \`WEB_BLOCKED_URL\`, \`WEB_INVALID_URL\`, \`WEB_INVALID_ARGS\`,
  \`WEB_FETCH_TOO_LARGE\`) are no longer retried; capability failures
  (timeouts, connection errors, content types) still are.
- **The cache wrapped the wrong layer**, so the index stored the empty shell
  while the caller received the rendered page, and retrieval found nothing for
  a page it had just fetched.

Both have falsifying tests: reverting either fix turns them red.

### Regression

156 assertions, **154 pass, 0 fail, 2 skipped** (DuckDuckGo unreachable and 360
rate-limited from this network — both environmental). Four consecutive full runs
agree. \`npm run check\`: 8 checks, 0 required failures.

Verified in a separate host project with \`--omit=optional\`: 8 packages, no
playwright, search returns 8 sources, a shell page degrades to its static body
without crashing or hanging, \`dispose()\` exits cleanly.

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
    name: `${tag} — browser render assist for shell pages, 300K body cap`,
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
