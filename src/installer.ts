/**
 * Installing and removing plugins: the only thing in this package that writes.
 *
 * ## Why it shells out to `dsh` rather than to `pnpm`
 *
 * `pnpm add` is only half of an install. The other half is reconciling
 * `dsh.profile.bundles` against what is now on disk — a dependency that
 * resolves to a package declaring `dsh.bundle` joins the layer stack, one that
 * no longer does leaves it — and that reconciliation is `dsh plugin`'s, in the
 * launcher this runtime was started by. Reimplementing it here would mean
 * carrying a copy that has to track a program the user upgrades independently,
 * and getting it wrong means a profile that boots without the plugin it just
 * "installed". So this module runs the real thing and stays out of the
 * reconciliation business entirely.
 *
 * ## The one thing it does have to know
 *
 * pnpm ≥10 refuses to run a dependency's install scripts until they are
 * allowlisted, and a git-hosted dsh plugin BUILDS ITSELF in `prepare` — its
 * published tree has no `lib/`. So a git install that is not allowlisted
 * succeeds, writes the dependency, reconciles the bundle list, and then the
 * next boot dies on `Cannot find module .../lib/index.js`. The allowlist entry
 * is written before the install, not after a failure, because the failure
 * arrives one restart later than the mistake.
 *
 * ### The name is not the key
 *
 * Writing the package NAME is right for a registry dependency and not enough
 * for a git one. pnpm keys a git-hosted package by the tarball it actually
 * resolved — `@scope/name@https://codeload.github.com/owner/repo/tar.gz/<sha>`
 * — and refuses an allowlist that names anything else, so the entry written
 * ahead of the install is correct in form and inert in fact. The commit is not
 * knowable beforehand without re-implementing pnpm's own resolution, and it
 * changes on every push to the plugin.
 *
 * So the name goes in first — when the caller has one; a bare specifier
 * installed from a terminal does not — and if pnpm refuses anyway it is asked.
 * Its refusal prints the exact key it wants; {@link blockedBuilds} reads it
 * back, {@link allowBuild} writes it, and the install runs once more. That is one
 * retry and never a loop: a second refusal names a key the file already holds,
 * so there is nothing left to write and the failure is reported as it stands.
 *
 * ### Two refusals, and one this cannot answer
 *
 * A plugin's own `prepare` is one of them. The other is a DEPENDENCY that
 * builds itself — `omdsh-sidepanel` and `omdsh-codemode` pull in `node-pty` —
 * which pnpm blocks under `ERR_PNPM_IGNORED_BUILDS` and allows on the bare
 * name. Both are read from one failure, so a plugin that trips both costs one
 * retry rather than two.
 *
 * Neither reaches a refusal from INSIDE a git plugin's build. Preparing a
 * git-hosted package runs `pnpm install` in a directory under pnpm's store to
 * fetch that plugin's devDependencies; when THAT install is the one blocked —
 * on `esbuild`, say — it surfaces as `ERR_PNPM_PREPARE_PACKAGE` and no
 * allowlist in the profile applies to it. Publishing the plugin is what avoids
 * it, and that is a property of the plugin rather than a bug in this module: a
 * registry install downloads a built tree and runs no build at all.
 * @module @omdsh-plugins/omdsh-plughub/installer
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { OperationKind, OperationState } from './contract.ts'
import { isGitSpec, isPackageName } from './catalog/source.ts'
import { resolvePnpmDir } from './pnpm.ts'

/** How many lines of package-manager output one operation keeps. */
const LOG_LINES = 200

/** How long one line may be before it is truncated. */
const LOG_LINE_CHARS = 500

/** The profile's pnpm settings file; pnpm ≥10 reads them from here, not `.npmrc`. */
const WORKSPACE_FILE = 'pnpm-workspace.yaml'

/** Where the launcher's own binary would sit inside an installation. */
const BIN_RELATIVE = join('node_modules', '.bin', 'dsh')

/**
 * How many times an install may be re-run after writing what pnpm asked for.
 * Two refusals are reachable in sequence — a dependency's build, then the
 * plugin's own `prepare` — so one pass is not enough; the loop ends on lack of
 * progress well before this.
 */
