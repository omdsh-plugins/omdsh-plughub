/**
 * Merging the sources into one catalog, and holding it for a while.
 *
 * ## One name, one entry
 *
 * The three sources overlap on purpose: the same plugin can be a checkout you
 * are editing, a row in the upstream's manifest, AND a repository on the
 * account. They are merged on the package NAME, and the highest-precedence
 * source wins outright — `local` over `registry` over `github`. That order is
 * not arbitrary: it puts the copy you can see and change above the copy
 * somebody published, which is what a person editing a plugin means by "the
 * one I have".
 *
 * A losing source still contributes one thing: its `repo`, when the winner has
 * none. A local checkout rarely knows its own GitHub path, and the card's
 * documentation link is nicer for having it.
 *
 * ## Why the specifier stays here
 *
 * The merge is also where the install specifier stops. {@link CatalogDocument}
 * carries no specifier at all; {@link Catalog.specFor} is a Host-side lookup on
 * the resolution the Host itself performed. So an install request can only ever
 * name something the configured upstreams offered, and "the catalog is the
 * allowlist" is a structural property rather than a check somebody has to
 * remember to write.
 * @module @omdsh-plugins/omdsh-plughub/catalog
 */

import {
  SOURCE_PRECEDENCE,
  type CatalogDocument, type CatalogEntry, type CatalogSource, type CatalogSourceReport,
} from '../contract.ts'
import { updateStateFor } from '../version.ts'
import { fetchGithubSource } from './github.ts'
import { scanLocalSources } from './local.ts'
import { defaultRegistryUrl, fetchRegistrySource } from './registry.ts'
import type { FetchLike, SourceEntry, SourceResult } from './source.ts'

export { defaultRegistryUrl } from './registry.ts'
export type { FetchLike, FetchResponse, SourceEntry, SourceResult } from './source.ts'
export { isGitSpec, isInstallableSpec, isPackageName } from './source.ts'

/** One merged entry and the specifier that installs it. */
export interface MergedEntry {
  readonly entry: SourceEntry
  readonly source: CatalogSource
}

/** How this runtime is configured to find plugins. */
export interface CatalogOptions {
  /** GitHub account enumerated as the fallback source; empty disables it. */
  readonly upstream: string
  /** Registry manifest URL; empty disables that source. */
  readonly registryUrl: string
  /** Directories scanned as local sources. */
  readonly localSources: readonly string[]
  /** Token for the GitHub API, when one is configured. */
  readonly githubToken?: string | undefined
  /** Upper bound on repositories enumerated. */
  readonly maxRepos: number
  /** Per-request timeout for every remote source. */
  readonly timeoutMs: number
}

/** Sort key: declared order first, then name, so the list is stable across resolutions. */
function compareEntries(a: SourceEntry, b: SourceEntry): number {
  const byOrder = a.metadata.order - b.metadata.order
  return byOrder !== 0 ? byOrder : a.name.localeCompare(b.name)
}

/**
 * Merge every source's entries into one list, highest precedence winning.
 * @param results - one result per source, tagged with which source it is.
 * @returns the merged entries, sorted, with each entry's winning source.
 */
export function mergeSources(results: readonly (readonly [CatalogSource, SourceResult])[]): MergedEntry[] {
  const winners = new Map<string, MergedEntry>()
  for (const source of SOURCE_PRECEDENCE) {
    for (const [tag, result] of results) {
      if (tag !== source) continue
      for (const entry of result.entries) {
        const existing = winners.get(entry.name)
        if (existing === undefined) {
          winners.set(entry.name, { entry, source })
          continue
        }
        // The winner keeps everything of its own; a later source only fills a
        // gap it happens to know about. `repo` is the one that matters — a
        // local checkout is where a plugin is edited and rarely where it says
        // it lives.
        if (existing.entry.repo === undefined && entry.repo !== undefined) {
          winners.set(entry.name, { ...existing, entry: { ...existing.entry, repo: entry.repo } })
        }
      }
    }
  }
  return [...winners.values()].sort((a, b) => compareEntries(a.entry, b.entry))
}

/**
 * What the profile knows about one plugin it already has.
 *
 * Both fields come from the profile rather than from any source: the version
 * is read off the package on disk, and the specifier is the dependency the
 * profile manifest records. Together they are the whole input to
 * {@link updateStateFor}.
 */
export interface InstalledFacts {
  /** The version on disk, when the installed package declares one. */
  readonly version?: string | undefined
  /** The profile's dependency specifier, which says whether the install is a link. */
  readonly spec?: string | undefined
}


/**
 * Project merged entries into the wire document.
 *
 * The update verdict is computed HERE, where both halves of the comparison are
 * in hand, rather than in the browser: the panel would otherwise need the
 * profile's dependency specifiers to tell a link from a registry install, and
 * a Host path is not something to put on the wire for a button's sake.
 * @param merged - the merge result.
 * @param reports - one report per source consulted.
 * @param installed - what this profile has, by package name.
 * @param generation - the resolution counter.
 * @returns the document, carrying no install specifiers.
 */
export function toDocument(
  merged: readonly MergedEntry[],
  reports: readonly CatalogSourceReport[],
  installed: ReadonlyMap<string, InstalledFacts>,
  generation: number,
): CatalogDocument {
  const entries: CatalogEntry[] = merged.map(({ entry, source }) => {
    const held = installed.get(entry.name)
    return {
      name: entry.name,
      source,
      ...entry.version === undefined ? {} : { version: entry.version },
      ...entry.repo === undefined ? {} : { repo: entry.repo },
      ...entry.description === undefined ? {} : { description: entry.description },
      metadata: entry.metadata,
      installed: held !== undefined,
      ...held === undefined ? {} : {
        ...held.version === undefined ? {} : { installedVersion: held.version },
        update: updateStateFor(entry.version, held.version, held.spec),
      },
    }
  })
  return { entries, sources: reports, generation }
}

