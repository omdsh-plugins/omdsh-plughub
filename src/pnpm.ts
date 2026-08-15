/**
 * Finding the package manager the launcher shells out to.
 *
 * ## Why this is a problem at all
 *
 * `dsh plugin` runs `pnpm` by bare name, so it resolves through `PATH`. That
 * is fine in a terminal and wrong everywhere else: a runtime started from a
 * GUI launcher inherits `/usr/bin:/bin:/usr/sbin:/sbin` and nothing more, and
 * a packaged desktop application inherits whatever `launchd` felt like. The
 * failure is `dsh: pnpm not found on PATH` from a machine that plainly has
 * pnpm, which tells the person to install something they already installed.
 *
 * This plugin controls the child's environment, so it can answer the question
 * `PATH` could not. Nothing here runs pnpm or reimplements any part of it —
 * the whole module returns ONE directory for the caller to put in front of the
 * child's `PATH`.
 *
 * ## The order, and why it ends where it does
 *
 * A configured path wins, because that is what configuration is for. Then an
 * inherited `PATH` that already works is left alone — no reordering, no
 * second-guessing which pnpm a working setup meant. Then the two `node_modules`
 * trees this runtime can see, which is where a DELIBERATELY shipped pnpm lives:
 * the desktop application bundles one into its runtime closure precisely so
 * this search finds it, and an installation that put pnpm beside `dsh` is found
 * the same way.
 *
 * Only after all of that does it try the places pnpm's own installers use.
 * Those are guesses, and they are last for that reason — but they are cheap
 * (a handful of `stat`s, no subprocess) and they rescue an application built
 * before the closure carried its own.
 * @module @omdsh-plugins/omdsh-plughub/pnpm
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

/** The executable `dsh plugin` looks for. */
const PNPM = 'pnpm'

/** Windows resolves a command through these suffixes; POSIX uses the bare name. */
const WINDOWS_SUFFIXES = ['.cmd', '.exe', '.bat'] as const

/** Where a package manager sits inside a dependency tree. */
const BIN_RELATIVE = join('node_modules', '.bin')

/** What the search may look at. */
export interface PnpmSearch {
  /** An explicitly configured path to the pnpm executable. */
  readonly configured?: string | undefined
  /** The launcher's entry script, whose tree may carry a bundled pnpm. */
  readonly launcherEntry?: string | undefined
  /** The profile directory, whose tree may carry one too. */
  readonly profileDir?: string | undefined
  /** The `PATH` the child would otherwise inherit. */
  readonly path?: string | undefined
  /** The environment, read for `PNPM_HOME`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The platform, which decides the executable suffixes and the well-known homes. */
  readonly platform?: NodeJS.Platform
  /** The user's home directory. */
  readonly home?: string
  /** Existence check, injected for specs. */
  readonly exists?: (path: string) => boolean
}

/** Whether a directory holds a runnable pnpm for this platform. */
function holdsPnpm(directory: string, platform: NodeJS.Platform, exists: (path: string) => boolean): boolean {
  if (directory === '') return false
  if (platform !== 'win32') return exists(join(directory, PNPM))
  return WINDOWS_SUFFIXES.some(suffix => exists(join(directory, `${PNPM}${suffix}`)))
}

/**
 * Every ancestor of a path, nearest first, including the path itself.
 * @param from - the starting directory.
 * @returns the ancestor chain.
 */
function ancestors(from: string): string[] {
  const chain: string[] = []
  let current = from
  for (;;) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) return chain
    current = parent
  }
}

/**
 * The directories pnpm's own installers use, in the order they are likely.
 *
 * `PNPM_HOME` is what the standalone installer exports, and it is checked
 * first for the same reason a configured path is: somebody said it. The rest
 * are the defaults that installer and the common package managers write to.
 * @param platform - the platform.
 * @param home - the user's home directory.
 * @param env - the environment.
 * @returns candidate directories.
 */
export function wellKnownPnpmDirs(
  platform: NodeJS.Platform,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const configured = env['PNPM_HOME']
  const candidates = configured === undefined || configured === '' ? [] : [configured]
  if (platform === 'darwin') candidates.push(join(home, 'Library', 'pnpm'))
  else if (platform === 'win32') candidates.push(join(home, 'AppData', 'Local', 'pnpm'))
  else candidates.push(join(home, '.local', 'share', 'pnpm'))
  candidates.push(join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin')
  return candidates
}

/**
 * Find a directory to put in front of the child's `PATH` so `pnpm` resolves.
 * @param search - where this runtime is allowed to look.
 * @returns the directory, or undefined when pnpm already resolves (or nothing was found).
 */
export function resolvePnpmDir(search: PnpmSearch): string | undefined {
  const platform = search.platform ?? process.platform
  const exists = search.exists ?? existsSync
  const env = search.env ?? process.env
  const home = search.home ?? homedir()
  const holds = (directory: string): boolean => holdsPnpm(directory, platform, exists)

  const { configured } = search
  if (configured !== undefined && configured !== '') {
    // A configured path names the executable; the caller needs its directory.
    // Returned without an existence check, so a wrong one fails loudly at the
    // spawn instead of being silently ignored in favour of a guess.
    return dirname(configured)
  }

  // Already reachable: say nothing rather than reorder a working PATH.
  const inherited = (search.path ?? '').split(delimiter).filter(entry => entry !== '')
  if (inherited.some(holds)) return undefined

  // The trees this runtime can see. A desktop application bundles pnpm into
  // its runtime closure so that this is the branch that finds it.
  const roots = [search.launcherEntry, search.profileDir]
    .filter((root): root is string => root !== undefined && root !== '')
  for (const root of roots) {
    for (const ancestor of ancestors(root)) {
      const bin = join(ancestor, BIN_RELATIVE)
      if (holds(bin)) return bin
    }
  }

  return wellKnownPnpmDirs(platform, home, env).find(holds)
}
