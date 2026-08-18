/**
 * The terminal front door.
 *
 * Two properties carry this module. The first is that an argument's KIND is
 * decided without asking the network: a package name is looked up in the
 * catalog and a specifier is installed as written, and getting that boundary
 * wrong means either a name handed to pnpm or a specifier searched for in a
 * manifest that will never hold it. The second is that a short name resolves
 * only when it resolves to one thing — the whole point of accepting
 * `omdsh-status` is that it is unambiguous here, and the moment it is not, the
 * program has to say so rather than pick.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  classifyTarget, HELP, isEntryPoint, isUsageError, matchName, parseArgs, PROGRAM, run,
  type Output,
} from '../src/cli.ts'
import { DEFAULT_PROFILE, DEFAULT_REGISTRY_URL, DEFAULT_UPSTREAM } from '../src/defaults.ts'

/** An {@link Output} plus the two transcripts it wrote. */
function sink(): { io: Output; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: line => { out.push(line) }, err: line => { err.push(line) } }, out, err }
}

describe('parseArgs', () => {
  it('defaults the profile and the catalog sources when neither is named', () => {
    const parsed = parseArgs(['list'])
    expect(isUsageError(parsed)).toBe(false)
    if (isUsageError(parsed)) return
    expect(parsed.command).toBe('list')
    expect(parsed.options.profile).toBe(DEFAULT_PROFILE)
    expect(parsed.options.upstream).toBe(DEFAULT_UPSTREAM)
    expect(parsed.options.registryUrl).toBe(DEFAULT_REGISTRY_URL)
  })

  it('reads a flag as `--flag value` and as `--flag=value` alike', () => {
    for (const argv of [['list', '--profile', 'work'], ['list', '--profile=work']]) {
      const parsed = parseArgs(argv)
      if (isUsageError(parsed)) throw new Error(parsed.usage)
      expect(parsed.options.profile).toBe('work')
    }
  })

  it('collects every --local-source rather than keeping the last', () => {
    const parsed = parseArgs(['list', '--local-source', '/a', '--local-source', '/b'])
    if (isUsageError(parsed)) throw new Error(parsed.usage)
    expect(parsed.options.localSources).toEqual(['/a', '/b'])
  })

  it('keeps every target after the command', () => {
    const parsed = parseArgs(['add', 'omdsh-status', '@omdsh-plugins/omdsh-usage'])
    if (isUsageError(parsed)) throw new Error(parsed.usage)
    expect(parsed.targets).toEqual(['omdsh-status', '@omdsh-plugins/omdsh-usage'])
  })

  it('accepts an empty upstream and an empty registry URL, which mean something', () => {
    const parsed = parseArgs(['list', '--upstream=', '--registry-url='])
    if (isUsageError(parsed)) throw new Error(parsed.usage)
    expect(parsed.options.upstream).toBe('')
    expect(parsed.options.registryUrl).toBe('')
  })

  it('refuses an empty value for a flag where empty means nothing', () => {
    expect(parseArgs(['list', '--profile='])).toEqual({ usage: '--profile needs a value' })
  })

  it('refuses an unknown option, an unknown command, and a bare add', () => {
    expect(parseArgs(['list', '--nope'])).toEqual({ usage: 'unknown option --nope' })
    expect(parseArgs(['frobnicate'])).toEqual({ usage: 'unknown command "frobnicate"' })
    expect(parseArgs(['add'])).toEqual({ usage: 'add needs at least one plugin' })
    expect(parseArgs(['update'])).toEqual({ usage: 'update needs at least one plugin' })
    expect(parseArgs(['enable'])).toEqual({ usage: 'enable needs at least one plugin' })
    expect(parseArgs(['disable'])).toEqual({ usage: 'disable needs at least one plugin' })
  })

  it('takes enable and disable as commands of their own', () => {
    const enabled = parseArgs(['enable', 'omdsh-status'])
    if (isUsageError(enabled)) throw new Error(enabled.usage)
    expect(enabled.command).toBe('enable')
    expect(enabled.targets).toEqual(['omdsh-status'])
    const disabled = parseArgs(['disable', 'omdsh-status'])
    if (isUsageError(disabled)) throw new Error(disabled.usage)
    expect(disabled.command).toBe('disable')
  })

  it('takes update as a command of its own', () => {
    const parsed = parseArgs(['update', 'omdsh-status'])
    if (isUsageError(parsed)) throw new Error(parsed.usage)
    expect(parsed.command).toBe('update')
    expect(parsed.targets).toEqual(['omdsh-status'])
  })

  it('bounds the numeric flags rather than passing anything through', () => {
    expect(isUsageError(parseArgs(['list', '--max-repos', '0']))).toBe(true)
    expect(isUsageError(parseArgs(['list', '--max-repos', '501']))).toBe(true)
    expect(isUsageError(parseArgs(['list', '--timeout', '10']))).toBe(true)
    expect(isUsageError(parseArgs(['list', '--timeout', 'soon']))).toBe(true)
  })

  it('answers help for an empty command line, not a usage error', () => {
    const parsed = parseArgs([])
    if (isUsageError(parsed)) throw new Error(parsed.usage)
    expect(parsed.command).toBe('help')
  })
})

