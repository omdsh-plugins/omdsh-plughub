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
 * @module @omdsh-plugins/omdsh-plughub/installer
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { OperationKind, OperationState } from './contract.ts'
import { isGitSpec } from './catalog/source.ts'
import { resolvePnpmDir } from './pnpm.ts'

/** How many lines of package-manager output one operation keeps. */
const LOG_LINES = 200

/** How long one line may be before it is truncated. */
const LOG_LINE_CHARS = 500

/** The profile's pnpm settings file; pnpm ≥10 reads them from here, not `.npmrc`. */
const WORKSPACE_FILE = 'pnpm-workspace.yaml'

/** Where the launcher's own binary would sit inside an installation. */
const BIN_RELATIVE = join('node_modules', '.bin', 'dsh')

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
    // Match on the key however it was quoted, so re-running is a no-op.
    const key = /^(['"]?)(.*?)\1\s*:/.exec(entry)?.[2]
    if (key === packageName) return undefined
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
    resolveRun({ code: 127, log: [error instanceof Error ? error.message : String(error)] })
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
    resolveRun({ code: 127, log: boundLog(chunks) })
  })
  child.on('close', (code) => { resolveRun({ code: code ?? 1, log: boundLog(chunks) }) })
})

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
   * — `pnpm add` on a dependency that is already there re-resolves it, which
   * for a registry specifier means the latest published version and for a git
   * one means whatever the ref now points at. Distinguishing it from an
   * install is entirely about how it reads: the button, the log line, and the
   * failure all say "update" because that is what the person asked for.
   * @param name - the package name.
   * @param spec - the specifier the catalog resolved for it.
   * @returns the operation as it stands when accepted.
   */
  update(name: string, spec: string): OperationState {
    return this.enqueue('update', name, () => this.add(name, spec))
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
    if (isGitSpec(spec)) allowBuild(this.options.profileDir, name)
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
    const outcome = await this.run(launcher.command, [...launcher.args, ...args], {
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
