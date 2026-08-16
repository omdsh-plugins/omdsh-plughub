/**
 * The only part of this plugin that writes.
 *
 * Two properties carry the weight. The allowlist edit has to be written BEFORE
 * a git install, because pnpm ≥10 blocks the `prepare` that builds the plugin
 * and the resulting failure arrives one restart later than the mistake. And
 * operations have to be serialized, because two `pnpm` runs in one directory
 * race over the same lockfile.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OperationState } from '../src/contract.ts'
import {
  allowBuild, blockedBuilds, boundLog, gitBuildKey, ignoredBuildNames, Installer, isLauncherEntry,
  resolveLauncher, withAllowBuild,
  withPathPrefix, type RunCommand, type RunningProcess,
} from '../src/installer.ts'

const temporaries: string[] = []

afterEach(() => {
  while (temporaries.length > 0) rmSync(temporaries.pop() as string, { recursive: true, force: true })
})

/** A scratch profile directory removed after the test. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plughub-installer-'))
  temporaries.push(dir)
  return dir
}

/** The pnpm settings file the launcher's `initProfile` writes. */
const TEMPLATE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

describe('withAllowBuild', () => {
  it('appends a block to a file that has none', () => {
    const next = withAllowBuild(TEMPLATE, '@x/omdsh-a')
    expect(next).toContain('allowBuilds:\n  \'@x/omdsh-a\': true\n')
    // Everything a person wrote is still there.
    expect(next).toContain('nodeLinker: hoisted')
  })

  it('adds to the end of an existing block, keeping its order', () => {
    const next = withAllowBuild(`${TEMPLATE}\nallowBuilds:\n  esbuild: true\n  node-pty: true\n`, '@x/omdsh-a')
    expect(next).toBe(`${TEMPLATE}\nallowBuilds:\n  esbuild: true\n  node-pty: true\n  '@x/omdsh-a': true\n`)
  })

  it('is a no-op when the package is already allowed, however it was quoted', () => {
    expect(withAllowBuild('allowBuilds:\n  \'@x/omdsh-a\': true\n', '@x/omdsh-a')).toBeUndefined()
    expect(withAllowBuild('allowBuilds:\n  "@x/omdsh-a": true\n', '@x/omdsh-a')).toBeUndefined()
    expect(withAllowBuild('allowBuilds:\n  esbuild: true\n', 'esbuild')).toBeUndefined()
  })

  it('leaves an inline mapping alone rather than mangling it', () => {
    // pnpm's own refusal names the exact key to add, which beats a settings
    // file this rewrote badly.
    expect(withAllowBuild('allowBuilds: { esbuild: true }\n', '@x/omdsh-a')).toBeUndefined()
  })

  it('does not follow the block past a dedent', () => {
    const next = withAllowBuild('allowBuilds:\n  esbuild: true\nnodeLinker: hoisted\n', '@x/omdsh-a')
    expect(next).toBe('allowBuilds:\n  esbuild: true\n  \'@x/omdsh-a\': true\nnodeLinker: hoisted\n')
  })

  it('writes a block into an empty file', () => {
    expect(withAllowBuild('', '@x/omdsh-a')).toBe('\nallowBuilds:\n  \'@x/omdsh-a\': true\n')
  })
})

describe('withAllowBuild on an entry pnpm wrote itself', () => {
  const asked = "packages:\n  - .\n\nallowBuilds:\n  node-pty: set this to true or false\n"

  it('answers the question pnpm left, rather than reading it as already allowed', () => {
    expect(withAllowBuild(asked, 'node-pty')).toContain("'node-pty': true")
    expect(withAllowBuild(asked, 'node-pty')).not.toContain('set this to true or false')
  })

  it('adds no second entry for the same package', () => {
    const next = withAllowBuild(asked, 'node-pty') ?? ''
    expect(next.split('node-pty').length - 1).toBe(1)
  })

  it('leaves an entry already set to true alone, which is what ends the retry', () => {
    expect(withAllowBuild("allowBuilds:\n  'node-pty': true\n", 'node-pty')).toBeUndefined()
  })

  it('turns a deliberate false into true, because pressing Install is the answer', () => {
    expect(withAllowBuild("allowBuilds:\n  'node-pty': false\n", 'node-pty')).toContain("'node-pty': true")
  })
})

