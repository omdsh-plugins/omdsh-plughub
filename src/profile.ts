/**
 * Finding the profile this runtime booted from, and reading what it composed.
 *
 * ## Why `ctx.baseUrl`
 *
 * A dsh profile is a directory under `$DSH_HOME/profiles/<name>` holding a
 * `package.json` (out-of-tree plugin dependencies plus `dsh.profile.bundles`)
 * and a `cordis.patch.yml`. The launcher boots it by handing the Loader an
 * include rooted at `<profileDir>/cordis.yml`, and the include sets
 * `ctx.baseUrl` to that file's directory — so every row in the tree, this one
 * included, already carries the profile directory as an ambient fact. Nothing
 * else does: the profile NAME is a launcher argument that reaches no service,
 * `process.argv` is the launcher's and not necessarily this surface's, and
 * walking up from `import.meta.url` finds the pnpm store rather than the
 * profile whenever the package was installed normally.
 *
 * The name is then the directory's basename, which is exactly how
 * `resolveProfileDir` builds the path in the first place.
 *
 * ## Why the checks
 *
 * A wrong answer here is not a broken read — it is `pnpm` writing somewhere it
 * should not. So a resolved directory is only accepted when it looks like a
 * profile (a `package.json` declaring `dsh.profile`), and the name is only
 * accepted when it round-trips: `<home>/profiles/<name>` must be the directory
 * we started from.
 * @module @omdsh-plugins/omdsh-plughub/profile
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMPTY_METADATA, type InstalledEntry } from './contract.ts'
import { readManifest, type ManifestFacts } from './manifest.ts'

/** Directory under the Harness home holding every profile, as the launcher names it. */
const PROFILES_DIR = 'profiles'

/** Environment variable that overrides the default Harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/**
 * Resolve the Harness home, restating `@deepseek-ai/dsh-home-paths`'s
 * `resolveDshHome` (BSD-3-Clause) rather than depending on it: this plugin
 * needs twelve lines of it, and one fewer harness package to pin is one fewer
 * thing for `harness:local` to keep in step. An empty or whitespace-only
 * `$DSH_HOME` reads as unset, exactly as upstream — a blank override must
 * never resolve the home to the working directory.
 * @param env - the environment to read, injected for specs.
 * @returns the absolute Harness home.
 */
export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env[DSH_HOME_ENV]
  const selected = configured !== undefined && configured.trim().length > 0
    ? configured
    : join(homedir(), '.dsh')
  if (selected === '~') return homedir()
  if (selected.startsWith('~/') || selected.startsWith('~\\')) return resolve(join(homedir(), selected.slice(2)))
  return resolve(selected)
}

/** The profile-manifest slice this plugin reads and reasons about. */
export interface ProfileManifest {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly bundles: readonly string[]
}

/** One located profile. */
export interface ResolvedProfile {
  /** Absolute profile directory. Host-side only — this never reaches the wire. */
  readonly dir: string
  /** The profile name, i.e. what `dsh --profile <name>` would say. */
  readonly name: string
}

/** A profile that could not be located, with the reason a human can act on. */
export class ProfileResolutionError extends Error {
  /** Stable machine code, so a route can map this to a status without matching text. */
  readonly code = 'PROFILE_UNRESOLVED'
}

