/**
 * The hub's install path, on a terminal.
 *
 * ## Why this exists
 *
 * Ten of the twelve plugins in this collection are not on npm, and a plugin
 * that is not on npm has no working `dsh plugin add` line. pnpm ≥10 refuses to
 * run a git dependency's `prepare`, and the allowlist key it demands names the
 * tarball it resolved — `@scope/name@https://codeload.github.com/…/<sha>` —
 * so the entry cannot be written down in advance, only copied out of a failure.
 * The Settings tab has always answered this: {@link Installer} writes what it
 * can, reads pnpm's refusal, writes the exact key, and runs again. That answer
 * was reachable only by pressing a button.
 *
 * This module is the same steps with argv instead of a route — resolve the
 * catalog, turn an argument into a specifier, hand it to the same Installer.
 * It reimplements no part of an install, and it is the only module here that
 * writes to a terminal.
 *
 * ## What an argument may be
 *
 * `upstream` decides where the CATALOG looks; an argument decides what to take
 * from it. Two different questions, which is why a bare name cannot name an
 * account — and why {@link classifyTarget} admits a specifier as well as a
 * name. Three forms:
 *
 * - `@omdsh-plugins/omdsh-status` — a package name, looked up in the catalog.
 * - `omdsh-status` — the same lookup against each entry's last segment, so the
 *   ordinary case is short. Two matches is refused rather than guessed.
 * - `github:owner/repo`, an `https` git or tarball URL, `name@range`, or an
 *   absolute path — a specifier, installed exactly as written and never looked
 *   up. This is where one particular account is nameable; `--upstream` is
 *   where a whole catalog moves to one.
 *
 * A filesystem path is admissible here and refused in a route, which is what
 * {@link isInstallableSpec}'s `allowPath` parameter has always been for: a
 * path typed at a keyboard is not a path arriving inside somebody's manifest.
 *
 * ## What it does not do
 *
 * It does not read the profile's stored settings. A namespace is resolved by
 * the harness's settings service inside a running tree, and this program is
 * not one — so `upstream`, the token, and the timeouts come from the flags and
 * {@link module:@omdsh-plugins/omdsh-plughub/defaults}, and a person who has
 * configured the tab differently says so again here. Being honest about that
 * is better than reading half of it out of a file whose shape is the
 * harness's to change.
 * @module @omdsh-plugins/omdsh-plughub/cli
 */

import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Catalog, catalogOptions, isInstallableSpec, isPackageName, type InstalledFacts } from './catalog/index.ts'
import type { CatalogEntry, OperationState } from './contract.ts'
import {
  DEFAULT_CACHE_TTL_MS, DEFAULT_MAX_REPOS, DEFAULT_PROFILE,
  DEFAULT_REGISTRY_URL, DEFAULT_TIMEOUT_MS, DEFAULT_UPSTREAM,
} from './defaults.ts'
import { Installer } from './installer.ts'
import { listInstalled, profileFromDirectory, readProfileManifest, resolveHome, type ResolvedProfile } from './profile.ts'

/** The program name in every message; it is also the `bin` key. */
export const PROGRAM = 'omdsh-plughub'

/** Directory under the Harness home holding every profile, as the launcher names it. */
const PROFILES_DIR = 'profiles'

/** What the CLI was asked to do. */
export type Command = 'list' | 'add' | 'update' | 'remove' | 'help' | 'version'

/** Everything a run is configured by, after the flags are read. */
export interface CliOptions {
  readonly profile: string
  readonly upstream: string
  readonly registryUrl: string
  readonly localSources: readonly string[]
  readonly githubToken?: string | undefined
  readonly maxRepos: number
  readonly timeoutMs: number
  readonly launcher?: string | undefined
  readonly pnpmPath?: string | undefined
  /** Print machine-readable JSON instead of prose. */
  readonly json: boolean
  /** Print the package manager's output even when the operation succeeded. */
  readonly verbose: boolean
}

