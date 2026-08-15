/**
 * Whether a plugin is behind what its source offers.
 *
 * The property being defended is narrow and unforgiving: the Update button
 * lights up from this and from nothing else, so a wrong `available` promises a
 * fetch that changes nothing, and a wrong `current` hides a release. Both
 * mistakes are ones plain string comparison makes on ordinary version numbers.
 */

import { describe, expect, it } from 'vitest'
import { compareVersions, isLinkedSpec, parseVersion, updateStateFor } from '../src/version.ts'

describe('parseVersion', () => {
  it('reads the three parts and any prerelease', () => {
    expect(parseVersion('1.2.3')).toEqual({ core: [1, 2, 3], pre: [] })
    expect(parseVersion('0.1.0-rc.6')).toEqual({ core: [0, 1, 0], pre: ['rc', '6'] })
  })

  it('accepts a tag spelling, because a tag and a manifest name one release', () => {
    expect(parseVersion('v2.0.0')).toEqual({ core: [2, 0, 0], pre: [] })
  })

  it('drops build metadata, which semver excludes from the ordering', () => {
    expect(parseVersion('1.0.0+build.5')).toEqual({ core: [1, 0, 0], pre: [] })
  })

  it('refuses what is not a version rather than guessing at one', () => {
    for (const text of ['latest', '2024.03', '1.2', '', 'v', '1.2.3.4']) {
      expect(parseVersion(text), text).toBeUndefined()
    }
  })
})

describe('compareVersions', () => {
  it('orders the parts numerically, which is where string comparison fails', () => {
    // `'0.10.0' < '0.9.0'` as strings, and that inversion is exactly the bug
    // this function exists to not have.
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.0.0', '0.999.999')).toBe(1)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('ranks a release above its own prereleases', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
  })

  it('orders prerelease identifiers the way semver does', () => {
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    // A numeric identifier ranks below an alphanumeric one.
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    // Everything shared matched, so the longer list is the larger prerelease.
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc')).toBe(1)
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0)
  })

  it('has no answer when either side is not a version', () => {
    expect(compareVersions('latest', '1.0.0')).toBeUndefined()
    expect(compareVersions('1.0.0', 'nightly')).toBeUndefined()
  })
})

describe('isLinkedSpec', () => {
  it('recognizes what `dsh plugin add <path>` records', () => {
    expect(isLinkedSpec('link:/Users/someone/checkouts/omdsh-a')).toBe(true)
    expect(isLinkedSpec('file:../omdsh-a')).toBe(true)
  })

  it('leaves every fetched specifier alone', () => {
    expect(isLinkedSpec('^0.1.0')).toBe(false)
    expect(isLinkedSpec('github:owner/repo')).toBe(false)
    expect(isLinkedSpec(undefined)).toBe(false)
  })
})

describe('updateStateFor', () => {
  it('offers an update when the source is ahead', () => {
    expect(updateStateFor('0.2.0', '0.1.0', '^0.1.0')).toBe('available')
  })

  it('says current when the two agree', () => {
    expect(updateStateFor('0.1.0', '0.1.0', '^0.1.0')).toBe('current')
  })

  it('says current when the profile is ahead of the source', () => {
    // A prerelease installed by hand over a published release. There is
    // nothing to fetch, and offering to move BACKWARDS is not an update.
    expect(updateStateFor('0.1.0', '0.2.0-rc.1', '^0.1.0')).toBe('current')
  })

  it('calls a checkout install linked rather than current', () => {
    expect(updateStateFor('0.1.0', '0.1.0', 'link:/checkouts/omdsh-a')).toBe('linked')
  })

  it('still offers a real newer release to a linked install', () => {
    // The order matters: somebody with a checkout AND a newer published
    // release is being told something true, not being told about their link.
    expect(updateStateFor('0.3.0', '0.1.0', 'link:/checkouts/omdsh-a')).toBe('available')
  })

  it('admits it does not know rather than picking a side', () => {
    expect(updateStateFor(undefined, '0.1.0', '^0.1.0')).toBe('unknown')
    expect(updateStateFor('0.2.0', undefined, '^0.1.0')).toBe('unknown')
    expect(updateStateFor('nightly', '0.1.0', '^0.1.0')).toBe('unknown')
  })
})