const ALLOW_PASSES = 4

/** Shell convention: a program, or something it needed, was not found. */
const EXIT_NOT_FOUND = 127

/** The launcher package this plugin shells out to. */
const LAUNCHER_PACKAGE = '@deepseek-ai/dsh'

/** How the launcher is invoked, and what the child needs to find its own tools. */
export interface LauncherCommand {
  /** The executable to spawn. */
  readonly command: string
  /** Arguments that come before the `plugin …` ones. */
  readonly args: readonly string[]
  /**
   * Directories to prepend to the child's `PATH`.
   *
   * `dsh plugin` shells out to `pnpm`, and a runtime whose `PATH` could not
   * find `dsh` will not find `pnpm` either. A launcher installation puts both
   * binaries in one directory, so naming that directory rescues the second
   * hop as well as the first.
   */
  readonly pathPrefix: readonly string[]
}

/** The facts about the running process that {@link resolveLauncher} reads. */
export interface RunningProcess {
  /** The node binary running this code. */
  readonly execPath: string
  /** `process.argv`; `[1]` is the script node was started with. */
  readonly argv: readonly string[]
}

/**
 * Whether a path is the launcher's own entry script.
 *
 * Resolved through its real path first, because an installation exposes the
 * CLI as a symlink in a bin directory (`/opt/homebrew/bin/dsh` →
 * `…/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`) and only the target sits
 * inside the package whose manifest can vouch for it.
 * @param entry - a candidate script path.
 * @returns true when it belongs to the launcher package.
 */
export function isLauncherEntry(entry: string): boolean {
  let current: string
  try {
    current = dirname(realpathSync(entry))
  } catch {
    return false
  }
  for (;;) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        return (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name === LAUNCHER_PACKAGE
      } catch {
        return false
      }
    }
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/**
 * Decide how to run `dsh plugin`.
 *
 * ## Why the running process comes before `PATH`
 *
 * The process executing this code IS the launcher — a profile is booted by
 * `dsh`, and this plugin is a row in that profile's tree. So the most reliable
 * launcher available is the one already running, reachable as
 * `process.execPath` plus `process.argv[1]` without consulting `PATH` at all.
 *
 * That matters because `PATH` is not dependable here. A runtime started from a
 * GUI launcher rather than a terminal inherits a minimal one, and then
 * `spawn('dsh')` fails with ENOENT even though the binary is plainly installed
 * — which reads to a person as "install dsh" when dsh is what they are looking
 * at. It is also the more CORRECT answer independently of that: reconciling a
 * profile with the same launcher that booted it cannot drift from the version
 * whose tree is running.
 *
 * The rest is fallback: an explicitly configured path wins outright (that is
 * what it is for), and a `node_modules/.bin/dsh` on the walk up, then the bare
 * name, cover a runtime that is somehow not the launcher.
 * @param profileDir - the profile directory to walk up from.
 * @param configured - an explicitly configured launcher path.
 * @param self - the running process, injected for specs.
 * @returns how to invoke the launcher.
 */
export function resolveLauncher(
  profileDir: string,
  configured?: string,
  self: RunningProcess = process,
): LauncherCommand {
  if (configured !== undefined && configured !== '') {
    return { command: configured, args: [], pathPrefix: [dirname(configured)] }
  }
  const entry = self.argv[1]
  if (entry !== undefined && entry !== '' && isLauncherEntry(entry)) {
    // Both directories: the launcher's own (where a sibling `pnpm` from the
    // same install lives) and node's (where a global `pnpm` often does).
    return {
      command: self.execPath,
      args: [entry],
      pathPrefix: [dirname(entry), dirname(self.execPath)],
    }
  }
  let current = profileDir
  for (;;) {
    const candidate = join(current, BIN_RELATIVE)
    if (existsSync(candidate)) return { command: candidate, args: [], pathPrefix: [dirname(candidate)] }
    const parent = dirname(current)
    if (parent === current) return { command: 'dsh', args: [], pathPrefix: [] }
    current = parent
  }
}