describe('allowBuild', () => {
  it('writes the settings file, and creates one when a profile has none', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), TEMPLATE)
    expect(allowBuild(dir, '@x/omdsh-a')).toBe(true)
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('\'@x/omdsh-a\': true')
    expect(allowBuild(dir, '@x/omdsh-a')).toBe(false)

    const bare = scratch()
    expect(allowBuild(bare, '@x/omdsh-b')).toBe(true)
    expect(readFileSync(join(bare, 'pnpm-workspace.yaml'), 'utf8')).toContain('allowBuilds:')
  })
})

/** A process that is not the launcher, so the PATH fallbacks are reachable. */
const NOT_LAUNCHER: RunningProcess = { execPath: '/usr/bin/node', argv: ['/usr/bin/node', '/tmp/absent.js'] }

/**
 * Lay out an installation the way npm does: the CLI is a symlink in a bin
 * directory pointing into the package, which is the shape `isLauncherEntry`
 * has to see through.
 * @param root - a scratch root.
 * @returns the symlink path and the package's entry script.
 */
function installation(root: string): { link: string; entry: string } {
  const pkg = join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  const entry = join(pkg, 'lib', 'bin.js')
  writeFileSync(entry, '#!/usr/bin/env node\n')
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const link = join(bin, 'dsh')
  symlinkSync(entry, link)
  return { link, entry }
}

describe('isLauncherEntry', () => {
  it('sees through the bin symlink to the package that vouches for it', () => {
    const { link, entry } = installation(scratch())
    expect(isLauncherEntry(link)).toBe(true)
    expect(isLauncherEntry(entry)).toBe(true)
  })

  it('refuses a script belonging to some other package, or none', () => {
    const root = scratch()
    const other = join(root, 'other')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'something-else' }))
    writeFileSync(join(other, 'cli.js'), '')
    expect(isLauncherEntry(join(other, 'cli.js'))).toBe(false)
    expect(isLauncherEntry(join(root, 'absent.js'))).toBe(false)
  })
})

describe('resolveLauncher', () => {
  it('prefers a configured path', () => {
    expect(resolveLauncher(scratch(), '/opt/homebrew/bin/dsh')).toEqual({
      command: '/opt/homebrew/bin/dsh',
      args: [],
      pathPrefix: ['/opt/homebrew/bin'],
    })
  })

  it('runs the launcher this process already is, without consulting PATH', () => {
    // The process booting a profile IS dsh, so the most reliable launcher is
    // the running one — and a runtime started from a GUI launcher has a
    // minimal PATH in which `spawn('dsh')` fails on a plainly-installed dsh.
    const { link } = installation(scratch())
    const self: RunningProcess = { execPath: '/opt/homebrew/Cellar/node/bin/node', argv: ['node', link] }
    expect(resolveLauncher(scratch(), undefined, self)).toEqual({
      command: '/opt/homebrew/Cellar/node/bin/node',
      args: [link],
      // The launcher's own directory first: a sibling `pnpm` is what the
      // launcher's second hop needs.
      pathPrefix: [dirname(link), '/opt/homebrew/Cellar/node/bin'],
    })
  })

  it('finds an installation on the walk up when this process is not one', () => {
    const root = scratch()
    const profile = join(root, 'profiles', 'web')
    mkdirSync(profile, { recursive: true })
    const bin = join(root, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'dsh'), '#!/bin/sh\n')
    expect(resolveLauncher(profile, undefined, NOT_LAUNCHER))
      .toEqual({ command: join(bin, 'dsh'), args: [], pathPrefix: [bin] })
  })

  it('falls back to the bare name for PATH', () => {
    expect(resolveLauncher(scratch(), undefined, NOT_LAUNCHER))
      .toEqual({ command: 'dsh', args: [], pathPrefix: [] })
  })
})