/** One parsed command line. */
export interface Invocation {
  readonly command: Command
  /** The names or specifiers the command was given. */
  readonly targets: readonly string[]
  readonly options: CliOptions
}

/** A command line this program will not act on, and why. */
export interface UsageError {
  readonly usage: string
}

/** Whether a parse produced a usage error. */
export function isUsageError(result: Invocation | UsageError): result is UsageError {
  return 'usage' in result
}

/** Flags that take a value, mapped to how they are stored. */
const VALUE_FLAGS = new Set([
  '--profile', '-p', '--upstream', '--registry-url', '--local-source',
  '--github-token', '--max-repos', '--timeout', '--launcher', '--pnpm',
])

/** Parse a bounded integer flag, or undefined when it is not one. */
function readInteger(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * Read one command line.
 *
 * Hand-rolled rather than taken from a dependency, because this package has no
 * runtime dependencies and a flag parser is not the thing to spend the first
 * one on.
 * @param argv - arguments after the program name.
 * @returns the invocation, or the usage error to print.
 */
export function parseArgs(argv: readonly string[]): Invocation | UsageError {
  let command: Command | undefined
  const targets: string[] = []
  const localSources: string[] = []
  let profile = DEFAULT_PROFILE
  let upstream = DEFAULT_UPSTREAM
  let registryUrl = DEFAULT_REGISTRY_URL
  let githubToken = process.env['GITHUB_TOKEN']
  let maxRepos = DEFAULT_MAX_REPOS
  let timeoutMs = DEFAULT_TIMEOUT_MS
  let launcher: string | undefined
  let pnpmPath: string | undefined
  let json = false
  let verbose = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue

    if (argument === '--help' || argument === '-h') return { command: 'help', targets: [], options: defaults() }
    if (argument === '--version' || argument === '-V') return { command: 'version', targets: [], options: defaults() }
    if (argument === '--json') { json = true; continue }
    if (argument === '--verbose') { verbose = true; continue }

    if (argument.startsWith('-')) {
      // `--flag=value` and `--flag value` are one shape by the time they are read.
      const split = argument.indexOf('=')
      const flag = split < 0 ? argument : argument.slice(0, split)
      if (!VALUE_FLAGS.has(flag)) return { usage: `unknown option ${argument}` }
      let value: string | undefined
      if (split >= 0) {
        value = argument.slice(split + 1)
      } else {
        index += 1
        value = argv[index]
      }
      // Empty is a value for the two source flags and a mistake everywhere
      // else: the schema spells "derive the manifest from the account" as an
      // empty URL and "enumerate nothing" as an empty account, and a terminal
      // has to be able to say both.
      if (value === undefined) return { usage: `${flag} needs a value` }
      if (value === '' && flag !== '--upstream' && flag !== '--registry-url') {
        return { usage: `${flag} needs a value` }
      }
      switch (flag) {
        case '--profile': case '-p': profile = value; break
        case '--upstream': upstream = value; break
        case '--registry-url': registryUrl = value; break
        case '--local-source': localSources.push(value); break
        case '--github-token': githubToken = value; break
        case '--launcher': launcher = value; break
        case '--pnpm': pnpmPath = value; break
        case '--max-repos': {
          const parsed = readInteger(value)
          if (parsed === undefined || parsed < 1 || parsed > 500) return { usage: '--max-repos takes a whole number from 1 to 500' }
          maxRepos = parsed
          break
        }
        case '--timeout': {
          const parsed = readInteger(value)
          if (parsed === undefined || parsed < 1000 || parsed > 120_000) return { usage: '--timeout takes milliseconds from 1000 to 120000' }
          timeoutMs = parsed
          break
        }
        default: return { usage: `unknown option ${flag}` }
      }
      continue
    }

    if (command === undefined) {
      if (argument === 'list' || argument === 'add' || argument === 'update' || argument === 'remove' || argument === 'help') {
        command = argument
        continue
      }
      return { usage: `unknown command ${JSON.stringify(argument)}` }
    }
    targets.push(argument)
  }

  if (command === undefined) return { command: 'help', targets: [], options: defaults() }
  if ((command === 'add' || command === 'update' || command === 'remove') && targets.length === 0) {
    return { usage: `${command} needs at least one plugin` }
  }

  return {
    command,
    targets,
    options: {
      profile, upstream, registryUrl, localSources,
      ...githubToken === undefined || githubToken === '' ? {} : { githubToken },
      maxRepos, timeoutMs,
      ...launcher === undefined ? {} : { launcher },
      ...pnpmPath === undefined ? {} : { pnpmPath },
      json, verbose,
    },
  }
}

