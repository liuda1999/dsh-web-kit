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

Documentation and wording fixes from a post-release audit of v0.7.0. One error
message changes; nothing else behaves differently.

### The DNS-pinning guarantee now says what it covers

The README claimed hostnames are "pinned into the connection so DNS cannot
change between check and connect". That is true of the HTTP provider — and it
was printed one section away from the newly added render assist, which
**cannot** offer it. A browser resolves names itself and follows redirects
itself, so a name that passed the check can be answered differently by the time
the browser dials. A strong guarantee printed next to a path that lacks it is
worse than no guarantee at all.

The claim is now scoped to the HTTP provider, and both the render-assist section
and Security notes list the three gaps that cannot be closed from inside the
page:

1. **DNS rebinding between check and connect** — the browser resolves the name
   again when it dials, and intermediate redirects are followed before the
   landing URL can be judged.
2. **Requests the page's own scripts make** — an \`<img>\` or a \`fetch()\` in
   page context reaches whatever it addresses.
3. **Redirect chains are observable only at their end** — one that touches a
   private address and returns to a public one is invisible from here.

Policy refusals were already never retried through the browser; that is now
stated as well. The advice is unchanged and now explicit: if the host can reach
an internal network, run the browser somewhere that cannot.

### Fixed

- **A missing \`playwright\` was reported in the wrong voice.** Fetch-side
  failures read *"browser **search** requires the optional dependency..."*,
  because the pool is shared with search and the wording was not. The fetch path
  now reads *"browser rendering of a fetched page requires..."* — verified in a
  host project without Playwright.
- **\`value\` is \`undefined\` when \`isError\` is \`true\`**, and the
  embedding guide did not say so. \`result.value.statusCode\` on a failed call
  throws \`Cannot read properties of undefined\`: the call fails *and* the
  failure surfaces as a TypeError in the host's own code. Both the audit and any
  host reading the field the obvious way hit this; it is now written into the
  field list.

### Measured, recorded, deliberately not changed

The shell test scores the static body with \`extract(rawHTML)\` and the rendered
body with \`extract(cleanedHTML)\`, because the renderer cleans by default. On
\`quote.eastmoney.com\` that is **1,401 vs 705 — a 50% gap**, so the rendered
side is systematically under-scored.

The bias is conservative: it favours keeping the static body, so it can never
adopt a *worse* rendered result — only decline one that would have helped.
Across four sites the shell verdict did **not** change once (NetEase, cninfo and
MDN show 0% divergence). Unifying the two would lower static scores and raise
browser launch rates for an unproven benefit, so the bias is documented in
E2E-REPORT.md rather than "fixed".

### Tests

158 assertions, 156 pass, 0 fail, 2 skipped (DuckDuckGo unreachable, 360
rate-limited from this network — both environmental). Two new assertions cover
this release and both were falsified: removing the \`purpose\` hand-off turns one
red, and reverting the message to the shared wording turns the other red.

\`\`\`sh
npm install ./dsh-web-kit-${version}.tgz
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
    name: `${tag} — scoped DNS-pinning claim, fetch-side error wording`,
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
