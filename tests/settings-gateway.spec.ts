/**
 * The settings gateway.
 *
 * This module exists because the harness's own settings wire is gated by a
 * hard-coded allowlist that no out-of-tree namespace can be in. It therefore
 * carries a boundary of its own, and that boundary is the thing most worth
 * pinning: a namespace is reachable ONLY when an installed bundle declares it.
 * `shell` and `agent-loop` are registered in the same process and must not be
 * reachable through here.
 */

import { describe, expect, it, vi } from 'vitest'
import { EMPTY_METADATA, type InstalledEntry, type SettingsPathOp } from '../src/contract.ts'
import {
  describeOwned, ownedNamespaces, readOps, toNamespaceView, writeOwned,
  SETTINGS_CONFLICT, type SettingsDescriptorLike, type SettingsSeam,
} from '../src/settings-gateway.ts'

/** One installed bundle, with only what the assertion cares about spelled out. */
function installed(name: string, settings: string[]): InstalledEntry {
  return { name, metadata: { ...EMPTY_METADATA, settings }, removable: true }
}

/** One descriptor as the seam would produce it. */
function descriptor(ns: string, overrides: Partial<SettingsDescriptorLike> = {}): SettingsDescriptorLike {
  return { ns, schema: { type: 'object' }, value: {}, revision: 0, applies: 'live', secrets: [], ...overrides }
}

/** A settings seam holding a fixed set of descriptors. */
function seam(descriptors: SettingsDescriptorLike[], mutate?: SettingsSeam['mutate']): SettingsSeam & {
  describeCalls: ({ redactSecrets?: boolean } | undefined)[]
} {
  const describeCalls: ({ redactSecrets?: boolean } | undefined)[] = []
  return {
    writable: true,
    documentPath: '/somewhere/settings.yaml',
    describeCalls,
    describe: (options) => {
      describeCalls.push(options)
      return descriptors
    },
    mutate: mutate ?? (() => Promise.resolve()),
  }
}

describe('ownedNamespaces', () => {
  it('unions what the installed bundles declare', () => {
    const owned = ownedNamespaces([
      installed('@x/omdsh-a', ['omdsh-a']),
      installed('@x/omdsh-b', ['omdsh-b', 'omdsh-b-extra']),
      installed('@deepseek-ai/dsh-base', ['dsh-base']),
    ])
    expect([...owned].sort()).toEqual(['dsh-base', 'omdsh-a', 'omdsh-b', 'omdsh-b-extra'])
  })

  it('is empty when nothing is installed', () => {
    expect(ownedNamespaces([]).size).toBe(0)
  })
})

describe('describeOwned', () => {
  it('carries only the namespaces an installed plugin claims', () => {
    const settings = seam([descriptor('omdsh-a'), descriptor('shell'), descriptor('agent-loop')])
    const document = describeOwned(settings, ownedNamespaces([installed('@x/omdsh-a', ['omdsh-a'])]))
    // `shell` is registered in this process and belongs to the harness; this
    // route is narrower than the one it stands in for.
    expect(document.namespaces.map(view => view.ns)).toEqual(['omdsh-a'])
  })

  it('always asks the seam to redact', () => {
    const settings = seam([descriptor('omdsh-a')])
    describeOwned(settings, new Set(['omdsh-a']))
    // The one thing keeping secrets off this wire; nothing downstream could
    // put them back.
    expect(settings.describeCalls).toEqual([{ redactSecrets: true }])
  })

  it('reports that a document exists without saying where', () => {
    const document = describeOwned(seam([]), new Set())
    expect(document.hasDocument).toBe(true)
    // A Host path on the wire is a Host path an attacker learns.
    expect(JSON.stringify(document)).not.toContain('/somewhere')
  })

  it('reports a read-only provider so the panel disables every control', () => {
    const settings = { ...seam([descriptor('omdsh-a')]), writable: false }
    expect(describeOwned(settings, new Set(['omdsh-a'])).writable).toBe(false)
  })
})

