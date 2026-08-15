/**
 * The browser half's two data sources, and the text resolver both regions use.
 *
 * Every harness import in this file is type-only, so it runs under the
 * committed registry pin without a linked checkout.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CatalogEntry, OperationState, PlughubEvent, SettingsNamespaceView,
} from '../src/contract.ts'
import { EMPTY_METADATA, SETTINGS_PATH, UPDATE_PATH } from '../src/contract.ts'
import { applyEvent, operationFor, parseEvent, requestUpdate } from '../src/client/hub-source.ts'
import {
  EMPTY_SETTINGS, describeSettings, isSecretSet, mutateSetting, namespacesFor,
  type SettingsSnapshot,
} from '../src/client/settings-source.ts'
import { resolveText, resolveTextOr, resolveTitle, shortName } from '../src/client/text.ts'
import { versionLabel } from '../src/version.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** Stand in for the Host, answering one status and body. */
function serving(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const impl = vi.fn(async (_input: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  }))
  vi.stubGlobal('fetch', impl)
  return impl
}

/** One operation row. */
function operation(overrides: Partial<OperationState> = {}): OperationState {
  return { id: 1, kind: 'install', name: '@x/omdsh-a', status: 'running', log: [], ...overrides }
}

/** One namespace view. */
function view(overrides: Partial<SettingsNamespaceView> = {}): SettingsNamespaceView {
  return {
    ns: 'omdsh-a',
    schema: { type: 'object' },
    value: {},
    applies: 'live',
    secrets: [],
    revision: 0,
    ...overrides,
  } as SettingsNamespaceView
}

describe('resolveText', () => {
  it('prefers the active locale, then the default, then English', () => {
    const text = { '': 'Default', en: 'English', zh: '中文' }
    expect(resolveText(text, 'zh')).toBe('中文')
    expect(resolveText(text, 'fr')).toBe('Default')
    expect(resolveText({ en: 'English', zh: '中文' }, 'fr')).toBe('English')
  })

  it('takes any entry over none', () => {
    // A missing translation must degrade to SOME text: the plugin's name in
    // the wrong language says more than a blank card title.
    expect(resolveText({ fr: 'Bonjour' }, 'zh')).toBe('Bonjour')
  })

  it('reads a bare string, and nothing usable as undefined', () => {
    expect(resolveText('plain', 'zh')).toBe('plain')
    expect(resolveText('', 'zh')).toBeUndefined()
    expect(resolveText({}, 'zh')).toBeUndefined()
    expect(resolveText(undefined, 'zh')).toBeUndefined()
  })

  it('falls back to the caller\'s literal', () => {
    expect(resolveTextOr(undefined, 'zh', 'fallback')).toBe('fallback')
  })
})

describe('shortName', () => {
  it('drops the scope and the repeated prefix', () => {
    expect(shortName('@omdsh-plugins/omdsh-shortcuts')).toBe('shortcuts')
    expect(shortName('omdsh-plughub')).toBe('plughub')
    expect(shortName('something-else')).toBe('something-else')
  })
})

describe('resolveTitle', () => {
  it('renders a declared title in the case its author wrote', () => {
    // A title is a name somebody reads, not a command they type — folding
    // `Remote Control` to `remote control` makes a feature look like one.
    expect(resolveTitle({ '': 'Remote Control' }, 'en', '@x/omdsh-remctrl')).toBe('Remote Control')
    expect(resolveTitle('Plugin Hub', 'en', '@x/omdsh-plughub')).toBe('Plugin Hub')
  })

  it('falls back to the shortened package name when nothing was declared', () => {
    // Not a title anybody wrote — an identifier, rendered as npm spells it.
    expect(resolveTitle(undefined, 'en', '@omdsh-plugins/omdsh-sidechat')).toBe('sidechat')
    expect(resolveTitle(undefined, 'en', '@deepseek-ai/dsh-web-app')).toBe('dsh-web-app')
  })

  it('answers in the locale the reader is in', () => {
    expect(resolveTitle({ '': 'Remote Control', zh: '远程控制' }, 'zh', '@x/omdsh-remctrl')).toBe('远程控制')
  })

  it('reads the same for every reader', () => {
    // Nothing case-folds any more, so no locale's casing rules — the Turkish
    // dotted I, say — can render one reader's title differently from another's.
    expect(resolveTitle({ '': 'Installer' }, 'tr', '@x/omdsh-a')).toBe('Installer')
    expect(resolveTitle({ '': 'Installer' }, 'en', '@x/omdsh-a')).toBe('Installer')
  })
})