describe('withPathPrefix', () => {
  it('puts the launcher\'s directory in front', () => {
    expect(withPathPrefix('/usr/bin:/bin', ['/opt/homebrew/bin'])).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('does not duplicate what is already there', () => {
    expect(withPathPrefix('/usr/bin:/opt/homebrew/bin', ['/opt/homebrew/bin'])).toBe('/usr/bin:/opt/homebrew/bin')
  })

  it('survives an absent or empty PATH', () => {
    expect(withPathPrefix(undefined, ['/opt/homebrew/bin'])).toBe('/opt/homebrew/bin')
    expect(withPathPrefix('', [])).toBe('')
  })
})

describe('boundLog', () => {
  it('keeps the tail and drops blank lines', () => {
    expect(boundLog(['a\n', '\n', 'b\n'])).toEqual(['a', 'b'])
  })

  it('bounds both the line count and the line length', () => {
    const many = boundLog([Array.from({ length: 500 }, (_, index) => `line ${String(index)}`).join('\n')])
    expect(many).toHaveLength(200)
    expect(many[199]).toBe('line 499')
    expect(boundLog(['x'.repeat(900)])[0]).toHaveLength(501)
  })
})

const REFUSAL_KEY = '@x/omdsh-a@https://codeload.github.com/o/omdsh-a/tar.gz/ed316bd'

/** pnpm's refusal, as `boundLog` hands it over: blank lines already dropped. */
function refusalLog(key = REFUSAL_KEY): string[] {
  return [
    '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from',
    'This error happened while installing a direct dependency of /tmp/profiles/web',
    'Add the package to "allowBuilds" in your project\'s pnpm-workspace.yaml. For example:',
    'allowBuilds:',
    `  ${key}: true`,
  ]
}

describe('gitBuildKey', () => {
  it('reads the key pnpm printed, colons in the URL and all', () => {
    expect(gitBuildKey(refusalLog())).toBe(REFUSAL_KEY)
  })

  it('answers nothing for a failure that was not that refusal', () => {
    expect(gitBuildKey(['ERR_PNPM_FETCH_404 Not Found', 'allowBuilds:', '  @x/a@https://h/t: true']))
      .toBeUndefined()
  })

  it('answers nothing when the refusal named no key', () => {
    expect(gitBuildKey(['[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] blocked'])).toBeUndefined()
  })

  it('ignores a bare package name, which is not what pnpm keys a git package by', () => {
    expect(gitBuildKey([...refusalLog('@x/omdsh-a')])).toBeUndefined()
  })

  it('ignores a value that is not an allowance', () => {
    expect(gitBuildKey([...refusalLog().slice(0, 4), `  ${REFUSAL_KEY}: false`])).toBeUndefined()
  })
})

describe('ignoredBuildNames', () => {
  it('reads the bare names pnpm blocked, dropping the versions it printed', () => {
    expect(ignoredBuildNames(['[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0']))
      .toEqual(['node-pty'])
  })

  it('splits a list, and keeps a scoped name whole', () => {
    expect(ignoredBuildNames(['[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.28.2, @scope/thing@2.0.0']))
      .toEqual(['esbuild', '@scope/thing'])
  })

  it('answers nothing for a failure that was not that refusal', () => {
    expect(ignoredBuildNames(['Ignored build scripts: node-pty@1.1.0'])).toEqual([])
  })

  it('keeps a resolved git key whole, because the URL is part of it and not a version', () => {
    expect(ignoredBuildNames([`[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: ${REFUSAL_KEY}`]))
      .toEqual([REFUSAL_KEY])
  })
})

describe('blockedBuilds', () => {
  it('answers both refusals from one failure, so a plugin tripping both costs one retry', () => {
    expect(blockedBuilds([...refusalLog(), '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0']))
      .toEqual([REFUSAL_KEY, 'node-pty'])
  })

  it('answers nothing for a failure that was neither', () => {
    expect(blockedBuilds(['[ERR_PNPM_FETCH_404] Not Found'])).toEqual([])
  })
})

describe('Installer', () => {
  /** A runner that records its calls and answers a fixed code. */
  function stubRunner(code = 0, log: string[] = []): RunCommand & { calls: string[][] } {
    const calls: string[][] = []
    const run: RunCommand = (command, args) => {
      calls.push([command, ...args])
      return Promise.resolve({ code, log })
    }
    return Object.assign(run, { calls })
  }

  /** Collect every transition an installer publishes. */
  function collector(): { states: OperationState[]; onChange: (state: OperationState) => void } {
    const states: OperationState[] = []
    return { states, onChange: state => { states.push(state) } }
  }

  it('runs `dsh plugin add` against the resolved profile', async () => {
    const dir = scratch()
    const run = stubRunner()
    const sink = collector()
    const installer = new Installer(
      { profileDir: dir, profileName: 'web', home: '/tmp/home', launcher: () => '/bin/dsh', run },
      sink.onChange,
    )
    installer.install('@x/omdsh-a', 'github:o/omdsh-a')
    await installer.drain()
    expect(run.calls[0]).toEqual(['/bin/dsh', 'plugin', '--profile', 'web', 'add', 'github:o/omdsh-a'])
    expect(sink.states.map(state => state.status)).toEqual(['running', 'ok'])
  })

  /** A runner that refuses the first call the way pnpm does, then answers `code`. */
  function refusingRunner(code = 0): RunCommand & { calls: string[][] } {
    const calls: string[][] = []
    const run: RunCommand = (command, args) => {
      calls.push([command, ...args])
      return Promise.resolve(calls.length === 1
        ? { code: 1, log: refusalLog() }
        : { code, log: [] })
    }
    return Object.assign(run, { calls })
  }

  it('writes the key pnpm dictated and runs the install again', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), TEMPLATE)
    const run = refusingRunner()
    const sink = collector()
    const installer = new Installer(
      { profileDir: dir, profileName: 'web', home: '/tmp/home', launcher: () => '/bin/dsh', run },
      sink.onChange,
    )
    installer.install('@x/omdsh-a', 'github:o/omdsh-a')
    await installer.drain()

    expect(run.calls).toHaveLength(2)
    expect(run.calls[1]).toEqual(run.calls[0])
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain(`'${REFUSAL_KEY}': true`)
    expect(sink.states.at(-1)?.status).toBe('ok')
  })

  it('answers refusals that arrive one after another, not just the first', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), TEMPLATE)
    const calls: string[][] = []
    const run: RunCommand = (command, args) => {
      calls.push([command, ...args])
      if (calls.length === 1) {
        return Promise.resolve({ code: 1, log: ['[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0'] })
      }
      // Only once the dependency is allowed does pnpm reach the plugin's own
      // `prepare`, which is the refusal it could not have reported first.
      if (calls.length === 2) return Promise.resolve({ code: 1, log: refusalLog() })
      return Promise.resolve({ code: 0, log: [] })
    }
    const sink = collector()
    const installer = new Installer(
      { profileDir: dir, profileName: 'web', home: '/tmp/home', launcher: () => '/bin/dsh', run },
      sink.onChange,
    )
    installer.install('@x/omdsh-a', 'github:o/omdsh-a')
    await installer.drain()

    expect(calls).toHaveLength(3)
    const written = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(written).toContain("'node-pty': true")
    expect(written).toContain(`'${REFUSAL_KEY}': true`)
    expect(sink.states.at(-1)?.status).toBe('ok')
  })

  it('retries once and reports a second refusal rather than looping', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), TEMPLATE)
    const calls: string[][] = []
    const run: RunCommand = (command, args) => {
      calls.push([command, ...args])
      return Promise.resolve({ code: 1, log: refusalLog() })
    }
    const sink = collector()
    const installer = new Installer(
      { profileDir: dir, profileName: 'web', home: '/tmp/home', launcher: () => '/bin/dsh', run },
      sink.onChange,
    )
    installer.install('@x/omdsh-a', 'github:o/omdsh-a')
    await installer.drain()

    // The second refusal names a key the file now holds, so `allowBuild`
    // answers false and there is nothing left to try.
    expect(calls).toHaveLength(2)
    expect(sink.states.at(-1)?.status).toBe('failed')
  })

  it('does not retry a failure that was not the build refusal', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), TEMPLATE)
    const run = stubRunner(1, ['[ERR_PNPM_FETCH_404] Not Found'])
    const sink = collector()
    const installer = new Installer(
      { profileDir: dir, profileName: 'web', home: '/tmp/home', launcher: () => '/bin/dsh', run },
      sink.onChange,
    )
    installer.install('@x/omdsh-a', 'github:o/omdsh-a')
    await installer.drain()

    expect(run.calls).toHaveLength(1)
    expect(sink.states.at(-1)?.status).toBe('failed')
  })

  it('allowlists a git install before running it', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), TEMPLATE)
    const installer = new Installer(
      { profileDir: dir, profileName: 'web', home: '/tmp/home', run: stubRunner() },
      () => undefined,
    )
    installer.install('@x/omdsh-a', 'github:o/omdsh-a')
    await installer.drain()
    // A git plugin builds itself in `prepare`; unallowlisted, the install
    // "succeeds" and the next boot dies on a missing lib/.
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('\'@x/omdsh-a\': true')
  })

  it('does not allowlist a path install, which runs no prepare', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), TEMPLATE)
    const installer = new Installer(
      { profileDir: dir, profileName: 'web', home: '/tmp/home', run: stubRunner() },
      () => undefined,
    )
    installer.install('@x/omdsh-a', '/checkouts/omdsh-a')
    await installer.drain()
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).not.toContain('omdsh-a')
  })

  it('runs the same `add` for an update, and reports it as one', async () => {
    const run = stubRunner()
    const sink = collector()
    const installer = new Installer(
      { profileDir: scratch(), profileName: 'web', home: '/tmp/home', launcher: () => '/bin/dsh', run },
      sink.onChange,
    )
    installer.update('@x/omdsh-a', '@x/omdsh-a')
    await installer.drain()
    // There is no separate launcher verb: `pnpm add` on a dependency that is
    // already there re-resolves it, which is what an update is.
    expect(run.calls[0]).toEqual(['/bin/dsh', 'plugin', '--profile', 'web', 'add', '@x/omdsh-a'])
    // The kind is what makes the button, the log line, and the failure read
    // as "update" rather than as a second install.
    expect(sink.states.map(state => state.kind)).toEqual(['update', 'update'])
  })

  it('allowlists a git update too, for the same prepare', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), TEMPLATE)
    const installer = new Installer(
      { profileDir: dir, profileName: 'web', home: '/tmp/home', run: stubRunner() },
      () => undefined,
    )
    installer.update('@x/omdsh-a', 'github:o/omdsh-a')
    await installer.drain()
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('\'@x/omdsh-a\': true')
  })

  it('runs `dsh plugin remove` for a removal', async () => {
    const run = stubRunner()
    const installer = new Installer(
      { profileDir: scratch(), profileName: 'web', home: '/tmp/home', launcher: () => '/bin/dsh', run },
      () => undefined,
    )
    installer.uninstall('@x/omdsh-a')
    await installer.drain()
    expect(run.calls[0]).toEqual(['/bin/dsh', 'plugin', '--profile', 'web', 'remove', '@x/omdsh-a'])
  })

  it('reports a non-zero exit with the command output', async () => {
    const sink = collector()
    const installer = new Installer(
      {
        profileDir: scratch(),
        profileName: 'web',
        home: '/tmp/home',
        run: stubRunner(1, ['ERR_PNPM_BUILD_BLOCKED']),
      },
      sink.onChange,
    )
    installer.install('@x/omdsh-a', '/checkouts/omdsh-a')
    await installer.drain()
    const settled = sink.states[1]
    expect(settled?.status).toBe('failed')
    expect(settled?.error).toContain('exited 1')
    expect(settled?.error).not.toContain('PATH')
    // pnpm's own words are the only diagnosable thing about the commonest
    // install failure.
    expect(settled?.log).toEqual(['ERR_PNPM_BUILD_BLOCKED'])
  })

  it('names the likely cause of a 127 rather than the exit code', async () => {
    const sink = collector()
    const installer = new Installer(
      {
        profileDir: scratch(),
        profileName: 'web',
        home: '/tmp/home',
        launcher: () => '/bin/dsh',
        run: stubRunner(127, ['dsh: pnpm not found on PATH — install pnpm to manage profile plugins']),
      },
      sink.onChange,
    )
    installer.install('@x/omdsh-a', '/checkouts/omdsh-a')
    await installer.drain()
    // 127 from the launcher means PNPM far more often than it means `dsh`,
    // and the exit code alone sends a person looking in the wrong place.
    expect(sink.states[1]?.error).toContain('pnpm')
    expect(sink.states[1]?.log[0]).toContain('pnpm not found on PATH')
  })

  it('runs one operation at a time', async () => {
    const order: string[] = []
    let release = (): void => undefined
    const gate = new Promise<void>((resolveGate) => { release = () => { resolveGate() } })
    const run: RunCommand = async (_command, args) => {
      const spec = args[args.length - 1] as string
      order.push(`start:${spec}`)
      if (spec === 'first') await gate
      order.push(`end:${spec}`)
      return { code: 0, log: [] }
    }
    const installer = new Installer(
      { profileDir: scratch(), profileName: 'web', home: '/tmp/home', run },
      () => undefined,
    )
    installer.install('a', 'first')
    installer.install('b', 'second')
    // Drain the microtask queue: the chain hops through several `then`s
    // before the first command actually starts.
    await new Promise(next => { setImmediate(next) })
    // The second must not have started while the first holds the lockfile.
    expect(order).toEqual(['start:first'])
    release()
    await installer.drain()
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second'])
  })

  it('does not let one failure wedge the queue', async () => {
    const run = vi.fn<RunCommand>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ code: 0, log: [] })
    const sink = collector()
    const installer = new Installer(
      { profileDir: scratch(), profileName: 'web', home: '/tmp/home', run },
      sink.onChange,
    )
    installer.install('a', '/checkouts/a')
    installer.install('b', '/checkouts/b')
    await installer.drain().catch(() => undefined)
    expect(run).toHaveBeenCalledTimes(2)
    expect(sink.states.filter(state => state.status === 'ok')).toHaveLength(1)
  })

  it('reads the configured launcher per operation', async () => {
    const run = stubRunner()
    let configured = '/bin/first'
    const installer = new Installer(
      { profileDir: scratch(), profileName: 'web', home: '/tmp/home', launcher: () => configured, run },
      () => undefined,
    )
    installer.install('a', '/checkouts/a')
    await installer.drain()
    configured = '/bin/second'
    installer.install('b', '/checkouts/b')
    await installer.drain()
    // The namespace carrying this applies live, so a corrected path must not
    // need a restart.
    expect(run.calls[0]?.[0]).toBe('/bin/first')
    expect(run.calls[1]?.[0]).toBe('/bin/second')
  })
})
