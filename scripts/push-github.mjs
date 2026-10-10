/**
 * Push the workspace to GitHub through the Git Data API.
 *
 * `git push` does not work from this machine: the proxy answers with HTTP 000
 * for every github.com endpoint. The REST API does work, so content is uploaded
 * as blobs, one tree, one commit, and one ref update.
 *
 * Usage: node scripts/push-github.mjs <token> [message]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not `new URL().pathname`: the latter leaves percent escapes in
// non-ASCII directory names and every readdir below fails with ENOENT.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OWNER = 'liuda1999'
const REPO = 'dsh-web-kit'
const BRANCH = 'main'

const token = process.argv[2]
const message = process.argv[3] ?? 'dsh-web-kit 0.6.0'
if (token === undefined) {
  console.error('usage: node scripts/push-github.mjs <token> [message]')
  process.exit(2)
}

const SKIP = new Set([
  'node_modules', 'dist', '.git', '.workbuddy', 'scratch',
])
const SKIP_FILE = new Set(['.DS_Store'])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || entry.endsWith('.tgz') || entry.endsWith('.zip')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (!SKIP_FILE.has(entry)) out.push(full)
  }
  return out
}

const api = async (path, init = {}) => {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-web-kit-push',
      'content-type': 'application/json',
      ...init.headers ?? {},
    },
  })
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${(await response.text()).slice(0, 300)}`)
  }
  return response.status === 204 ? null : response.json()
}

const files = walk(ROOT)
console.log(`files: ${files.length}`)

// 1. Where the branch points now.
const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
const parentSha = ref.object.sha
const parent = await api(`/repos/${OWNER}/${REPO}/git/commits/${parentSha}`)
console.log(`parent commit: ${parentSha.slice(0, 7)} (${parent.tree.sha.slice(0, 7)})`)

// 2. Blobs.
const tree = []
for (const file of files) {
  const path = relative(ROOT, file).split(sep).join('/')
  const content = readFileSync(file)
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  })
  tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
  if (tree.length % 25 === 0) console.log(`  uploaded ${tree.length}/${files.length}`)
}
console.log(`  uploaded ${tree.length}/${files.length}`)

// 3. Tree, commit, ref.
const created = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ base_tree: parent.tree.sha, tree }),
})
const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: created.sha, parents: [parentSha] }),
})
await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha }),
})
console.log(`pushed ${commit.sha} -> ${BRANCH}`)
