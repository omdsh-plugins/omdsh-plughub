/**
 * Finding the profile.
 *
 * A wrong answer here is not a wrong read — it is `pnpm` writing somewhere it
 * should not — so most of what follows is about the cases that must be
 * REFUSED: a directory that is not a profile, and a profile that is not where
 * `dsh --profile <name>` would put it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isProfileDirectory, isRestartRequired, listInstalled, profileFromBaseUrl, profileFromDirectory,
  readProfileManifest, resolveHome, resolvePackageDir, resolveProfile, ProfileResolutionError,
} from '../src/profile.ts'

const temporaries: string[] = []

afterEach(() => {
  while (temporaries.length > 0) rmSync(temporaries.pop() as string, { recursive: true, force: true })
})

/** A scratch `$DSH_HOME` removed after the test. */
function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'plughub-home-'))
  temporaries.push(home)
  return home
}

/** Write a profile into `<home>/profiles/<name>`, with the given manifest. */
function makeProfile(home: string, name: string, manifest: object): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  return dir
}

/** Install a package into a profile's node_modules. */
function makePackage(profileDir: string, name: string, manifest: object): void {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}

describe('resolveHome', () => {
  it('prefers $DSH_HOME', () => {
    expect(resolveHome({ DSH_HOME: '/tmp/elsewhere' })).toBe(resolve('/tmp/elsewhere'))
  })

  it('treats a blank override as unset', () => {
    // A blank value must never resolve the home to the working directory.
    expect(resolveHome({ DSH_HOME: '   ' })).toBe(join(homedir(), '.dsh'))
    expect(resolveHome({})).toBe(join(homedir(), '.dsh'))
  })

  it('expands a tilde', () => {
    expect(resolveHome({ DSH_HOME: '~/elsewhere' })).toBe(resolve(join(homedir(), 'elsewhere')))
  })
})

describe('isProfileDirectory', () => {
  it('tests the declaration, not the contents', () => {
    const home = scratchHome()
    // A freshly initialized profile has an empty bundle list, and it is still
    // a profile.
    const empty = makeProfile(home, 'web', { dsh: { profile: {} } })
    expect(isProfileDirectory(empty)).toBe(true)
  })

  it('refuses a directory that merely holds a package.json', () => {
    const home = scratchHome()
    const dir = join(home, 'profiles', 'web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'not-a-profile' }))
    expect(isProfileDirectory(dir)).toBe(false)
    expect(isProfileDirectory(join(home, 'absent'))).toBe(false)
  })
})

describe('readProfileManifest', () => {
  it('reads the dependencies and the bundle list', () => {
    const home = scratchHome()
    const dir = makeProfile(home, 'web', {
      dependencies: { '@x/omdsh-a': 'link:/checkouts/omdsh-a', '@x/plain': '^1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@x/omdsh-a'] } },
    })
    const manifest = readProfileManifest(dir)
    expect(manifest.bundles).toEqual(['@deepseek-ai/dsh-base', '@x/omdsh-a'])
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@x/omdsh-a', '@x/plain'])
  })

  it('reads an absent or broken manifest as an empty profile', () => {
    expect(readProfileManifest(join(scratchHome(), 'absent')).bundles).toEqual([])
  })
})