/**
 * Prepend directories to a `PATH` value, without duplicating what is there.
 * @param path - the inherited `PATH`, if any.
 * @param prefix - directories to put in front.
 * @returns the child's `PATH`.
 */
export function withPathPrefix(path: string | undefined, prefix: readonly string[]): string {
  const existing = (path ?? '').split(delimiter).filter(entry => entry !== '')
  const added = prefix.filter(entry => entry !== '' && !existing.includes(entry))
  return [...added, ...existing].join(delimiter)
}

/**
 * Add one package to a profile's pnpm build allowlist.
 *
 * Text surgery rather than a YAML round-trip, deliberately: this file is the
 * launcher's own template plus whatever a person has since written in it, and
 * reformatting somebody's comments to add one key is a poor trade. The
 * function is total — it returns the next text, or undefined when the file
 * already allows the package or is shaped in a way this cannot safely edit.
 * An unsafe shape is left alone on purpose: pnpm's own refusal names the exact
 * key to add, which is a better outcome than a mangled settings file.
 * @param text - the current file contents.
 * @param packageName - the package to allow.
 * @returns the next contents, or undefined when nothing should be written.
 */
export function withAllowBuild(text: string, packageName: string): string | undefined {
  const quoted = `'${packageName.replace(/'/g, "''")}'`
  const lines = text.split('\n')
  const headerIndex = lines.findIndex(line => /^allowBuilds\s*:/.test(line))
  if (headerIndex === -1) {
    const separator = text === '' || text.endsWith('\n') ? '' : '\n'
    return `${text}${separator}\nallowBuilds:\n  ${quoted}: true\n`
  }
  const header = lines[headerIndex] ?? ''
  // An inline mapping (`allowBuilds: {a: true}`) or an inline empty value is a
  // shape this refuses to touch; only the block form is edited.
  if (header.replace(/^allowBuilds\s*:/, '').trim() !== '') return undefined
  let indent = '  '
  // The insertion point is after the block's LAST ENTRY, not after its last
  // line: a file ending in a newline splits to a trailing empty string, and
  // inserting there would put the new key below a blank line — outside the
  // block as far as a reader is concerned, even though YAML still parses it.
  let insertAt = headerIndex + 1
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    const leading = /^(\s+)/.exec(line)
    if (leading === null) break // dedented back to the top level: the block ended
    const entry = line.trim()
    // Key and value, with the key matched however it was quoted so re-running
    // is a no-op.
    const parsed = /^(['"]?)(.*?)\1\s*:\s*(.*)$/u.exec(entry)
    if (parsed?.[2] === packageName) {
      // Already allowed: nothing to write, and returning undefined is what
      // ends the caller's retry rather than repeating an attempt pnpm has
      // already answered.
      if ((parsed[3] ?? '').trim() === 'true') return undefined
      // Present but not an allowance. pnpm writes the blocked package into
      // this file ITSELF, valued `set this to true or false`, which is a
      // question rather than a setting — and a question the person who
      // pressed Install in the hub already answered by pressing it. Deciding
      // it is the whole reason this module edits the file at all.
      const next = [...lines]
      next[index] = `${leading[1] ?? ''}${quoted}: true`
      return next.join('\n')
    }
    indent = leading[1] ?? indent
    insertAt = index + 1
  }
  // Appended rather than prepended, so the file keeps whatever order a person
  // put its entries in.
  const next = [...lines]
  next.splice(insertAt, 0, `${indent}${quoted}: true`)
  return next.join('\n')
}

/**
 * Ensure the profile allows one package's build scripts.
 * @param profileDir - the profile directory.
 * @param packageName - the package about to be installed.
 * @returns true when the file was written.
 */
export function allowBuild(profileDir: string, packageName: string): boolean {
  const path = join(profileDir, WORKSPACE_FILE)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // No settings file: the launcher writes one on `initProfile`, so its
    // absence means a hand-made profile. Creating it with just this key is
    // correct — every other setting has a default.
    text = ''
  }
  const next = withAllowBuild(text, packageName)
  if (next === undefined) return false
  writeFileSync(path, next)
  return true
}

/** pnpm's own name for the refusal a git plugin's own `prepare` hits. */
const GIT_BUILD_REFUSAL = 'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED'

