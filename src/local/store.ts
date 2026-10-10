/**
 * On-disk document store backing the local index.
 *
 * Every page fetched through {@link CachingFetchProvider} lands here, and
 * {@link LocalIndexSearchProvider} searches what has accumulated. That turns
 * ordinary browsing into a personal index you can search offline, with no
 * external service and nothing to pay for.
 *
 * Storage is one JSON file per document under a directory — no database, no
 * native module, safe to inspect and delete by hand.
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/local/store
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A page kept in the local index. */
export interface StoredDoc {
  /** Stable id: a hash of the url. */
  readonly id: string
  readonly url: string
  readonly title: string
  /** Extracted article text, not raw HTML. */
  readonly text: string
  /** ISO-8601 timestamp of when it was stored. */
  readonly storedAt: string
  readonly chars: number
}

/** What callers supply when storing a page. */
export interface StoredDocInput {
  readonly url: string
  readonly title?: string
  readonly text: string
}

/** Derive the stable id for a url. */
export function docId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32)
}

/**
 * A filesystem-backed document store.
 *
 * Writes are atomic-ish: the file is created lazily and replaced wholesale, so
 * a crash mid-write can lose one document but never corrupts the directory.
 */
export class DocStore {
  /** @param dir directory holding one JSON file per document. */
  constructor(readonly dir: string) {}

  /** Create the directory if needed. Called automatically by writes. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  /** Store (or replace) one document. */
  async put(input: StoredDocInput): Promise<StoredDoc> {
    await this.init()
    const doc: StoredDoc = {
      id: docId(input.url),
      url: input.url,
      title: input.title ?? '',
      text: input.text,
      storedAt: new Date().toISOString(),
      chars: input.text.length,
    }
    await writeFile(this.path(doc.id), JSON.stringify(doc), 'utf8')
    return doc
  }

  /** Read one document, or `null` when absent. */
  async get(id: string): Promise<StoredDoc | null> {
    try {
      return JSON.parse(await readFile(this.path(id), 'utf8')) as StoredDoc
    } catch {
      return null
    }
  }

  /** Look up by url rather than id. */
  async getByUrl(url: string): Promise<StoredDoc | null> {
    return this.get(docId(url))
  }

  /** Every stored document. Unreadable files are skipped, not fatal. */
  async all(): Promise<StoredDoc[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch {
      return []
    }
    const docs: StoredDoc[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        docs.push(JSON.parse(await readFile(join(this.dir, entry), 'utf8')) as StoredDoc)
      } catch {
        // A partially written file is skipped; it will be replaced on re-fetch.
      }
    }
    return docs
  }

  /** Number of stored documents. */
  async size(): Promise<number> {
    return (await this.all()).length
  }

  /** Delete one document. */
  async delete(id: string): Promise<void> {
    await rm(this.path(id), { force: true })
  }

  /** Delete everything. */
  async clear(): Promise<void> {
    for (const doc of await this.all()) await this.delete(doc.id)
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`)
  }
}