describe('toNamespaceView', () => {
  it('carries the layers a form needs and omits the ones the seam did not send', () => {
    const view = toNamespaceView(descriptor('omdsh-a', {
      base: { a: 1 },
      user: { a: 2 },
      applies: 'restart',
      revision: 7,
      secrets: [{ path: ['token'], set: true }],
    }))
    expect(view).toEqual({
      ns: 'omdsh-a',
      schema: { type: 'object' },
      value: {},
      base: { a: 1 },
      user: { a: 2 },
      applies: 'restart',
      secrets: [{ path: ['token'], set: true }],
      revision: 7,
    })
    expect(toNamespaceView(descriptor('omdsh-a'))).not.toHaveProperty('base')
    expect(toNamespaceView(descriptor('omdsh-a'))).not.toHaveProperty('user')
  })

  it('reports no secrets rather than crashing on an unredacted descriptor', () => {
    const bare = { ...descriptor('omdsh-a') }
    delete (bare as { secrets?: unknown }).secrets
    expect(toNamespaceView(bare).secrets).toEqual([])
  })
})

describe('readOps', () => {
  it('reads the two op shapes', () => {
    expect(readOps([{ op: 'set', path: ['a', 'b'], value: 1 }, { op: 'unset', path: ['c'] }]))
      .toEqual([{ op: 'set', path: ['a', 'b'], value: 1 }, { op: 'unset', path: ['c'] }])
  })

  it('refuses anything that is not a list of ops', () => {
    expect(readOps(undefined)).toBeUndefined()
    expect(readOps([])).toBeUndefined()
    expect(readOps('set')).toBeUndefined()
    expect(readOps([{ op: 'delete', path: ['a'] }])).toBeUndefined()
    expect(readOps([{ op: 'set', path: 'a', value: 1 }])).toBeUndefined()
    expect(readOps([{ op: 'set', path: [1], value: 1 }])).toBeUndefined()
  })

  it('keeps an explicit undefined value, which is a legitimate write', () => {
    expect(readOps([{ op: 'set', path: ['a'], value: undefined }]))
      .toEqual([{ op: 'set', path: ['a'], value: undefined }])
  })
})

describe('writeOwned', () => {
  const ops: SettingsPathOp[] = [{ op: 'set', path: ['a'], value: 1 }]

  it('refuses a namespace no installed plugin claims, before touching the seam', async () => {
    const mutate = vi.fn(() => Promise.resolve())
    const settings = seam([descriptor('shell')], mutate)
    expect(await writeOwned(settings, new Set(['omdsh-a']), { ns: 'shell', ops })).toEqual({ status: 'not-owned' })
    // Checked first, so an unowned namespace is refused rather than written
    // and then reported.
    expect(mutate).not.toHaveBeenCalled()
  })

  it('passes the revision through to the seam', async () => {
    const mutate = vi.fn(() => Promise.resolve())
    const settings = seam([descriptor('omdsh-a')], mutate)
    await writeOwned(settings, new Set(['omdsh-a']), { ns: 'omdsh-a', ops, expectedRevision: 3 })
    expect(mutate).toHaveBeenCalledWith('omdsh-a', ops, 3)
  })

  it('answers with the namespace\'s new redacted view', async () => {
    const settings = seam([descriptor('omdsh-a', { revision: 4 })])
    const result = await writeOwned(settings, new Set(['omdsh-a']), { ns: 'omdsh-a', ops })
    expect(result).toEqual({ status: 'ok', namespace: expect.objectContaining({ ns: 'omdsh-a', revision: 4 }) })
  })

  it('distinguishes a stale revision from a rejection', async () => {
    const conflict = Object.assign(new Error('changed since it was read'), { code: SETTINGS_CONFLICT })
    const settings = seam([descriptor('omdsh-a')], () => Promise.reject(conflict))
    // The caller recovers from one by re-reading and from the other by
    // telling somebody; collapsing them would lose that.
    expect(await writeOwned(settings, new Set(['omdsh-a']), { ns: 'omdsh-a', ops }))
      .toEqual({ status: 'conflict', message: 'changed since it was read' })
  })

  it('carries the seam\'s own words on a rejection', async () => {
    const settings = seam([descriptor('omdsh-a')], () => Promise.reject(new Error('expected boolean but got 3')))
    expect(await writeOwned(settings, new Set(['omdsh-a']), { ns: 'omdsh-a', ops }))
      .toEqual({ status: 'rejected', message: 'expected boolean but got 3' })
  })

  it('reports a registrant that went away mid-write rather than inventing a value', async () => {
    const settings = seam([])
    expect(await writeOwned(settings, new Set(['omdsh-a']), { ns: 'omdsh-a', ops }))
      .toEqual({ status: 'rejected', message: expect.stringContaining('no longer registered') })
  })
})