describe('parseEvent', () => {
  it('reads the two events this client knows', () => {
    expect(parseEvent('{"kind":"snapshot","operations":[],"restartRequired":false}')?.kind).toBe('snapshot')
    expect(parseEvent('{"kind":"operation","operation":{},"restartRequired":true}')?.kind).toBe('operation')
  })

  it('ignores anything else on the stream', () => {
    expect(parseEvent('not json')).toBeUndefined()
    expect(parseEvent('{"kind":"heartbeat"}')).toBeUndefined()
    expect(parseEvent('null')).toBeUndefined()
  })
})

describe('applyEvent', () => {
  it('replaces the whole list on a snapshot', () => {
    // What makes a reconnect self-healing: the Host's list wins outright.
    const event: PlughubEvent = { kind: 'snapshot', operations: [operation({ id: 7 })], restartRequired: false }
    expect(applyEvent([operation({ id: 1 })], event).map(row => row.id)).toEqual([7])
  })

  it('replaces a known row and appends an unknown one', () => {
    const settled = operation({ status: 'ok' })
    const updated = applyEvent([operation()], { kind: 'operation', operation: settled, restartRequired: false })
    expect(updated).toEqual([settled])

    const appended = applyEvent([], { kind: 'operation', operation: operation({ id: 3 }), restartRequired: false })
    expect(appended.map(row => row.id)).toEqual([3])
  })
})

describe('operationFor', () => {
  it('answers with the latest operation naming a package', () => {
    // A package can be installed, removed, and installed again in one
    // session; only the last of those describes where it stands.
    const rows = [
      operation({ id: 1, kind: 'install', status: 'ok' }),
      operation({ id: 2, kind: 'uninstall', status: 'running' }),
    ]
    expect(operationFor(rows, '@x/omdsh-a')?.id).toBe(2)
    expect(operationFor(rows, '@x/other')).toBeUndefined()
  })
})

describe('namespacesFor', () => {
  it('keeps only the declared namespaces the Host actually registered', () => {
    const snapshot: SettingsSnapshot = {
      writable: true,
      hasDocument: true,
      namespaces: new Map([['omdsh-a', view({ ns: 'omdsh-a' })]]),
    }
    // A declaration is what a package MEANS to own; a namespace appears only
    // once its owner has mounted and registered it.
    expect(namespacesFor(['omdsh-a', 'omdsh-never-mounted'], snapshot).map(row => row.ns)).toEqual(['omdsh-a'])
    expect(namespacesFor([], snapshot)).toEqual([])
    expect(namespacesFor(['omdsh-a'], EMPTY_SETTINGS)).toEqual([])
  })
})

describe('isSecretSet', () => {
  it('reports whether a redacted slot holds a value', () => {
    const withSecret = view({
      secrets: [{ path: ['githubToken'], set: true }, { path: ['other'], set: false }],
    })
    expect(isSecretSet(withSecret, ['githubToken'])).toBe(true)
    expect(isSecretSet(withSecret, ['other'])).toBe(false)
    expect(isSecretSet(withSecret, ['absent'])).toBe(false)
  })
})