/** One resolution, held for reuse. */
interface Resolution {
  readonly merged: readonly MergedEntry[]
  readonly reports: readonly CatalogSourceReport[]
  readonly generation: number
  /** Monotonic tick this resolution was taken at, for the TTL. */
  readonly at: number
}

/**
 * The catalog: resolves the configured sources, caches the result for a while,
 * and answers the two questions the routes ask of it.
 */
export class Catalog {
  private resolution: Resolution | undefined
  private generation = 0
  /** In-flight resolution, so N concurrent requests cost one enumeration. */
  private inflight: Promise<Resolution> | undefined

  /**
   * @param options - the configured sources.
   * @param fetchImpl - how remote sources reach the network.
   * @param ttlMs - how long a resolution is reused.
   * @param now - monotonic millisecond clock, injected for specs.
   */
  constructor(
    private options: CatalogOptions,
    private readonly fetchImpl: FetchLike,
    private ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Adopt new configuration and drop the cache, so a settings change is
   * visible on the next read rather than after the TTL.
   *
   * The TTL rides along rather than staying at whatever the composition entry
   * said: it is one of the fields the panel offers, and a namespace that
   * applies `live` has to mean every field in it.
   * @param options - the new configuration.
   * @param ttlMs - how long a resolution is reused from here on.
   */
  reconfigure(options: CatalogOptions, ttlMs: number): void {
    this.options = options
    this.ttlMs = ttlMs
    this.invalidate()
  }

  /** Drop the cached resolution; the next read resolves afresh. */
  invalidate(): void {
    this.resolution = undefined
  }

  /**
   * Resolve the catalog, reusing a recent resolution unless told not to.
   * @param installed - what this profile already has, by package name.
   * @param refresh - bypass the cache.
   * @returns the wire document.
   */
  async document(installed: ReadonlyMap<string, InstalledFacts>, refresh = false): Promise<CatalogDocument> {
    const resolution = await this.resolve(refresh)
    return toDocument(resolution.merged, resolution.reports, installed, resolution.generation)
  }

  /**
   * The install specifier for one catalog entry, from the resolution this Host
   * performed. Returns undefined for a name the catalog does not offer — which
   * is the whole enforcement of "the catalog is the allowlist".
   * @param name - the package name an install request named.
   * @returns the specifier and its winning source, or undefined.
   */
  async specFor(name: string): Promise<MergedEntry | undefined> {
    const resolution = await this.resolve(false)
    return resolution.merged.find(candidate => candidate.entry.name === name)
  }

  /** Resolve, honoring the TTL and collapsing concurrent callers onto one run. */
  private async resolve(refresh: boolean): Promise<Resolution> {
    const held = this.resolution
    if (!refresh && held !== undefined && this.now() - held.at < this.ttlMs) return held
    if (!refresh && this.inflight !== undefined) return this.inflight
    const run = this.resolveSources().then((resolution) => {
      this.resolution = resolution
      this.inflight = undefined
      return resolution
    }, (error: unknown) => {
      this.inflight = undefined
      throw error
    })
    this.inflight = run
    return run
  }

  /** Consult every configured source, in parallel. */
  private async resolveSources(): Promise<Resolution> {
    const { upstream, registryUrl, localSources, maxRepos, timeoutMs, githubToken } = this.options
    const locals = scanLocalSources(localSources).map(result => ['local', result] as const)
    const remote: Promise<readonly [CatalogSource, SourceResult]>[] = []
    if (registryUrl !== '') {
      remote.push(fetchRegistrySource(registryUrl, { fetch: this.fetchImpl, timeoutMs })
        .then(result => ['registry', result] as const))
    }
    if (upstream !== '') {
      remote.push(fetchGithubSource(upstream, {
        fetch: this.fetchImpl,
        timeoutMs,
        maxRepos,
        ...githubToken === undefined ? {} : { token: githubToken },
      }).then(result => ['github', result] as const))
    }
    // Every source is independent and each already contains its own failure,
    // so one unreachable upstream costs its rows and nothing else.
    const results = [...locals, ...await Promise.all(remote)]
    return {
      merged: mergeSources(results),
      reports: results.map(([, result]) => result.report),
      generation: ++this.generation,
      at: this.now(),
    }
  }
}

/**
 * Build the catalog options from this plugin's resolved configuration.
 * @param config - the resolved settings section.
 * @returns the options, with the registry URL derived when it was not given.
 */
export function catalogOptions(config: {
  readonly upstream: string
  readonly registryUrl?: string | undefined
  readonly localSources: readonly string[]
  readonly githubToken?: string | undefined
  readonly maxRepos: number
  readonly timeoutMs: number
}): CatalogOptions {
  const registryUrl = config.registryUrl !== undefined && config.registryUrl !== ''
    ? config.registryUrl
    : config.upstream === '' ? '' : defaultRegistryUrl(config.upstream)
  return {
    upstream: config.upstream,
    registryUrl,
    localSources: config.localSources,
    ...config.githubToken === undefined ? {} : { githubToken: config.githubToken },
    maxRepos: config.maxRepos,
    timeoutMs: config.timeoutMs,
  }
}