describe('profileFromDirectory', () => {
  it('accepts a profile that sits where its name says', () => {
    const home = scratchHome()
    const dir = makeProfile(home, 'web', { dsh: { profile: { bundles: [] } } })
    expect(profileFromDirectory(dir, home)).toEqual({ dir, name: 'web' })
  })

  it('refuses a profile that does not round-trip through its name', () => {
    // `dsh plugin --profile <name>` resolves the name to `<home>/profiles/<name>`.
    // Handing it a name that resolves elsewhere would install into a
    // different profile than the one being displayed.
    const home = scratchHome()
    const elsewhere = mkdtempSync(join(tmpdir(), 'plughub-stray-'))
    temporaries.push(elsewhere)
    writeFileSync(join(elsewhere, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    expect(profileFromDirectory(elsewhere, home)).toBeUndefined()
  })
})

describe('profileFromBaseUrl', () => {
  it('reads the profile out of the include-rooted base url', () => {
    const home = scratchHome()
    const dir = makeProfile(home, 'web', { dsh: { profile: { bundles: [] } } })
    // What the root include sets: the directory of `<profileDir>/cordis.yml`.
    const baseUrl = new URL('.', pathToFileURL(join(dir, 'cordis.yml'))).href
    expect(profileFromBaseUrl(baseUrl, home)).toEqual({ dir, name: 'web' })
  })

  it('returns undefined for a base url that names no directory here', () => {
    const home = scratchHome()
    expect(profileFromBaseUrl(undefined, home)).toBeUndefined()
    expect(profileFromBaseUrl('', home)).toBeUndefined()
    // A packaged runtime serving its config over http is not a directory
    // this plugin can write.
    expect(profileFromBaseUrl('https://example.invalid/config/', home)).toBeUndefined()
  })
})

describe('resolveProfile', () => {
  it('prefers an explicitly configured directory', () => {
    const home = scratchHome()
    const dir = makeProfile(home, 'headless', { dsh: { profile: { bundles: [] } } })
    expect(resolveProfile({ configuredDir: dir, baseUrl: undefined, home })).toEqual({ dir, name: 'headless' })
  })

  it('names the reason when there is nothing to install into', () => {
    const home = scratchHome()
    expect(() => resolveProfile({ baseUrl: undefined, home })).toThrow(ProfileResolutionError)
    expect(() => resolveProfile({ configuredDir: join(home, 'nope'), home })).toThrow(/not a profile/)
  })
})

describe('resolvePackageDir', () => {
  it('finds a package in the profile, then in the flat fallback above it', () => {
    const home = scratchHome()
    const dir = makeProfile(home, 'web', { dsh: { profile: { bundles: [] } } })
    makePackage(dir, '@x/omdsh-a', { name: '@x/omdsh-a' })
    expect(resolvePackageDir(dir, '@x/omdsh-a')).toBe(join(dir, 'node_modules', '@x', 'omdsh-a'))

    // The launcher-maintained fallback at `$DSH_HOME/profiles/node_modules`
    // is what makes every in-box plugin resolvable from any profile.
    const fallback = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-base')
    mkdirSync(fallback, { recursive: true })
    writeFileSync(join(fallback, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base' }))
    expect(resolvePackageDir(dir, '@deepseek-ai/dsh-base')).toBe(fallback)
  })

  it('reports an unresolvable package as absent', () => {
    const home = scratchHome()
    const dir = makeProfile(home, 'web', { dsh: { profile: { bundles: [] } } })
    expect(resolvePackageDir(dir, '@x/nothing-here')).toBeUndefined()
  })
})

describe('listInstalled', () => {
  it('marks a dependency removable and a template bundle not', () => {
    const home = scratchHome()
    const dir = makeProfile(home, 'web', {
      dependencies: { '@x/omdsh-a': 'link:/checkouts/omdsh-a' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@x/omdsh-a'] } },
    })
    makePackage(dir, '@x/omdsh-a', {
      name: '@x/omdsh-a',
      version: '0.2.0',
      description: 'a plugin',
      dsh: { bundle: { patch: './p.yml' }, plughub: { displayName: 'A', settings: ['omdsh-a'] } },
    })

    const entries = listInstalled(dir, readProfileManifest(dir))
    expect(entries.map(entry => entry.name)).toEqual(['@deepseek-ai/dsh-base', '@x/omdsh-a'])
    // `dsh-base` came with the profile rather than as a dependency, so
    // `pnpm remove` has nothing to take out.
    expect(entries[0]?.removable).toBe(false)
    expect(entries[1]).toMatchObject({
      removable: true,
      version: '0.2.0',
      description: 'a plugin',
    })
    expect(entries[1]?.metadata.settings).toEqual(['omdsh-a'])
  })

  it('still lists a bundle whose package cannot be read', () => {
    const home = scratchHome()
    const dir = makeProfile(home, 'web', {
      dependencies: { '@x/omdsh-gone': '^1.0.0' },
      dsh: { profile: { bundles: ['@x/omdsh-gone'] } },
    })
    // A half-installed profile is exactly when a person needs to see the row
    // and press Remove.
    const entries = listInstalled(dir, readProfileManifest(dir))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.removable).toBe(true)
    expect(entries[0]?.version).toBeUndefined()
  })
})

describe('isRestartRequired', () => {
  it('is false while the profile still says what it said at boot', () => {
    expect(isRestartRequired(['a', 'b'], ['a', 'b'])).toBe(false)
    expect(isRestartRequired([], [])).toBe(false)
  })

  it('is true once the bundle list moves, in either direction', () => {
    expect(isRestartRequired(['a'], ['a', 'b'])).toBe(true)
    expect(isRestartRequired(['a', 'b'], ['a'])).toBe(true)
    // Order is composition order, and a reordered stack is a different tree.
    expect(isRestartRequired(['a', 'b'], ['b', 'a'])).toBe(true)
  })
})