/** Read and parse one JSON file, or undefined when it is absent or unparsable. */
function readJson(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Whether a value is a plain data object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a directory is a dsh profile: a manifest that declares `dsh.profile`.
 * The bundles list may be empty (a freshly initialized profile with no
 * template), so the DECLARATION is the test, not its contents.
 * @param dir - candidate directory.
 * @returns true when the directory holds a profile manifest.
 */
export function isProfileDirectory(dir: string): boolean {
  const manifest = readJson(join(dir, 'package.json'))
  if (!isRecord(manifest)) return false
  const dsh = manifest['dsh']
  return isRecord(dsh) && isRecord(dsh['profile'])
}

/**
 * Read a profile's manifest.
 * @param dir - the profile directory.
 * @returns its dependencies and bundle list; an empty bundle list when absent.
 */
export function readProfileManifest(dir: string): ProfileManifest {
  const manifest = readJson(join(dir, 'package.json'))
  if (!isRecord(manifest)) return { bundles: [] }
  const dependencies = isRecord(manifest['dependencies'])
    ? Object.fromEntries(
      Object.entries(manifest['dependencies']).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
    : undefined
  const dsh = manifest['dsh']
  const profile = isRecord(dsh) ? dsh['profile'] : undefined
  const declared = isRecord(profile) ? profile['bundles'] : undefined
  const bundles = Array.isArray(declared) ? declared.filter((name): name is string => typeof name === 'string') : []
  return { ...dependencies === undefined ? {} : { dependencies }, bundles }
}

/**
 * Locate the profile behind a `ctx.baseUrl`.
 * @param baseUrl - the context's base URL, as the root include set it.
 * @param home - `$DSH_HOME`, for the name round-trip check.
 * @returns the profile, or undefined when the URL does not point at one.
 */
export function profileFromBaseUrl(baseUrl: string | undefined, home: string): ResolvedProfile | undefined {
  if (baseUrl === undefined || baseUrl === '') return undefined
  let dir: string
  try {
    dir = fileURLToPath(new URL('.', baseUrl))
  } catch {
    // A non-file base URL (a packaged runtime serving its config over http)
    // is not a directory this plugin can write, and saying so is better than
    // guessing at a path.
    return undefined
  }
  // fileURLToPath keeps the trailing separator that `new URL('.', …)` adds.
  return profileFromDirectory(resolve(dir), home)
}

/**
 * Accept a directory as a profile, if it is one and its name round-trips.
 * @param dir - the candidate directory, already absolute.
 * @param home - `$DSH_HOME`.
 * @returns the profile, or undefined.
 */
export function profileFromDirectory(dir: string, home: string): ResolvedProfile | undefined {
  if (!isProfileDirectory(dir)) return undefined
  const name = basename(dir)
  // The round-trip: `resolveProfileDir(name)` is `join(home, 'profiles', name)`,
  // so a directory that is a profile but does NOT sit there is one this plugin
  // must not hand to `dsh plugin --profile <name>` — that command would
  // resolve the name to a DIFFERENT directory and install into the wrong one.
  if (resolve(join(home, PROFILES_DIR, name)) !== dir) return undefined
  return { dir, name }
}

/**
 * Locate the profile, preferring an explicit configuration over the ambient
 * fact — a deployment that boots some other way can still say where it lives.
 * @param options - the explicit directory (when configured), the context base URL, and the home.
 * @returns the resolved profile.
 * @throws {ProfileResolutionError} when nothing usable is found.
 */
export function resolveProfile(options: {
  readonly configuredDir?: string | undefined
  readonly baseUrl?: string | undefined
  readonly home: string
}): ResolvedProfile {
  const { configuredDir, baseUrl, home } = options
  if (configuredDir !== undefined && configuredDir !== '') {
    const absolute = resolve(configuredDir)
    const profile = profileFromDirectory(absolute, home)
    if (profile !== undefined) return profile
    throw new ProfileResolutionError(
      `omdsh-plughub: the configured profileDir ${absolute} is not a profile under ${join(home, PROFILES_DIR)} `
      + '(it needs a package.json declaring dsh.profile, and its directory name must be the profile name)',
    )
  }
  const resolved = profileFromBaseUrl(baseUrl, home)
  if (resolved !== undefined) return resolved
  throw new ProfileResolutionError(
    'omdsh-plughub: this runtime did not boot from a dsh profile directory, so there is nothing to install into '
    + `(expected a profile under ${join(home, PROFILES_DIR)}; set the plugin's profileDir to say otherwise)`,
  )
}

/**
 * Resolve one package's directory from the profile, by the ordinary parent
 * walk: the profile's own `node_modules` first (pnpm manages it for
 * out-of-tree plugins), then the launcher-maintained flat fallback at
 * `$DSH_HOME/profiles/node_modules`, then upward. Deliberately not
 * `require.resolve`: that goes through the package's `exports` map, and a
 * package that does not export `./package.json` would read as absent when it
 * is merely private about its manifest.
 * @param profileDir - the profile directory to walk up from.
 * @param packageName - the package to find.
 * @returns the package directory, or undefined when the walk finds nothing.
 */
export function resolvePackageDir(profileDir: string, packageName: string): string | undefined {
  let current = profileDir
  for (;;) {
    const candidate = join(current, 'node_modules', packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Read one installed package's manifest facts.
 * @param profileDir - the profile directory.
 * @param packageName - the package to read.
 * @returns its facts, or undefined when it is not resolvable from here.
 */
export function readInstalledManifest(profileDir: string, packageName: string): ManifestFacts | undefined {
  const dir = resolvePackageDir(profileDir, packageName)
  if (dir === undefined) return undefined
  const manifest = readJson(join(dir, 'package.json'))
  return manifest === undefined ? undefined : readManifest(manifest)
}

/**
 * Project the profile's composed bundles into what the panel shows.
 *
 * A bundle is REMOVABLE exactly when it is a dependency: `pnpm remove` acts on
 * dependencies, and the profile template's own bundles (`dsh-base` and
 * friends) are not dependencies at all — they came with the profile and a
 * profile without them is not one. That is the same rule `dsh plugin`'s own
 * reconciliation uses, from the other direction.
 * @param profileDir - the profile directory.
 * @param manifest - the profile manifest.
 * @returns one entry per composed bundle, in `dsh.profile.bundles` order.
 */
export function listInstalled(profileDir: string, manifest: ProfileManifest): InstalledEntry[] {
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}))
  return manifest.bundles.map((name) => {
    const facts = readInstalledManifest(profileDir, name)
    return {
      name,
      ...facts?.version === undefined ? {} : { version: facts.version },
      ...facts?.description === undefined ? {} : { description: facts.description },
      metadata: facts?.metadata ?? EMPTY_METADATA,
      removable: dependencies.has(name),
    }
  })
}

/**
 * Whether the profile on disk has moved past what this process booted from.
 *
 * Compared against the bundle list read at mount, which IS what the launcher
 * composed the tree from — the profile manifest is the launcher's own input.
 * So this answers the real question ("is the running tree still the profile?")
 * without inspecting the Loader at all, and it answers it for a change made
 * from anywhere: this panel, another tab, or `dsh plugin add` in a second
 * terminal.
 *
 * A newly installed bundle cannot be hot-composed: bundle layers are read once
 * at boot and only the user patch layers are watched, so the honest report is
 * "restart", not a reload this plugin cannot deliver.
 *
 * It answers for membership and order only. An UPDATE leaves both alone — the
 * same package name with different code behind it — so the caller latches that
 * case separately rather than expecting this to notice it.
 * @param booted - the bundle list as it stood when this plugin mounted.
 * @param current - the bundle list as it now stands on disk.
 * @returns true when the two differ in membership or order.
 */
export function isRestartRequired(booted: readonly string[], current: readonly string[]): boolean {
  if (booted.length !== current.length) return true
  return booted.some((name, index) => current[index] !== name)
}