/** pnpm's own name for the refusal a DEPENDENCY's build script hits. */
const IGNORED_BUILDS = 'ERR_PNPM_IGNORED_BUILDS'

/** The sentence that carries the ignored packages, and everything after it. */
const IGNORED_BUILDS_LABEL = 'Ignored build scripts:'

/**
 * The allowlist key pnpm asked for, read out of the refusal that named it.
 *
 * pnpm prints the key it wants as a copyable example — an `allowBuilds:` line
 * followed by one indented `<key>: true`. That printed line is taken verbatim
 * rather than composed from the error's other fields, because it IS the answer
 * to the question, in whatever form that version of pnpm keys by.
 *
 * The key holds a URL, so it holds colons; the split is on the LAST `: true`
 * rather than the first colon. And the whole read is gated on the refusal's
 * own error code, so an `allowBuilds:` mentioned by any other output — a
 * person's comment quoted back in a diff, a different diagnostic — is never
 * mistaken for pnpm dictating a key.
 * @param log - the failed command's captured output.
 * @returns the key, or undefined when this failure was not that refusal.
 */
export function gitBuildKey(log: readonly string[]): string | undefined {
  if (!log.some(line => line.includes(GIT_BUILD_REFUSAL))) return undefined
  for (let index = 0; index < log.length; index += 1) {
    if ((log[index] ?? '').trim() !== 'allowBuilds:') continue
    const entry = (log[index + 1] ?? '').trim()
    // Greedy, so the capture runs to the last `: true` and keeps the URL's
    // own colons; the value is pnpm's, and only `true` is an allowance.
    const key = /^(.+):\s*true$/u.exec(entry)?.[1]?.trim()
    // A git key is a package name joined to the tarball pnpm resolved. Anything
    // without that shape is not what this is for, and writing it would put a
    // line into somebody's settings file for no reason.
    if (key !== undefined && key.includes('://')) return key
  }
  return undefined
}

/**
 * The dependencies pnpm skipped the build scripts of.
 *
 * A plugin can depend on a package that builds itself — `omdsh-sidepanel` and
 * `omdsh-codemode` both pull in `node-pty` — and pnpm blocks those the same way
 * it blocks a git plugin's own `prepare`, under a different error and a
 * different key. Here the key is the bare NAME: pnpm prints `name@version` and
 * allows on the name, so the version is dropped. Scoped names carry an `@` of
 * their own, which is why the split is on the LAST one.
 * @param log - the failed command's captured output.
 * @returns the package names, or none when this failure was not that refusal.
 */
export function ignoredBuildNames(log: readonly string[]): string[] {
  if (!log.some(line => line.includes(IGNORED_BUILDS))) return []
  const names: string[] = []
  for (const line of log) {
    const index = line.indexOf(IGNORED_BUILDS_LABEL)
    if (index === -1) continue
    for (const item of line.slice(index + IGNORED_BUILDS_LABEL.length).split(',')) {
      const entry = item.trim()
      if (entry === '') continue
      // Strip a trailing VERSION, never a trailing URL: pnpm names a blocked
      // git dependency by its whole resolved key here too
      // (`@scope/name@https://codeload…`), and cutting at that `@` would leave
      // the bare name — which the allowlist may already hold, so the retry
      // would read a real refusal as no progress and stop.
      const at = entry.lastIndexOf('@')
      const name = at > 0 && !entry.slice(at + 1).includes('://') ? entry.slice(0, at) : entry
      if (name !== '' && !names.includes(name)) names.push(name)
    }
  }
  return names
}

/**
 * Everything pnpm refused to build, in the form it will accept an allowance in.
 *
 * The two refusals are read together because one install can only report the
 * one it reached first, and answering both from one pass is what keeps a
 * plugin with a native dependency from costing two round trips.
 *
 * What neither answers is a refusal from INSIDE a git plugin's own build. That
 * one runs `pnpm install` in a directory under pnpm's store to fetch the
 * plugin's devDependencies, fails there on a package like `esbuild`, and
 * surfaces as `ERR_PNPM_PREPARE_PACKAGE`. No allowlist in the profile reaches
 * that directory. Publishing the plugin is what avoids it: a registry install
 * downloads a built tree and runs no build at all.
 * @param log - the failed command's captured output.
 * @returns the keys to allow, in the order they should be written.
 */