/** The options a help or version run carries, so the shape is never partial. */
function defaults(): CliOptions {
  return {
    profile: DEFAULT_PROFILE,
    upstream: DEFAULT_UPSTREAM,
    registryUrl: DEFAULT_REGISTRY_URL,
    localSources: [],
    maxRepos: DEFAULT_MAX_REPOS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    verbose: false,
  }
}

/** What one `add` argument turned out to be. */
export type Target =
  /** A specifier, to install exactly as written. */
  | { readonly kind: 'spec'; readonly spec: string }
  /** A name, to look up in the catalog. */
  | { readonly kind: 'name'; readonly name: string }
  /** Neither, with the reason. */
  | { readonly kind: 'invalid'; readonly reason: string }

/**
 * Decide whether an argument names a catalog entry or is a specifier itself.
 *
 * A package name never carries `:` and never begins with `.` or a path
 * separator, and every specifier form that names a source does one or the
 * other — so the two are separable without asking the catalog first, which
 * matters because a specifier must not need a network round trip to install.
 *
 * `name@range` is the one specifier that looks like a name. It is admitted as
 * a specifier only when the `@` that carries the range is not the scope's, so
 * `@omdsh-plugins/omdsh-status` stays a name and
 * `@omdsh-plugins/omdsh-status@0.1.2` is a pinned install.
 * @param target - one argument.
 * @returns what it is.
 */
export function classifyTarget(target: string): Target {
  if (target === '') return { kind: 'invalid', reason: 'an empty argument names nothing' }
  const looksLikeSpec = target.includes(':')
    || target.startsWith('.')
    || target.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(target)
    // A version range: the last `@` is past the scope's leading one.
    || target.lastIndexOf('@') > 0
  if (!looksLikeSpec) {
    // `isPackageName` already admits an unscoped name, so there is nothing to
    // fall back to: anything it refuses — a leading dash, an uppercase letter,
    // whitespace — is not a name, and treating it as one would send it to the
    // catalog to be reported as missing rather than as malformed.
    return isPackageName(target)
      ? { kind: 'name', name: target }
      : { kind: 'invalid', reason: `${JSON.stringify(target)} is neither a package name nor a specifier this will install` }
  }
  return isInstallableSpec(target, true)
    ? { kind: 'spec', spec: target }
    : { kind: 'invalid', reason: `${JSON.stringify(target)} is not a specifier this will install (github:owner/repo, an https git or tarball URL, name@range, or an absolute path)` }
}

/** One name matched against the catalog. */
export type NameMatch =
  | { readonly kind: 'one'; readonly name: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'many'; readonly names: readonly string[] }

/**
 * Match one name against the catalog's entries.
 *
 * An exact package name wins outright. Otherwise the name is compared to each
 * entry's last segment, which is what makes `omdsh-status` work — and two
 * accounts publishing that segment is reported rather than resolved, because
 * picking one would be picking which account a person meant.
 * @param name - the argument.
 * @param names - the package names to match against.
 * @returns the match.
 */
export function matchName(name: string, names: readonly string[]): NameMatch {
  if (names.includes(name)) return { kind: 'one', name }
  const bare = names.filter(candidate => candidate.split('/').at(-1) === name)
  if (bare.length === 1 && bare[0] !== undefined) return { kind: 'one', name: bare[0] }
  return bare.length === 0 ? { kind: 'none' } : { kind: 'many', names: bare }
}