describe('describeSettings', () => {
  it('keys the namespaces the Host owns by name', async () => {
    serving(200, { writable: true, hasDocument: true, namespaces: [view({ ns: 'omdsh-a' })] })
    const snapshot = await describeSettings()
    expect(snapshot.writable).toBe(true)
    expect(snapshot.namespaces.get('omdsh-a')?.ns).toBe('omdsh-a')
  })

  it('surfaces a refusal rather than reading it as "nothing to configure"', async () => {
    serving(503, { error: 'this deployment composes no settings provider' })
    await expect(describeSettings()).rejects.toThrow(/no settings provider/)
  })
})

describe('mutateSetting', () => {
  it('carries the revision so a stale editor is refused', async () => {
    const fetchImpl = serving(200, { namespace: view() })
    await mutateSetting('omdsh-a', [{ op: 'set', path: ['x'], value: 1 }], 4)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(SETTINGS_PATH)
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      ns: 'omdsh-a',
      ops: [{ op: 'set', path: ['x'], value: 1 }],
      expectedRevision: 4,
    })
  })

  it('omits the revision when the caller has not read one', async () => {
    const fetchImpl = serving(200, { namespace: view() })
    await mutateSetting('omdsh-a', [{ op: 'unset', path: ['x'] }])
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      ns: 'omdsh-a',
      ops: [{ op: 'unset', path: ['x'] }],
    })
  })

  it('reports a conflict as recoverable', async () => {
    serving(409, { error: 'settings namespace "omdsh-a" changed since it was read' })
    // Distinct from a failure because the caller resolves it by re-reading
    // rather than by telling somebody.
    expect(await mutateSetting('omdsh-a', [])).toEqual({ status: 'conflict' })
  })

  it('reports every other refusal with the Host\'s own words', async () => {
    serving(400, { error: 'expected boolean but got 3' })
    expect(await mutateSetting('omdsh-a', [])).toEqual({
      status: 'failed',
      message: 'expected boolean but got 3',
    })
  })

  it('contains a transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    expect(await mutateSetting('omdsh-a', [])).toEqual({ status: 'failed', message: 'offline' })
  })

  it('adopts the new view the Host answers with', async () => {
    const next = view({ revision: 5 })
    serving(200, { namespace: next })
    expect(await mutateSetting('omdsh-a', [])).toEqual({ status: 'ok', view: next })
  })
})

describe('requestUpdate', () => {
  it('names the package and never the version it is showing', async () => {
    const fetchImpl = serving(202, { operation: operation({ kind: 'update' }) })
    await requestUpdate('@x/omdsh-a')
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(UPDATE_PATH)
    // The version on screen is a fact this page READ. Sending it back would
    // let a stale tab pin the install to something no longer on offer, so the
    // Host re-resolves instead.
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string))
      .toEqual({ name: '@x/omdsh-a' })
  })
})

describe('versionLabel', () => {
  /** One catalog entry, with only what the assertion cares about spelled out. */
  const entry = (overrides: Partial<CatalogEntry>): CatalogEntry => ({
    name: '@x/omdsh-a',
    source: 'registry',
    metadata: EMPTY_METADATA,
    installed: true,
    ...overrides,
  })

  it('shows both versions when one is going to replace the other', () => {
    // A lone version leaves a person to work out which of the two it is.
    expect(versionLabel(entry({ version: '0.2.0', installedVersion: '0.1.0', update: 'available' })))
      .toBe('0.1.0 → 0.2.0')
  })

  it('shows one version when there is nothing to move to', () => {
    expect(versionLabel(entry({ version: '0.1.0', installedVersion: '0.1.0', update: 'current' })))
      .toBe('0.1.0')
    expect(versionLabel(entry({ installed: false, version: '0.1.0' }))).toBe('0.1.0')
  })

  it('falls back to what the profile has when the source names no version', () => {
    expect(versionLabel(entry({ installedVersion: '0.1.0', update: 'unknown' }))).toBe('0.1.0')
    expect(versionLabel(entry({}))).toBeUndefined()
  })
})