export function blockedBuilds(log: readonly string[]): string[] {
  const key = gitBuildKey(log)
  return [...key === undefined ? [] : [key], ...ignoredBuildNames(log)]
}

/** One spawned command's outcome. */
export interface RunOutcome {
  readonly code: number
  readonly log: readonly string[]
}

/** How a command is run; injected so specs never spawn a process. */
export type RunCommand = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string | undefined> },
) => Promise<RunOutcome>

/**
 * Keep the tail of a command's output, bounded in both directions.
 * @param chunks - everything written to stdout and stderr, in arrival order.
 * @returns the last {@link LOG_LINES} lines, each truncated.
 */
export function boundLog(chunks: readonly string[]): string[] {
  const lines = chunks.join('').split('\n').filter(line => line.trim() !== '')
  return lines
    .slice(-LOG_LINES)
    .map(line => (line.length > LOG_LINE_CHARS ? `${line.slice(0, LOG_LINE_CHARS)}…` : line))
}

/**
 * Spawn one command and collect its output.
 *
 * No shell, on every platform including Windows: the arguments are a
 * specifier this runtime resolved and a profile name it derived, and passing
 * them as an argv array is what keeps them arguments rather than syntax.
 * @param command - the executable.
 * @param args - its arguments.
 * @param options - working directory and environment.
 * @returns the exit code and the bounded log.
 */
export const runCommand: RunCommand = (command, args, options) => new Promise((resolveRun) => {
  const chunks: string[] = []
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    resolveRun({ code: EXIT_NOT_FOUND, log: [error instanceof Error ? error.message : String(error)] })
    return
  }
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { chunks.push(chunk) })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { chunks.push(chunk) })
  child.on('error', (error: NodeJS.ErrnoException) => {
    // ENOENT here means the command OR the working directory is missing, and
    // guessing which sends a person looking in the wrong place — the earlier
    // wording asserted "install dsh" at someone whose dsh was plainly
    // installed. Both candidates are named instead.
    chunks.push(error.code === 'ENOENT'
      ? `could not run ${command} in ${options.cwd} — the launcher or that directory is unreachable from this runtime`
      : error.message)
    resolveRun({ code: EXIT_NOT_FOUND, log: boundLog(chunks) })
  })
  child.on('close', (code) => { resolveRun({ code: code ?? 1, log: boundLog(chunks) }) })
})

/**
 * The specifier an UPDATE runs against.
 *
 * `pnpm add <name>` on a dependency the manifest already satisfies is a no-op:
 * pnpm answers "Already up to date", changes nothing, and exits zero — so the
 * operation is reported as successful and the card still offers the update it
 * just appeared to perform. A git specifier does not have this problem, because
 * re-resolving a ref is the whole of what it does.
 *
 * So an update names its destination. The catalog already knows it — the card
 * renders `0.1.3 → 0.2.0` from the same field — and naming it buys two things
 * beyond correctness: the button installs the version printed above it rather
 * than whatever `latest` means at the moment it is pressed, and an explicit
 * version is exempt from pnpm's `minimumReleaseAge`, which otherwise hides a
 * release for its first day and turns the first press after a publish into
 * that same silent no-op.
 *
 * Left alone: a git specifier, a `link:` or path install (there is nothing to
 * fetch, and the panel already calls it `linked`), and a specifier that
 * carries its own range — appending to any of those would corrupt it.
 * @param spec - the specifier the catalog resolved.
 * @param version - the version that catalog advertises, when it knows one.
 * @returns the specifier to hand to `dsh plugin add`.
 */
