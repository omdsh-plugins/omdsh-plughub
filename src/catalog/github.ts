/**
 * The enumeration catalog source: ask GitHub what an account owns, then ask
 * each repository whether it is a dsh bundle.
 *
 * The fallback, never the preference. It costs one request per repository, it
 * is rate-limited to 60/hour unauthenticated, and it can only report what
 * exists — a repository that is a plugin but not one the upstream recommends
 * looks exactly like one that is. It earns its place by needing no maintenance
 * at all: push a plugin repo to the account and it appears.
 *
 * ## The two endpoints
 *
 * `/users/<owner>/repos` serves personal accounts AND organizations, so it is
 * tried first; `/orgs/<owner>/repos` is the retry for the cases where it does
 * not. `omdsh-plugins` is a personal account today and may well become an
 * organization, and a hub that broke on that day would be a poor hub.
 * @module @omdsh-plugins/omdsh-plughub/catalog/github
 */

import { parseManifest } from '../manifest.ts'
import { isPackageName, report, type FetchLike, type SourceEntry, type SourceResult } from './source.ts'

/** Owner names GitHub itself accepts; anything else is not asked about. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/** How many package.json reads are in flight at once. */
const CONCURRENCY = 6

/** What this source needs to do its work. */
export interface GithubSourceOptions {
  readonly fetch: FetchLike
  readonly timeoutMs: number
  /** A token lifts the 60/hour anonymous rate limit; absent is the ordinary case. */
  readonly token?: string | undefined
  /** Upper bound on repositories examined, so a large account cannot hang the panel. */
  readonly maxRepos: number
}

/** Request headers: the API version GitHub asks callers to pin, plus any token. */
function headers(token: string | undefined): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'omdsh-plughub',
    ...token === undefined || token === '' ? {} : { authorization: `Bearer ${token}` },
  }
}

/** One repository, as much of the listing as this source reads. */
export interface RepoRow {
  readonly name: string
  readonly description?: string
  readonly archived: boolean
  readonly fork: boolean
}

/**
 * Read a repository listing response body.
 * @param document - the parsed body.
 * @returns the usable rows, skipping archives and forks.
 */
export function readRepoListing(document: unknown): RepoRow[] {
  if (!Array.isArray(document)) return []
  const rows: RepoRow[] = []
  for (const raw of document) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    const name = row['name']
    if (typeof name !== 'string' || name === '') continue
    const description = row['description']
    // An archive is not installable in any useful sense and a fork is
    // somebody else's plugin wearing this account's name; both would only
    // clutter a list whose whole job is "what can I install from here".
    if (row['archived'] === true || row['fork'] === true) continue
    rows.push({
      name,
      ...typeof description === 'string' && description !== '' ? { description } : {},
      archived: false,
      fork: false,
    })
  }
  return rows
}

/**
 * List an account's repositories, trying the user endpoint then the org one.
 * @param owner - the account name.
 * @param options - fetch, timeout, token, and the cap.
 * @returns the rows, capped.
 * @throws when neither endpoint answers.
 */
export async function listRepos(owner: string, options: GithubSourceOptions): Promise<RepoRow[]> {
  const failures: string[] = []
  for (const kind of ['users', 'orgs'] as const) {
    const url = `https://api.github.com/${kind}/${owner}/repos?per_page=100&type=owner&sort=full_name`
    try {
      const response = await options.fetch(url, {
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: headers(options.token),
      })
      if (!response.ok) {
        failures.push(`${kind} answered ${String(response.status)}`)
        continue
      }
      return readRepoListing(JSON.parse(await response.text())).slice(0, options.maxRepos)
    } catch (error) {
      failures.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(failures.join('; '))
}

/**
 * Read one repository's package.json at its default branch.
 * @param owner - the account.
 * @param repo - the repository row.
 * @param options - fetch and timeout.
 * @returns the entry, or undefined when the repository is not a dsh bundle.
 */
export async function readRepoEntry(
  owner: string,
  repo: RepoRow,
  options: GithubSourceOptions,
): Promise<SourceEntry | undefined> {
  // `HEAD` rather than a branch name: an upstream that renamed its default
  // branch must not disappear from the catalog for it.
  const url = `https://raw.githubusercontent.com/${owner}/${repo.name}/HEAD/package.json`
  let text: string
  try {
    const response = await options.fetch(url, { signal: AbortSignal.timeout(options.timeoutMs) })
    if (!response.ok) return undefined
    text = await response.text()
  } catch {
    // One unreachable repository is not a broken catalog.
    return undefined
  }
  const facts = parseManifest(text)
  if (facts?.isBundle !== true || facts.name === undefined || !isPackageName(facts.name)) return undefined
  const description = facts.description ?? repo.description
  return {
    name: facts.name,
    ...facts.version === undefined ? {} : { version: facts.version },
    repo: `${owner}/${repo.name}`,
    ...description === undefined ? {} : { description },
    metadata: facts.metadata,
    // Built here from an owner this deployment configured and a repository
    // name GitHub returned, so it never passes through anyone's manifest.
    spec: `github:${owner}/${repo.name}`,
  }
}

/**
 * Run `worker` over `items` with a bounded number in flight.
 * @param items - the work.
 * @param limit - how many may be in flight.
 * @param worker - what to do with one item.
 * @returns the results, in input order.
 */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      const item = items[index]
      if (item === undefined) return
      results[index] = await worker(item)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Enumerate one account's plugin repositories.
 * @param owner - the upstream account name.
 * @param options - fetch, timeout, token, and the repository cap.
 * @returns the entries and how the enumeration fared.
 */
export async function fetchGithubSource(owner: string, options: GithubSourceOptions): Promise<SourceResult> {
  if (!OWNER.test(owner)) {
    return { report: report('github', owner, [], new Error(`"${owner}" is not a GitHub account name`)), entries: [] }
  }
  let repos: RepoRow[]
  try {
    repos = await listRepos(owner, options)
  } catch (error) {
    return { report: report('github', owner, [], error), entries: [] }
  }
  const found = await mapBounded(repos, CONCURRENCY, repo => readRepoEntry(owner, repo, options))
  const entries = found.filter((entry): entry is SourceEntry => entry !== undefined)
  return { report: report('github', owner, entries), entries }
}
