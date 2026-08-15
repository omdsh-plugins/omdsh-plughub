/**
 * Finding pnpm.
 *
 * The failure this module exists to stop is a specific one: a packaged desktop
 * application reports `dsh: pnpm not found on PATH` on a machine that plainly
 * has pnpm, because a GUI-launched process inherits `/usr/bin:/bin` and
 * nothing more. The property under test is therefore the ORDER — a working
 * PATH is never second-guessed, a deliberately shipped pnpm beats a guess, and
 * the guesses come last.
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { resolvePnpmDir, wellKnownPnpmDirs, type PnpmSearch } from '../src/pnpm.ts'

/** A search over a fixed set of existing paths. */
function search(present: readonly string[], overrides: Partial<PnpmSearch> = {}): PnpmSearch {
  const set = new Set(present)
  return {
    platform: 'darwin',
    home: '/Users/someone',
    env: {},
    exists: path => set.has(path),
    ...overrides,
  }
}

/** The layout a packaged desktop application ships. */
const APP = '/Applications/DeepSeek Harness.app/Contents/Resources/backend'
const APP_ENTRY = join(APP, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const APP_BIN = join(APP, 'node_modules', '.bin')

describe('resolvePnpmDir', () => {
  it('says nothing when the inherited PATH already resolves pnpm', () => {
    // A working setup is left exactly as it is: no reordering, and no opinion
    // about which pnpm it meant.
    expect(resolvePnpmDir(search(['/opt/homebrew/bin/pnpm'], {
      path: '/usr/bin:/opt/homebrew/bin',
    }))).toBeUndefined()
  })

  it('finds the pnpm a desktop application bundled into its runtime closure', () => {
    // The branch the bundling exists for: PATH is what launchd gave us, and
    // the answer is inside the .app.
    expect(resolvePnpmDir(search([join(APP_BIN, 'pnpm')], {
      path: '/usr/bin:/bin:/usr/sbin:/sbin',
      launcherEntry: APP_ENTRY,
      profileDir: '/Users/someone/.dsh/profiles/web',
    }))).toBe(APP_BIN)
  })

  it('finds one installed beside the launcher', () => {
    const bin = join('/opt/homebrew/lib', 'node_modules', '.bin')
    expect(resolvePnpmDir(search([join(bin, 'pnpm')], {
      path: '/usr/bin',
      launcherEntry: '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    }))).toBe(bin)
  })

  it('finds one in the profile when the launcher tree has none', () => {
    const bin = join('/Users/someone/.dsh/profiles/web', 'node_modules', '.bin')
    expect(resolvePnpmDir(search([join(bin, 'pnpm')], {
      path: '/usr/bin',
      launcherEntry: APP_ENTRY,
      profileDir: '/Users/someone/.dsh/profiles/web',
    }))).toBe(bin)
  })

  it('falls back to where pnpm\'s own installers put it', () => {
    // Guesses, and last for that reason — but they rescue an application
    // built before its closure carried one.
    expect(resolvePnpmDir(search(['/Users/someone/Library/pnpm/pnpm'], {
      path: '/usr/bin:/bin',
    }))).toBe('/Users/someone/Library/pnpm')
    expect(resolvePnpmDir(search(['/opt/homebrew/bin/pnpm'], {
      path: '/usr/bin:/bin',
    }))).toBe('/opt/homebrew/bin')
  })

  it('prefers a shipped pnpm over a guessed one', () => {
    expect(resolvePnpmDir(search([join(APP_BIN, 'pnpm'), '/opt/homebrew/bin/pnpm'], {
      path: '/usr/bin',
      launcherEntry: APP_ENTRY,
    }))).toBe(APP_BIN)
  })

  it('takes a configured path without checking it', () => {
    // Unchecked on purpose: a wrong configured path must fail loudly at the
    // spawn, not be silently replaced by a guess.
    expect(resolvePnpmDir(search([], { configured: '/somewhere/else/pnpm' })))
      .toBe('/somewhere/else')
  })

  it('reports nothing found rather than inventing a directory', () => {
    expect(resolvePnpmDir(search([], { path: '/usr/bin' }))).toBeUndefined()
  })

  it('looks for the Windows spellings on Windows', () => {
    const bin = join('C:\\app', 'node_modules', '.bin')
    expect(resolvePnpmDir(search([join(bin, 'pnpm.cmd')], {
      platform: 'win32',
      path: 'C:\\Windows',
      launcherEntry: join('C:\\app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    }))).toBe(bin)
    // The bare name is not an executable there, so it must not count.
    expect(resolvePnpmDir(search([join(bin, 'pnpm')], {
      platform: 'win32',
      path: 'C:\\Windows',
      launcherEntry: join('C:\\app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    }))).toBeUndefined()
  })
})

describe('wellKnownPnpmDirs', () => {
  it('puts an exported PNPM_HOME first, because somebody said it', () => {
    expect(wellKnownPnpmDirs('darwin', '/Users/someone', { PNPM_HOME: '/custom/pnpm' })[0])
      .toBe('/custom/pnpm')
  })

  it('names each platform\'s installer default', () => {
    expect(wellKnownPnpmDirs('darwin', '/h', {})).toContain('/h/Library/pnpm')
    expect(wellKnownPnpmDirs('linux', '/h', {})).toContain(join('/h', '.local', 'share', 'pnpm'))
    expect(wellKnownPnpmDirs('win32', '/h', {})).toContain(join('/h', 'AppData', 'Local', 'pnpm'))
  })
})