export function updateSpec(spec: string, version?: string): string {
  if (isGitSpec(spec)) return spec
  if (spec.startsWith('link:') || spec.startsWith('file:') || spec.startsWith('/') || spec.startsWith('.')) return spec
  if (/^[A-Za-z]:[\\/]/.test(spec)) return spec
  // A range is already there when an `@` appears past a scope's leading one.
  if (spec.lastIndexOf('@') > 0) return spec
  // Guarded rather than trusted: `version` reaches here from a remote manifest,
  // and while it is spawned as one argv entry rather than through a shell, a
  // value carrying whitespace or an `@` would build a specifier that means
  // something else. `latest` is the honest fallback — still an update, just
  // not a promised one.
  return /^[\w][\w.+-]*$/.test(version ?? '') ? `${spec}@${String(version)}` : `${spec}@latest`
}

/** What the installer needs to do its work. */
export interface InstallerOptions {
  readonly profileDir: string
  readonly profileName: string
  readonly home: string
  /**
   * The explicitly configured `dsh` launcher path, read per operation rather
   * than captured: the namespace that carries it applies live, so a person who
   * corrects the path must not have to restart to use the correction.
   */
  readonly launcher?: () => string | undefined
  /** The explicitly configured `pnpm` path, read per operation for the same reason. */
  readonly pnpm?: () => string | undefined
  /** How a command is run; the real spawner by default. */
  readonly run?: RunCommand
}

/**
 * Runs one operation at a time against one profile.
 *
 * Serialized because two `pnpm` runs in one directory race over the same
 * lockfile and node_modules, and the loser's diagnostic ("ENOENT", "lockfile
 * is out of date") describes the race rather than anything the person did.
 * A queued operation is reported as `running` from the moment it is accepted,
 * so the panel shows the truth: it IS going to happen, just not yet.
 */
export class Installer {
  private tail: Promise<void> = Promise.resolve()
  private nextId = 0
  private readonly run: RunCommand

  /**
   * @param options - profile identity, launcher, and the command runner.
   * @param onChange - notified on every state transition of every operation.
   */
  constructor(
    private readonly options: InstallerOptions,
    private readonly onChange: (operation: OperationState) => void,
  ) {
    this.run = options.run ?? runCommand
  }

  /**
   * Queue an install.
   * @param name - the package name, for reporting.
   * @param spec - the specifier the catalog resolved for it.
   * @returns the operation as it stands when accepted.
   */
  install(name: string, spec: string): OperationState {
    return this.enqueue('install', name, () => this.add(name, spec))
  }

  /**
   * Queue an update: the same `add` against the specifier the catalog resolves
   * now.
   *
   * There is no separate launcher verb for this, and there does not need to be
   * — an update is `add` against a specifier that names where it is going. For
   * a git specifier that is the same specifier, since re-resolving the ref is
   * what it does; for a registry one it is {@link updateSpec}'s work, because a
   * bare `pnpm add <name>` on a dependency the manifest already satisfies
   * changes nothing and says it succeeded. Distinguishing it from an install is
   * otherwise entirely about how it reads: the button, the log line, and the
   * failure all say "update" because that is what the person asked for.
   * @param name - the package name.
   * @param spec - the specifier the catalog resolved for it.
   * @param version - the version the catalog advertises, when it knows one.
   * @returns the operation as it stands when accepted.
   */
  update(name: string, spec: string, version?: string): OperationState {
    return this.enqueue('update', name, () => this.add(name, updateSpec(spec, version)))
  }

  /**
   * Queue a removal.
   * @param name - the package name to remove.
   * @returns the operation as it stands when accepted.
   */
  uninstall(name: string): OperationState {
    return this.enqueue('uninstall', name, () =>
      ['plugin', '--profile', this.options.profileName, 'remove', name])
  }

  /** Settlement of everything queued so far, for teardown. */
  drain(): Promise<void> {
    return this.tail
  }

  /** The `dsh plugin add` argv, and the allowlist entry a git specifier needs first. */
  private add(name: string, spec: string): string[] {
    // Before the install, never after: a git plugin builds itself in
    // `prepare`, and an unallowlisted `prepare` fails one restart later than
    // the install that skipped it.
    //
    // Only when `name` is one: a caller that installs a bare specifier does
    // not know the package name until the tree is fetched, and the entry this
    // would write from a specifier is a key pnpm can never match — a line left
    // in somebody's settings file forever, buying nothing. The retry path
    // covers that case exactly as it covers a git plugin whose name was right.
    if (isGitSpec(spec) && isPackageName(name)) allowBuild(this.options.profileDir, name)
    return ['plugin', '--profile', this.options.profileName, 'add', spec]
  }

