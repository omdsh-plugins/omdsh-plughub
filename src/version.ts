/**
 * Deciding whether an installed plugin is behind what its source offers.
 *
 * ## Why a comparison and not a fetch
 *
 * Every catalog source already reports a version: a local checkout's
 * `package.json`, a registry row, the `package.json` a GitHub repository
 * serves. The profile already reports the installed one. So "is there an
 * update" is a question about two strings this runtime already holds, and
 * asking anything else — a registry `dist-tags` call, a `git ls-remote` — would
 * add a network hop to answer what the catalog resolution just answered.
 *
 * ## Why semver rather than string inequality
 *
 * `0.10.0` is newer than `0.9.0` and sorts before it; `1.0.0` is newer than
 * `1.0.0-rc.2` and sorts after it. Both mistakes light the Update button on a
 * plugin that is already current, and a button that lies about that is worse
 * than no button. This is the ordering rule from the semver specification,
 * restated in about forty lines rather than depending on a package: an
 * out-of-tree plugin's dependency list is something a person installing it has
 * to trust, and this is not worth a row in it.
 *
 * Anything that does not parse compares to `undefined` rather than to a guess.
 * A source that versions itself `2024.03` or `latest` is not wrong, it is
 * simply not answering this question, and the panel reports that it does not
 * know instead of inventing an answer.
 * @module @omdsh-plugins/omdsh-plughub/version
 */

import type { UpdateState } from './contract.ts'

/** `major.minor.patch`, an optional prerelease, an optional build. */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** A prerelease identifier that is a number, and so compares numerically. */
const NUMERIC = /^\d+$/

/** A dependency specifier that points at a directory on this machine. */
const LINKED_SPEC = /^(?:link|file):/

/** One parsed version. */
interface Version {
  /** `[major, minor, patch]`. */
  readonly core: readonly [number, number, number]
  /** Prerelease identifiers, empty for a release. */
  readonly pre: readonly string[]
}

/**
 * Parse a version string.
 *
 * A leading `v` is accepted because tags carry one and manifests do not, and
 * the two describe the same release. Build metadata is dropped, per semver:
 * it is explicitly not part of the ordering.
 * @param text - the candidate version.
 * @returns the parsed version, or undefined when it is not semver.
 */
export function parseVersion(text: string): Version | undefined {
  const trimmed = text.trim().replace(/^v/, '')
  const parsed = SEMVER.exec(trimmed)
  if (parsed === null) return undefined
  const [, major, minor, patch, pre] = parsed
  return {
    core: [Number(major), Number(minor), Number(patch)],
    pre: pre === undefined || pre === '' ? [] : pre.split('.'),
  }
}

/**
 * Order two prerelease identifier lists, per semver's rule 11.
 * @param left - the first list.
 * @param right - the second list.
 * @returns -1, 0, or 1.
 */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  // A release outranks any prerelease of the same core version, and an absent
  // list is what a release has.
  if (left.length === 0) return right.length === 0 ? 0 : 1
  if (right.length === 0) return -1
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index] ?? ''
    const b = right[index] ?? ''
    if (a === b) continue
    const numericA = NUMERIC.test(a)
    const numericB = NUMERIC.test(b)
    // Numeric identifiers always rank lower than alphanumeric ones.
    if (numericA !== numericB) return numericA ? -1 : 1
    if (numericA) return Number(a) < Number(b) ? -1 : 1
    return a < b ? -1 : 1
  }
  // Everything shared matched: the longer list is the larger prerelease.
  if (left.length === right.length) return 0
  return left.length < right.length ? -1 : 1
}

/**
 * Order two versions.
 * @param a - the first version.
 * @param b - the second version.
 * @returns -1, 0, or 1, or undefined when either string is not semver.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined || right === undefined) return undefined
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return comparePrerelease(left.pre, right.pre)
}

/**
 * Whether a profile's dependency specifier points at a directory on this
 * machine, i.e. whether the installed copy IS the source.
 *
 * `dsh plugin add <path>` records a `link:` dependency, so a plugin installed
 * from a local checkout is a symlink to that checkout. Its files are already
 * whatever the checkout holds, which is why there is nothing for an update to
 * fetch — and why saying "up to date" would be a confusing way to put it.
 * @param spec - the dependency specifier from the profile manifest.
 * @returns true when the dependency is a link to a local directory.
 */
export function isLinkedSpec(spec: string | undefined): boolean {
  return spec !== undefined && LINKED_SPEC.test(spec)
}

/**
 * Where one installed plugin stands against what its source offers.
 *
 * The order of the tests is the point. A source offering a genuinely newer
 * version wins even for a linked install — that is a real update, and a person
 * who has a checkout AND a newer published release should be told so. Only
 * once no newer version exists does a link report itself as a link, because
 * "up to date" would suggest an update could have been needed.
 * @param offered - the version the winning catalog source advertises.
 * @param installed - the version this profile has on disk.
 * @param spec - the profile's dependency specifier for it, when it has one.
 * @returns the state the panel renders a button from.
 */
export function updateStateFor(
  offered: string | undefined,
  installed: string | undefined,
  spec: string | undefined,
): UpdateState {
  const comparison = offered === undefined || installed === undefined
    ? undefined
    : compareVersions(offered, installed)
  if (comparison !== undefined && comparison > 0) return 'available'
  if (isLinkedSpec(spec)) return 'linked'
  // Either side missing, or a version neither this nor semver can order. The
  // panel offers no action on it rather than guessing which way it goes.
  if (comparison === undefined) return 'unknown'
  return 'current'
}

/**
 * The version line one card shows.
 *
 * Two numbers rather than one when an update is on offer, because
 * `0.1.0 → 0.2.0` says what the highlighted button is going to fetch, and a
 * lone version leaves a person to work out which of the two it is.
 *
 * Here rather than in the card, so it can be exercised without the browser
 * bundle's component imports — every spec in this package keeps its harness
 * imports type-only, which is what lets a bare clone run them.
 * @param entry - the catalog (or installed-offer) versions to label.
 * @returns the text, or undefined when no version is known at all.
 */
export function versionLabel(entry: {
  readonly update?: UpdateState
  readonly version?: string
  readonly installedVersion?: string
}): string | undefined {
  if (entry.update === 'available' && entry.installedVersion !== undefined && entry.version !== undefined) {
    return `${entry.installedVersion} → ${entry.version}`
  }
  return entry.version ?? entry.installedVersion
}
