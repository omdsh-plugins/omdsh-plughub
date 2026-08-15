/**
 * The registry catalog source: one curated JSON manifest, one request.
 *
 * Preferred over enumeration because it is a single fetch that already carries
 * every plugin's metadata, and because it is the upstream's chance to say what
 * it actually recommends — enumeration can only report what happens to exist.
 *
 * Everything in the response is untrusted. Names and specifiers pass an
 * allowlist, metadata is normalized by the same reader that handles a local
 * package.json, and an entry that fails any of it is dropped rather than
 * failing the whole manifest: one malformed row must not cost the upstream its
 * entire catalog.
 * @module @omdsh-plugins/omdsh-plughub/catalog/registry
 */

import { readPlughubMetadata } from '../manifest.ts'
import {
  isInstallableSpec, isPackageName, report,
  type FetchLike, type SourceEntry, type SourceResult,
} from './source.ts'

export type { FetchLike, FetchResponse } from './source.ts'

/** The default manifest location for an upstream account: a `registry` repo at its default branch. */
export function defaultRegistryUrl(upstream: string): string {
  return `https://raw.githubusercontent.com/${upstream}/registry/HEAD/registry.json`
}

/** Whether a value is a plain data object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One string field, when it is a non-empty string. */
function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * `owner/repo` when the row names one usably.
 * @param row - the raw registry row.
 * @returns the repository, or undefined.
 */
function repoField(row: Record<string, unknown>): string | undefined {
  const repo = stringField(row, 'repo')
  return repo !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo) ? repo : undefined
}

/**
 * Read one registry row into an entry.
 *
 * A row may omit `spec`, in which case it must name a `repo` and the specifier
 * is derived as `github:<repo>` — the common case, and one less thing for a
 * catalog author to get wrong.
 * @param row - the raw row.
 * @returns the entry, or undefined when the row is unusable.
 */
export function readRegistryRow(row: unknown): SourceEntry | undefined {
  if (!isRecord(row)) return undefined
  const name = stringField(row, 'name')
  if (name === undefined || !isPackageName(name)) return undefined
  const repo = repoField(row)
  const declared = stringField(row, 'spec')
  const spec = declared ?? (repo === undefined ? undefined : `github:${repo}`)
  // No path arm: a remote manifest naming a filesystem path would install
  // whatever this machine happens to have at that path.
  if (spec === undefined || !isInstallableSpec(spec)) return undefined
  const version = stringField(row, 'version')
  const description = stringField(row, 'description')
  return {
    name,
    ...version === undefined ? {} : { version },
    ...repo === undefined ? {} : { repo },
    ...description === undefined ? {} : { description },
    metadata: readPlughubMetadata(row['plughub'], name),
    spec,
  }
}

/**
 * Read a whole registry document: `{ plugins: [...] }`, or a bare array.
 * @param document - the parsed response body.
 * @returns the entries it yields, in document order.
 */
export function readRegistryDocument(document: unknown): SourceEntry[] {
  const rows = Array.isArray(document)
    ? document
    : isRecord(document) && Array.isArray(document['plugins']) ? document['plugins'] : undefined
  if (rows === undefined) return []
  const entries: SourceEntry[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const entry = readRegistryRow(row)
    // First row wins within one document: a duplicate is the author's
    // mistake, and picking the later one would make the catalog depend on
    // where in the file the mistake happens to sit.
    if (entry === undefined || seen.has(entry.name)) continue
    seen.add(entry.name)
    entries.push(entry)
  }
  return entries
}

/**
 * Fetch and read one registry manifest.
 * @param url - the manifest URL.
 * @param options - the fetch implementation and its timeout.
 * @returns the entries and how the fetch fared.
 */
export async function fetchRegistrySource(
  url: string,
  options: { readonly fetch: FetchLike; readonly timeoutMs: number },
): Promise<SourceResult> {
  try {
    const response = await options.fetch(url, { signal: AbortSignal.timeout(options.timeoutMs) })
    if (!response.ok) {
      // A 404 is the ordinary state of an upstream that has not published a
      // manifest, so it must read as "this source has nothing", not as a
      // broken hub — the enumeration source is what covers that case.
      throw new Error(`${url} answered ${String(response.status)}`)
    }
    const entries = readRegistryDocument(JSON.parse(await response.text()))
    return { report: report('registry', url, entries), entries }
  } catch (error) {
    return { report: report('registry', url, [], error), entries: [] }
  }
}