describe('classifyTarget', () => {
  it('reads a scoped package name as a name, not as a version range', () => {
    expect(classifyTarget('@omdsh-plugins/omdsh-status')).toEqual({ kind: 'name', name: '@omdsh-plugins/omdsh-status' })
  })

  it('reads a bare last segment as a name', () => {
    expect(classifyTarget('omdsh-status')).toEqual({ kind: 'name', name: 'omdsh-status' })
  })

  it('reads a pinned version as a specifier, scoped or not', () => {
    expect(classifyTarget('omdsh-status@0.1.2')).toEqual({ kind: 'spec', spec: 'omdsh-status@0.1.2' })
    expect(classifyTarget('@omdsh-plugins/omdsh-status@0.1.2'))
      .toEqual({ kind: 'spec', spec: '@omdsh-plugins/omdsh-status@0.1.2' })
  })

  it('reads a github specifier as a specifier — this is how one account is named', () => {
    expect(classifyTarget('github:someone/omdsh-status')).toEqual({ kind: 'spec', spec: 'github:someone/omdsh-status' })
  })

  it('admits an absolute path, which a route may not', () => {
    expect(classifyTarget('/checkouts/omdsh-status')).toEqual({ kind: 'spec', spec: '/checkouts/omdsh-status' })
  })

  it('refuses a specifier carrying whitespace or a leading dash', () => {
    expect(classifyTarget('github:owner/repo extra').kind).toBe('invalid')
    expect(classifyTarget('--registry=evil').kind).toBe('invalid')
  })

  it('refuses an empty argument', () => {
    expect(classifyTarget('').kind).toBe('invalid')
  })
})

describe('matchName', () => {
  const names = ['@omdsh-plugins/omdsh-status', '@omdsh-plugins/omdsh-usage']

  it('takes an exact package name', () => {
    expect(matchName('@omdsh-plugins/omdsh-status', names)).toEqual({ kind: 'one', name: '@omdsh-plugins/omdsh-status' })
  })

  it('takes a last segment when exactly one entry ends in it', () => {
    expect(matchName('omdsh-status', names)).toEqual({ kind: 'one', name: '@omdsh-plugins/omdsh-status' })
  })

  it('reports two accounts publishing the same segment rather than choosing', () => {
    const matched = matchName('omdsh-status', [...names, '@someone-else/omdsh-status'])
    expect(matched).toEqual({ kind: 'many', names: ['@omdsh-plugins/omdsh-status', '@someone-else/omdsh-status'] })
  })

  it('reports nothing when nothing matches', () => {
    expect(matchName('omdsh-nothing', names)).toEqual({ kind: 'none' })
  })
})

describe('run', () => {
  // A home of its own, so "no such profile" is a fact about this test and not
  // about whichever profiles the machine running it happens to have.
  let home: string
  const held = process.env['DSH_HOME']
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'plughub-cli-'))
    process.env['DSH_HOME'] = home
  })
  afterAll(() => {
    if (held === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = held
    rmSync(home, { recursive: true, force: true })
  })

  it('prints the help on --help and exits zero', async () => {
    const { io, out } = sink()
    expect(await run(['--help'], io)).toBe(0)
    expect(out.join('\n')).toBe(HELP)
  })

  it('exits 2 on a usage error and points at the help', async () => {
    const { io, err } = sink()
    expect(await run(['add'], io)).toBe(2)
    expect(err[0]).toBe(`${PROGRAM}: add needs at least one plugin`)
    expect(err[1]).toContain('--help')
  })

  it('stops at a profile that does not exist, before resolving anything', async () => {
    const { io, err } = sink()
    expect(await run(['add', 'omdsh-status'], io)).toBe(1)
    expect(err[0]).toContain('no profile named "web"')
    expect(err[1]).toContain('dsh --profile web')
  })
})

describe('isEntryPoint', () => {
  /**
   * The bug this guards: npm exposes a `bin` as a symlink under
   * `node_modules/.bin`, node puts THAT path in `argv[1]`, and comparing it to
   * `import.meta.url` as strings is false for every installed copy — so the
   * program starts, matches nothing, and exits silently with status 0. Found
   * by installing the packed tarball rather than by any unit test, which is
   * why the symlink is real here.
   */
  let dir: string
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'plughub-bin-')) })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  it('recognises the module through the symlink an installed bin is', () => {
    const real = join(dir, 'cli.js')
    const link = join(dir, 'omdsh-plughub')
    writeFileSync(real, '')
    symlinkSync(real, link)
    expect(isEntryPoint(link, pathToFileURL(real).href)).toBe(true)
  })

  it('recognises the module when it is named directly', () => {
    const real = join(dir, 'cli.js')
    expect(isEntryPoint(real, pathToFileURL(real).href)).toBe(true)
  })

  it('is false for another file, and for no entry at all', () => {
    const real = join(dir, 'cli.js')
    const other = join(dir, 'other.js')
    writeFileSync(other, '')
    expect(isEntryPoint(other, pathToFileURL(real).href)).toBe(false)
    expect(isEntryPoint(undefined, pathToFileURL(real).href)).toBe(false)
    expect(isEntryPoint(join(dir, 'missing.js'), pathToFileURL(real).href)).toBe(false)
  })
})
