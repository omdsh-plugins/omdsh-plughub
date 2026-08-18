/**
 * The facts a composition depends on that nothing else would catch.
 *
 * A route path, a slot id, a tab order, an inject list: each is a string that
 * agrees with something outside this package — the browser half's fetch, the
 * harness's Plugins section, another tab's position. Changing one silently
 * still compiles and still passes every behavioural spec; it just stops
 * working. So they are pinned here, where a change has to be deliberate.
 */

import { describe, expect, it } from 'vitest'
import {
  CATALOG_PATH, ENABLED_PATH, EVENTS_PATH, HUB_SETTINGS_NAMESPACE, INSTALL_PATH, INSTALLED_PATH,
  REQUIRED_PACKAGE_NAMES, ROUTE_PREFIX, SETTINGS_PATH, SOURCE_PRECEDENCE, UNINSTALL_PATH, UPDATE_PATH,
} from '../src/contract.ts'
import { Config, SETTINGS_NAMESPACE, inject, name } from '../src/index.ts'
import { NS, PLUGIN_CARD_SLOT, TAB_ID, TAB_ORDER, TAB_SLOT } from '../src/client/slot-contract.ts'

describe('host plugin', () => {
  it('keeps its cordis identity and the one service it needs', () => {
    expect(name).toBe('omdsh-plughub')
    // `webServer` is composed by the base bundle; `settings` is injected in a
    // scoped fiber instead, so a composition without one still mounts.
    expect(inject).toEqual(['webServer'])
  })

  it('owns the namespace its own package.json declares', () => {
    // The convention this plugin asks of everyone else, applied to itself.
    expect(SETTINGS_NAMESPACE).toBe('omdsh-plughub')
    // Both halves need the name: the Host registers under it, and the browser
    // hoists that one namespace out of the installed list into the catalog
    // region. So it lives in the contract, and this is the two agreeing.
    expect(SETTINGS_NAMESPACE).toBe(HUB_SETTINGS_NAMESPACE)
  })
})

describe('routes', () => {
  it('all sit under one prefix', () => {
    const paths = [
      CATALOG_PATH, INSTALLED_PATH, INSTALL_PATH, UPDATE_PATH, UNINSTALL_PATH, ENABLED_PATH,
      EVENTS_PATH, SETTINGS_PATH,
    ]
    for (const path of paths) {
      expect(path.startsWith(`${ROUTE_PREFIX}/`)).toBe(true)
    }
  })

  it('are the paths the browser half fetches', () => {
    expect(CATALOG_PATH).toBe('/api/plughub/catalog')
    expect(INSTALLED_PATH).toBe('/api/plughub/installed')
    expect(INSTALL_PATH).toBe('/api/plughub/install')
    expect(UPDATE_PATH).toBe('/api/plughub/update')
    expect(UNINSTALL_PATH).toBe('/api/plughub/uninstall')
    expect(ENABLED_PATH).toBe('/api/plughub/enabled')
    expect(EVENTS_PATH).toBe('/api/plughub/events')
    expect(SETTINGS_PATH).toBe('/api/plughub/settings')
  })
})

describe('required plugins', () => {
  it('names the hub and the mode system as the plugins that stay on', () => {
    expect(REQUIRED_PACKAGE_NAMES).toEqual([
      '@omdsh-plugins/omdsh-plughub',
      '@omdsh-plugins/omdsh-basemode',
    ])
  })
})

describe('catalog precedence', () => {
  it('puts the copy you can edit above the copy somebody published', () => {
    expect(SOURCE_PRECEDENCE).toEqual(['local', 'registry', 'github'])
  })
})

/** One node of a serialized schema envelope. */
interface SerializedNode {
  type?: string
  meta?: { description?: unknown; role?: string }
  dict?: Record<string, number>
}

/**
 * The root object's properties, dereferenced.
 *
 * `toJSON()` emits a `{ uid, refs }` envelope in which every nested node is a
 * uid pointing into `refs` — the representation that lets a recursive schema
 * serialize at all. `rehydrateSchema` rebuilds the real node tree from it in
 * the browser; this walk is the one place a spec has to do it by hand.
 * @returns the root object's property nodes, by name.
 */
function properties(): Record<string, SerializedNode> {
  const envelope = JSON.parse(JSON.stringify(Config.toJSON())) as {
    uid: number
    refs: Record<string, SerializedNode>
  }
  const root = envelope.refs[String(envelope.uid)]
  return Object.fromEntries(
    Object.entries(root?.dict ?? {}).map(([key, uid]) => [key, envelope.refs[String(uid)] ?? {}]),
  )
}

describe('Config', () => {
  it('resolves an empty entry to the shipped defaults', () => {
    const resolved = Config({})
    expect(resolved.upstream).toBe('')
    expect(resolved.localSources).toEqual([])
    expect(resolved.registryUrl).toBe('https://cdn.jsdmirror.com/gh/omdsh-plugins/registry/registry.json')
    expect(resolved.maxRepos).toBe(100)
    // A default of `''` would make the harness report the secret as stored.
    expect(resolved.githubToken).toBeUndefined()
  })

  it('describes every field, so the panel needs no dictionary for them', () => {
    // The whole convention: a plugin's field labels come from its schema.
    // Every description is localized, so both dictionaries are covered too.
    for (const [key, node] of Object.entries(properties())) {
      const description = node.meta?.description
      expect(description, `${key} has no description`).toBeDefined()
      expect(typeof description === 'object' && description !== null && 'zh' in description, `${key} has no zh`)
        .toBe(true)
    }
  })

  it('marks the token a secret so the wire redacts it', () => {
    expect(properties()['githubToken']?.meta?.role).toBe('secret')
  })

  it('refuses a value its own panel would not offer', () => {
    expect(() => Config({ maxRepos: 0 })).toThrow()
    expect(() => Config({ timeoutMs: 1 })).toThrow()
  })
})

describe('browser seats', () => {
  it('takes a tab in the harness Plugins section rather than a nav row of its own', () => {
    // The harness declares this seat precisely so inventory and configuration
    // plugins collaborate without depending on one another.
    expect(TAB_SLOT).toBe('settings.plugins.tab')
    expect(TAB_ID).toBe('omdsh')
  })

  it('sits to the right of the shipped tabs', () => {
    // `configurable` is 0 and `all` is 10 in the harness composition.
    expect(TAB_ORDER).toBeGreaterThan(10)
  })

  it('declares its own card slot rather than reusing the harness one', () => {
    // `settings.plugin.item` is declared by the Configurable tab and exists
    // only while that tab is mounted; a card registered there appears there.
    expect(PLUGIN_CARD_SLOT).toBe('omdsh.plugin.card')
  })

  it('owns one locale namespace', () => {
    expect(NS).toBe('settings.plughub')
  })
})