  /** Accept one operation, publish it as running, and chain it behind the rest. */
  private enqueue(kind: OperationKind, name: string, argv: () => string[]): OperationState {
    const accepted: OperationState = { id: ++this.nextId, kind, name, status: 'running', log: [] }
    // Chain past a failed predecessor: one bad install must not wedge the
    // queue for every later operation.
    this.tail = this.tail.catch(() => undefined).then(async () => {
      const settled = await this.perform(accepted, argv)
      this.onChange(settled)
    })
    this.onChange(accepted)
    return accepted
  }

  /** Run one operation to settlement. */
  private async perform(accepted: OperationState, argv: () => string[]): Promise<OperationState> {
    let args: string[]
    try {
      args = argv()
    } catch (error) {
      return { ...accepted, status: 'failed', error: error instanceof Error ? error.message : String(error), log: [] }
    }
    const launcher = resolveLauncher(this.options.profileDir, this.options.launcher?.())
    // The launcher's own second hop: `dsh plugin` runs `pnpm` by bare name, so
    // a PATH that could not find the launcher will not find pnpm either. The
    // desktop application bundles one into its runtime closure for exactly
    // this search to find.
    const pnpmDir = resolvePnpmDir({
      configured: this.options.pnpm?.(),
      launcherEntry: launcher.args[0] ?? launcher.command,
      profileDir: this.options.profileDir,
      path: process.env['PATH'],
    })
    const prefix = pnpmDir === undefined ? launcher.pathPrefix : [...launcher.pathPrefix, pnpmDir]
    const attempt = (): Promise<RunOutcome> => this.run(launcher.command, [...launcher.args, ...args], {
      // Run from the profile so a relative path argument could never be
      // anchored anywhere surprising — every specifier this plugin passes is
      // already absolute or remote, and this keeps that true by construction.
      cwd: this.options.profileDir,
      // The home is passed explicitly rather than inherited: this process
      // resolved it once, and `dsh plugin` must resolve the SAME one or it
      // would reconcile a different profile of the same name. PATH is widened
      // for the launcher's own second hop — see LauncherCommand.pathPrefix.
      env: {
        ...process.env,
        DSH_HOME: this.options.home,
        PATH: withPathPrefix(process.env['PATH'], prefix),
      },
    })

    // pnpm reports the refusals it reached, not the ones it would reach next:
    // a plugin with a native dependency is blocked on that first and on its own
    // `prepare` only once the dependency is allowed. So this answers each
    // refusal and runs again, and stops the moment an attempt names nothing
    // new — `allowBuild` answers false for a key already set to `true`, which
    // is what makes progress the loop's condition rather than a count. The
    // bound is a backstop against a pnpm that would name a key writing it does
    // not satisfy, and never the thing that ends a healthy install.
    let outcome = await attempt()
    for (let pass = 0; pass < ALLOW_PASSES && outcome.code !== 0; pass += 1) {
      const written = blockedBuilds(outcome.log)
        .filter(key => allowBuild(this.options.profileDir, key))
      if (written.length === 0) break
      outcome = await attempt()
    }

    if (outcome.code === 0) return { ...accepted, status: 'ok', log: outcome.log }
    return {
      ...accepted,
      status: 'failed',
      // 127 is the launcher's own "a program I need is not on PATH", and it
      // means PNPM far more often than it means `dsh` — a `dsh web` started
      // from a GUI launcher rather than a terminal inherits a minimal PATH,
      // finds the launcher (this module resolved it) and then cannot find
      // what the launcher shells out to. Naming the likely cause beats an
      // exit code, and the captured output below has the launcher's own words.
      error: outcome.code === EXIT_NOT_FOUND
        ? `${launcher.command} exited 127 — something it needs is not on this runtime's PATH, usually pnpm; see the output`
        : `${launcher.command} exited ${String(outcome.code)}`,
      log: outcome.log,
    }
  }
}