/** How the program talks, injected so a spec can read what it said. */
export interface Output {
  out: (line: string) => void
  err: (line: string) => void
}

/** The real one. */
const stdio: Output = {
  out: line => { process.stdout.write(`${line}\n`) },
  err: line => { process.stderr.write(`${line}\n`) },
}

/** What `--help` prints. */
export const HELP = `${PROGRAM} — install omdsh plugins into a dsh profile

Usage:
  ${PROGRAM} list                       what the catalog offers, and what is installed
  ${PROGRAM} add <plugin…>              install one or more
  ${PROGRAM} update <plugin…>           move one or more to the version the catalog offers
  ${PROGRAM} remove <plugin…>           remove one or more

A plugin is a package name (@omdsh-plugins/omdsh-status), its last segment
(omdsh-status), or a specifier installed as written and never looked up
(github:owner/repo, an https git or tarball URL, name@range, an absolute path).

Options:
  -p, --profile <name>     profile to install into (default: ${DEFAULT_PROFILE})
      --upstream <account> GitHub account the catalog enumerates (default: ${DEFAULT_UPSTREAM})
      --registry-url <url> catalog manifest; empty derives it from --upstream
      --local-source <dir> directory of checkouts to offer; repeatable
      --github-token <tok> lifts the anonymous enumeration rate limit ($GITHUB_TOKEN)
      --max-repos <n>      most repositories enumerated (default: ${String(DEFAULT_MAX_REPOS)})
      --timeout <ms>       per-request timeout (default: ${String(DEFAULT_TIMEOUT_MS)})
      --launcher <path>    the dsh to run; empty resolves it from PATH
      --pnpm <path>        the pnpm dsh shells out to
      --json               machine-readable output
      --verbose            print the package manager's output on success too
  -h, --help               this
  -V, --version            the package version

Every install takes effect on the next start: the loader composes a profile at
boot and nothing hot-swaps a bundle.`

/** Locate the profile a run was told to manage. */
function resolveNamedProfile(name: string, home: string): ResolvedProfile | undefined {
  return profileFromDirectory(join(home, PROFILES_DIR, name), home)
}

/** What the profile holds, keyed by package name — the catalog's update input. */
function installedFacts(profile: ResolvedProfile): Map<string, InstalledFacts> {
  const manifest = readProfileManifest(profile.dir)
  const dependencies = manifest.dependencies ?? {}
  return new Map(listInstalled(profile.dir, manifest).map(entry => [entry.name, {
    version: entry.version,
    spec: dependencies[entry.name],
  }]))
}

/** Right-pad, so a column of names lines up without a formatting dependency. */
function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

/** Print the catalog as a person reads it. */
function printCatalog(entries: readonly CatalogEntry[], io: Output): void {
  const width = Math.max(0, ...entries.map(entry => entry.name.length))
  for (const entry of entries) {
    const mark = entry.installed ? 'installed' : '         '
    const version = entry.version ?? '-'
    io.out(`  ${mark}  ${pad(entry.name, width)}  ${pad(version, 8)}  ${entry.source}`)
  }
}

/** Run one settled operation's log out, when there is a reason to. */
function reportLog(operation: OperationState, options: CliOptions, io: Output): void {
  if (operation.status !== 'failed' && !options.verbose) return
  for (const line of operation.log) io.err(`  ${line}`)
}

/**
 * Run one command line to its exit code.
 * @param argv - arguments after the program name.
 * @param io - where output goes.
 * @returns the process exit code.
 */
