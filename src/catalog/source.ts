/**
 * What every catalog source produces, and the one rule they all obey about
 * install specifiers.
 *
 * ## Why a specifier is validated and never travels
 *
 * A specifier is an argument to `pnpm`. Two of the three sources are REMOTE
 * content — a manifest file and a repository listing, both authored by
 * whoever owns the upstream — so a specifier is attacker-influenced input to
 * an argv, and an argv is where `--config.foo=bar` style argument injection
 * lives. The commands are spawned without a shell, so quoting is not the
 * exposure; a leading `-` is.
 *
 * The answer is a positive allowlist ({@link isInstallableSpec}) rather than a
 * denylist, and a specifier never reaching the browser at all: a client names
 * a package, the Host looks the specifier up in the catalog IT resolved. There
 * is therefore no request shape that can carry one.
 * @module @omdsh-plugins/omdsh-plughub/catalog/source
 */

import type { CatalogSource, CatalogSourceReport, PlughubMetadata } from '../contract.ts'

/** As much of a `fetch` response as any source reads. */
export interface FetchResponse {
  readonly ok: boolean
  readonly status: number
  text: () => Promise<string>
}

/**
 * How the remote sources reach the network, injected rather than imported so a
 * spec can exercise every parsing and merging path without opening a socket.
 * The global `fetch` satisfies it structurally.
 */
export type FetchLike = (
  url: string,
  init: { readonly signal: AbortSignal; readonly headers?: Readonly<Record<string, string>> },
) => Promise<FetchResponse>

/** One installable plugin as a source produced it, before the merge ran. */
export interface SourceEntry {
  /** Package name; the identity every source is merged on. */
  readonly name: string
  readonly version?: string
  /** `owner/repo`, when the source knows one. */
  readonly repo?: string
  readonly description?: string
  readonly metadata: PlughubMetadata
  /**
   * The `pnpm add` argument that installs this. Host-side only: it is never
   * serialized into a {@link import('../contract.ts').CatalogEntry}, and no
   * route accepts one.
   */
  readonly spec: string
}

/** One source's contribution and how it fared. */
export interface SourceResult {
  readonly report: CatalogSourceReport
  readonly entries: readonly SourceEntry[]
}

/**
 * An npm package name: optional scope, no leading dot or underscore, URL-safe.
 * Deliberately narrower than npm's own grammar — this is an allowlist, and
 * every omdsh plugin fits inside it.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** A registry specifier: a package name, optionally pinned. */
const REGISTRY_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9._^~<>=|\s-]+)?$/

/** `github:owner/repo`, optionally at a ref. */
const GITHUB_SPEC = /^github:[A-Za-z0-9](?:[A-Za-z0-9._-]*)\/[A-Za-z0-9](?:[A-Za-z0-9._-]*)(?:#[A-Za-z0-9._/-]+)?$/

/** An https git or tarball URL, optionally at a ref. */
const HTTPS_SPEC = /^(?:git\+)?https:\/\/[A-Za-z0-9._~-]+(?::\d+)?\/[A-Za-z0-9._~/-]+(?:\.git)?(?:#[A-Za-z0-9._/-]+)?$/

/**
 * Whether a package name is one this plugin will act on.
 * @param name - the candidate name.
 * @returns true when it fits the allowlisted grammar.
 */
export function isPackageName(name: string): boolean {
  return name.length <= 214 && PACKAGE_NAME.test(name)
}

/**
 * Whether a specifier is one this plugin will hand to `pnpm add`.
 *
 * A filesystem path is accepted only when `allowPath` — that is, only for the
 * LOCAL source, whose specifiers this runtime built itself from a directory it
 * was configured to scan. A remote manifest cannot name a path, because a path
 * from a remote manifest would let an upstream install whatever this machine
 * happens to have lying around.
 * @param spec - the candidate specifier.
 * @param allowPath - whether an absolute filesystem path is admissible.
 * @returns true when the specifier is allowlisted.
 */
export function isInstallableSpec(spec: string, allowPath = false): boolean {
  if (spec === '' || spec.length > 512) return false
  // Ahead of every pattern, because a specifier that begins with `-` is an
  // option to pnpm no matter how well-formed the rest of it looks.
  if (spec.startsWith('-')) return false
  // Whitespace splits into two argv entries under any caller that ever stops
  // passing an array, and REGISTRY_SPEC's version range would otherwise
  // admit it — which is exactly where it would hide.
  if (/\s/.test(spec)) return false
  if (GITHUB_SPEC.test(spec) || HTTPS_SPEC.test(spec)) return true
  if (allowPath && (spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec))) return true
  return REGISTRY_SPEC.test(spec)
}

/** Whether a specifier installs from a git host, i.e. whether it will run `prepare`. */
export function isGitSpec(spec: string): boolean {
  return spec.startsWith('github:') || spec.startsWith('git+') || /^https:\/\/.*\.git(?:#|$)/.test(spec)
}

/**
 * Build a source's report row.
 * @param source - which source.
 * @param origin - what was consulted, in words a person can check.
 * @param entries - what it produced.
 * @param error - why it failed, when it did.
 * @returns the report.
 */
export function report(
  source: CatalogSource,
  origin: string,
  entries: readonly SourceEntry[],
  error?: unknown,
): CatalogSourceReport {
  const message = error === undefined
    ? undefined
    : error instanceof Error ? error.message : String(error)
  return {
    source,
    origin,
    ok: message === undefined,
    count: entries.length,
    ...message === undefined ? {} : { error: message },
  }
}
