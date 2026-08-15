/**
 * `@omdsh-plugins/omdsh-plughub` — the browser half: one more tab in Settings →
 * Plugins, and everything behind it.
 *
 * ## Why a tab and not a section
 *
 * The harness already owns a Plugins settings section, and it declares
 * `settings.plugins.tab` precisely so that "inventory and configuration
 * plugins collaborate without depending on one another". Taking a whole nav
 * row instead would put this plugin beside Models and General as though it
 * were a peer of those, when what it actually is, is a third page of the
 * Plugins section — beside the shipped Configurable and All tabs.
 *
 * ## Where the configuration comes from
 *
 * Not from here. A plugin's fields are read from ITS settings schema and
 * written back to ITS namespace; this half contributes the rendering and
 * nothing else, which is what makes the panel work for a plugin published
 * after it. The schema arrives over this plugin's own host routes rather than
 * the harness's `settings.describe` — see `../settings-gateway.ts` for the
 * allowlist that forces that detour.
 *
 * It imposes nothing on a plugin's own words: a card title renders in the case
 * its author wrote (`resolveTitle`), and a plugin that declared none is titled
 * with its package name, exactly as npm spells it.
 *
 * ## Nothing is claimed on this plugin's own authority
 *
 * One tab seat, one locale namespace, one card slot of its own, and no
 * service. Unmounting removes all of it and the Plugins section goes back to
 * the two tabs it shipped with.
 * @module @omdsh-plugins/omdsh-plughub/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.plugins.tab'
// entry). Cross-plugin collaboration goes through services and slots, never a
// value import (purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PlughubEvent } from '../contract.ts'
import {
  fetchCatalog, fetchInstalled, followOperations, requestInstall, requestUninstall, requestUpdate,
} from './hub-source.ts'
import { describeSettings, mutateSetting } from './settings-source.ts'
import { en, zh, type PlughubLocaleKey } from './locales.ts'
import { OmdshPluginsTab, type OmdshPluginsTabInjected } from './OmdshPluginsTab.tsx'
import { NS, PLUGIN_CARD_SLOT, TAB_ID, TAB_ORDER, TAB_SLOT } from './slot-contract.ts'

export type { OmdshPluginsTabInjected, OmdshPluginsTabProps } from './OmdshPluginsTab.tsx'
export type { OmdshPluginCardOwnerProps } from './slot-contract.ts'
export { NS, PLUGIN_CARD_SLOT, TAB_ID, TAB_ORDER, TAB_SLOT } from './slot-contract.ts'
export type { PlughubLocaleKey } from './locales.ts'
export type { SettingsSnapshot, WriteOutcome } from './settings-source.ts'
export { namespacesFor, isSecretSet, describeSettings, mutateSetting } from './settings-source.ts'
export {
  applyEvent, operationFor, parseEvent, followOperations,
  fetchCatalog, fetchInstalled, requestInstall, requestUninstall, requestUpdate, HubError,
} from './hub-source.ts'
export { matches } from './CatalogSection.tsx'
export { compareVersions, isLinkedSpec, parseVersion, updateStateFor, versionLabel } from '../version.ts'
export { SourcesSection } from './SourcesSection.tsx'
export type { SourcesSectionProps } from './SourcesSection.tsx'
export { resolveText, resolveTextOr, resolveTitle, shortName } from './text.ts'
export { classify, planSection, isEditable, getPath, isOverridden } from './schema-form/plan.ts'
export type { FieldKind, FieldNode, GroupNode, PlanNode, SchemaNodeLike } from './schema-form/plan.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This panel's own chrome copy; everything about a plugin comes from that plugin. */
    'settings.plughub': PlughubLocaleKey
  }
}

/**
 * Required services (cordis fiber inject).
 *
 * `connection` is here for one fact only — whether this page is loopback,
 * which decides whether the write controls are offered at all. Every read and
 * every write travels this plugin's own routes.
 */
export const inject = ['slots', 'locale', 'connection']

/**
 * Contribute the OMDSH Plugins tab to the Plugins settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'omdsh-plughub: dictionaries')

  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection') as ConnectionHandle

  const injected = (): OmdshPluginsTabInjected => ({
    catalog: refresh => fetchCatalog(refresh),
    installed: () => fetchInstalled(),
    describeSettings: () => describeSettings(),
    install: async (packageName) => { await requestInstall(packageName) },
    update: async (packageName) => { await requestUpdate(packageName) },
    uninstall: async (packageName) => { await requestUninstall(packageName) },
    writeSetting: mutateSetting,
    // One stream carries operation progress, the restart flag, AND settings
    // invalidations — a commit from another tab or from the document edited
    // by hand arrives here too, which is what keeps two open panels agreeing.
    subscribeOperations: (listener: (event: PlughubEvent) => void) =>
      followOperations(url => new EventSource(url), listener),
    // Writes are loopback-only by design; a page served to the LAN shows the
    // catalog and disables the buttons rather than offering an install that
    // would be refused.
    canWrite: connection.isLoopback,
    cardIds: ctx.slots.entries(PLUGIN_CARD_SLOT)
      .map(entry => entry.options.id)
      .filter((id): id is string => id !== undefined),
    activeLocale: ctx.locale.getSnapshot().active,
  })

  ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({
    name: TAB_SLOT,
    id: TAB_ID,
    order: TAB_ORDER,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
    children: { [PLUGIN_CARD_SLOT]: { kind: 'list', scope: 'root' } },
  }, OmdshPluginsTab))
}