export async function run(argv: readonly string[], io: Output = stdio): Promise<number> {
  const parsed = parseArgs(argv)
  if (isUsageError(parsed)) {
    io.err(`${PROGRAM}: ${parsed.usage}`)
    io.err(`run \`${PROGRAM} --help\` for what it takes`)
    return 2
  }
  if (parsed.command === 'help') { io.out(HELP); return 0 }
  if (parsed.command === 'version') { io.out(version()); return 0 }

  const { options } = parsed
  const home = resolveHome()
  const profile = resolveNamedProfile(options.profile, home)
  if (profile === undefined) {
    io.err(`${PROGRAM}: no profile named ${JSON.stringify(options.profile)} under ${join(home, PROFILES_DIR)}`)
    io.err(`create it first — \`dsh --profile ${options.profile}\` writes one — then run this again`)
    return 1
  }

  const catalog = new Catalog(
    catalogOptions({
      upstream: options.upstream,
      registryUrl: options.registryUrl,
      localSources: options.localSources,
      ...options.githubToken === undefined ? {} : { githubToken: options.githubToken },
      maxRepos: options.maxRepos,
      timeoutMs: options.timeoutMs,
    }),
    globalThis.fetch,
    DEFAULT_CACHE_TTL_MS,
  )

  if (parsed.command === 'list') return listCommand(catalog, profile, options, io)

  const settled: OperationState[] = []
  const installer = new Installer({
    profileDir: profile.dir,
    profileName: profile.name,
    home,
    ...options.launcher === undefined ? {} : { launcher: () => options.launcher },
    ...options.pnpmPath === undefined ? {} : { pnpm: () => options.pnpmPath },
  }, (operation) => {
    if (operation.status !== 'running') settled.push(operation)
  })

  if (parsed.command === 'add') return addCommand(parsed.targets, catalog, profile, installer, settled, options, io)
  if (parsed.command === 'update') return updateCommand(parsed.targets, catalog, profile, installer, settled, options, io)
  return removeCommand(parsed.targets, profile, installer, settled, options, io)
}

/** `list`: resolve the catalog and print it. */
async function listCommand(
  catalog: Catalog,
  profile: ResolvedProfile,
  options: CliOptions,
  io: Output,
): Promise<number> {
  let document
  try {
    document = await catalog.document(installedFacts(profile))
  } catch (error) {
    io.err(`${PROGRAM}: the catalog could not be resolved: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  if (options.json) {
    io.out(JSON.stringify({ profile: profile.name, entries: document.entries, sources: document.sources }, undefined, 2))
    return 0
  }
  io.out(`${PROGRAM}: profile ${profile.name} · ${String(document.entries.length)} plugins offered`)
  printCatalog(document.entries, io)
  let broken = 0
  for (const source of document.sources) {
    if (source.error === undefined) continue
    broken += 1
    io.err(`${PROGRAM}: ${source.source} (${source.origin}) failed: ${source.error}`)
  }
  if (document.sources.length === 0) {
    io.err(`${PROGRAM}: no sources are configured — --upstream is empty and no --registry-url was given`)
    return 1
  }
  // An empty catalog is a fact, not a failure; an empty one because every
  // source broke is the failure, and the two exit differently so a script can
  // tell "nothing to install" from "the network is down".
  return document.entries.length === 0 && broken > 0 ? 1 : 0
}

/** `add`: turn every argument into a specifier, then install them in order. */
async function addCommand(
  targets: readonly string[],
  catalog: Catalog,
  profile: ResolvedProfile,
  installer: Installer,
  settled: OperationState[],
  options: CliOptions,
  io: Output,
): Promise<number> {
  /** Every argument resolved before anything is installed, so a typo costs no writes. */
  const planned: { name: string; spec: string }[] = []
  let entries: readonly CatalogEntry[] | undefined
  const held = new Set(readProfileManifest(profile.dir).bundles)

  for (const target of targets) {
    const classified = classifyTarget(target)
    if (classified.kind === 'invalid') {
      io.err(`${PROGRAM}: ${classified.reason}`)
      return 2
    }
    if (classified.kind === 'spec') {
      // The package's real name is inside a tree that has not been fetched
      // yet. The installer writes an allowlist entry from the name it is
      // given and repairs it from pnpm's refusal either way, so the argument
      // stands in as a label and costs nothing when it is not the name.
      planned.push({ name: target, spec: classified.spec })
      continue
    }
    if (entries === undefined) {
      try {
        entries = (await catalog.document(installedFacts(profile))).entries
      } catch (error) {
        io.err(`${PROGRAM}: the catalog could not be resolved: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
    }
    const matched = matchName(classified.name, entries.map(entry => entry.name))
    if (matched.kind === 'none') {
      io.err(`${PROGRAM}: the catalog offers no plugin named ${JSON.stringify(classified.name)}`)
      io.err(`run \`${PROGRAM} list\` to see what it offers, or name a specifier such as github:owner/repo`)
      return 1
    }
    if (matched.kind === 'many') {
      io.err(`${PROGRAM}: ${JSON.stringify(classified.name)} matches ${matched.names.join(', ')} — name one in full`)
      return 1
    }
    if (held.has(matched.name)) {
      // Refused rather than run: `pnpm add` on a dependency the manifest
      // already satisfies changes nothing and reports success, so an `add`
      // here would be the silent no-op `update` exists to avoid.
      io.err(`${PROGRAM}: ${matched.name} is already in profile ${profile.name} — \`${PROGRAM} update ${classified.name}\` moves it`)
      return 1
    }
    const merged = await catalog.specFor(matched.name)
    if (merged === undefined) {
      io.err(`${PROGRAM}: the catalog offers no plugin named ${JSON.stringify(matched.name)}`)
      return 1
    }
    planned.push({ name: merged.entry.name, spec: merged.entry.spec })
  }

  for (const { name, spec } of planned) {
    if (!options.json) {
      io.out(isPackageName(name)
        ? `${PROGRAM}: installing ${name} from ${spec}`
        : `${PROGRAM}: installing from ${spec}`)
    }
    installer.install(name, spec)
  }
  await installer.drain()
  return reportOperations(settled, 'installed', options, io)
}

/** `update`: re-add each installed plugin against the version the catalog offers. */
async function updateCommand(
  targets: readonly string[],
  catalog: Catalog,
  profile: ResolvedProfile,
  installer: Installer,
  settled: OperationState[],
  options: CliOptions,
  io: Output,
): Promise<number> {
  const held = new Set(readProfileManifest(profile.dir).bundles)
  const planned: { name: string; spec: string; version?: string | undefined }[] = []
  let entries: readonly CatalogEntry[] | undefined

  for (const target of targets) {
    const classified = classifyTarget(target)
    if (classified.kind !== 'name') {
      io.err(`${PROGRAM}: update takes a package name, not a specifier — ${JSON.stringify(target)}`)
      return 2
    }
    if (entries === undefined) {
      try {
        entries = (await catalog.document(installedFacts(profile))).entries
      } catch (error) {
        io.err(`${PROGRAM}: the catalog could not be resolved: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
    }
    const matched = matchName(classified.name, entries.map(entry => entry.name))
    if (matched.kind === 'none') {
      io.err(`${PROGRAM}: the catalog offers no plugin named ${JSON.stringify(classified.name)}`)
      return 1
    }
    if (matched.kind === 'many') {
      io.err(`${PROGRAM}: ${JSON.stringify(classified.name)} matches ${matched.names.join(', ')} — name one in full`)
      return 1
    }
    // Opposite precondition to `add`, and the same reason the routes have two:
    // updating what the profile does not have is an install wearing the wrong
    // name.
    if (!held.has(matched.name)) {
      io.err(`${PROGRAM}: ${matched.name} is not in profile ${profile.name} — \`${PROGRAM} add ${classified.name}\` installs it`)
      return 1
    }
    const merged = await catalog.specFor(matched.name)
    if (merged === undefined) {
      io.err(`${PROGRAM}: the catalog offers no plugin named ${JSON.stringify(matched.name)}`)
      return 1
    }
    planned.push({ name: merged.entry.name, spec: merged.entry.spec, version: merged.entry.version })
  }

  for (const { name, spec, version } of planned) {
    if (!options.json) {
      io.out(`${PROGRAM}: updating ${name}${version === undefined ? '' : ` to ${version}`}`)
    }
    installer.update(name, spec, version)
  }
  await installer.drain()
  return reportOperations(settled, 'updated', options, io)
}

/** `remove`: hand every name to the launcher, which owns the bundle list. */
async function removeCommand(
  targets: readonly string[],
  profile: ResolvedProfile,
  installer: Installer,
  settled: OperationState[],
  options: CliOptions,
  io: Output,
): Promise<number> {
  const held = new Set(readProfileManifest(profile.dir).bundles)
  const planned: string[] = []
  for (const target of targets) {
    const classified = classifyTarget(target)
    if (classified.kind !== 'name') {
      io.err(`${PROGRAM}: remove takes a package name, not a specifier — ${JSON.stringify(target)}`)
      return 2
    }
    const matched = matchName(classified.name, [...held])
    if (matched.kind === 'none') {
      io.err(`${PROGRAM}: profile ${profile.name} has no bundle named ${JSON.stringify(classified.name)}`)
      return 1
    }
    if (matched.kind === 'many') {
      io.err(`${PROGRAM}: ${JSON.stringify(classified.name)} matches ${matched.names.join(', ')} — name one in full`)
      return 1
    }
    planned.push(matched.name)
  }

  for (const name of planned) {
    if (!options.json) io.out(`${PROGRAM}: removing ${name}`)
    installer.uninstall(name)
  }
  await installer.drain()
  return reportOperations(settled, 'removed', options, io)
}

/** Report every settled operation, and decide the exit code from them. */
function reportOperations(
  settled: readonly OperationState[],
  verb: string,
  options: CliOptions,
  io: Output,
): number {
  if (options.json) {
    io.out(JSON.stringify({ operations: settled }, undefined, 2))
    return settled.every(operation => operation.status === 'ok') ? 0 : 1
  }
  let failed = 0
  for (const operation of settled) {
    reportLog(operation, options, io)
    if (operation.status === 'ok') {
      io.out(`${PROGRAM}: ${verb} ${isPackageName(operation.name) ? operation.name : `from ${operation.name}`}`)
      continue
    }
    failed += 1
    io.err(`${PROGRAM}: could not ${operation.kind} ${operation.name}${operation.error === undefined ? '' : `: ${operation.error}`}`)
  }
  if (failed === 0 && settled.length > 0) {
    io.out(`${PROGRAM}: restart the profile for ${settled.length === 1 ? 'it' : 'them'} to load`)
  }
  return failed === 0 ? 0 : 1
}

/**
 * This package's own version, read from the manifest beside the bundle.
 *
 * Read rather than baked in, because a build-time constant is one more thing
 * that can disagree with `package.json`. The relative URL resolves the same
 * from `lib/cli.js` and from `src/cli.ts` under a test runner, so there is one
 * path rather than one per artifact.
 */
export function version(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const declared = (manifest as { version?: unknown }).version
    return typeof declared === 'string' ? declared : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Whether `entry` and `moduleUrl` are the same file.
 *
 * Through real paths on both sides, for the reason {@link isLauncherEntry}
 * takes the same care: an installed bin is a SYMLINK — `node_modules/.bin/
 * omdsh-plughub` → `../@omdsh-plugins/omdsh-plughub/lib/cli.js` — and node
 * reports the link in `argv[1]` while `import.meta.url` names the target. A
 * string comparison of the two is false for every installed copy of this
 * program, which is a CLI that runs and silently does nothing.
 * @param entry - `process.argv[1]`, when there is one.
 * @param moduleUrl - this module's `import.meta.url`.
 * @returns true when this module is the program that was started.
 */
export function isEntryPoint(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined || entry === '') return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  run(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (error: unknown) => {
      process.stderr.write(`${PROGRAM}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
