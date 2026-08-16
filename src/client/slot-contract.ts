/**
 * The escape hatch.
 *
 * The generic form covers the shapes a settings schema usually has, and it
 * will not cover every one. A chord capture is the obvious example: a keyboard
 * shortcut is a string in the schema, and the control a person wants is one
 * that listens for the keystroke rather than one they type `Ctrl+K` into.
 *
 * So this tab declares a card slot. A plugin whose configuration needs a
 * control this form cannot draw registers its own card here, under its package
 * name, and the tab renders that INSTEAD of the generic form for that plugin —
 * the plugin still owns its settings namespace, so the escape hatch changes
 * what the control looks like and nothing about where the value lives.
 *
 * Declared here rather than reusing the harness's `settings.plugin.item`
 * because that slot is declared by the Configurable tab and only exists while
 * that tab is mounted; a card registered there appears in THAT tab. This one
 * is ours, and a card registered here appears here.
 * @module @omdsh-plugins/omdsh-plughub/client/slot-contract
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One plugin's bespoke configuration card inside the Plugin hub tab.
     *
     * Register with `id` set to your PACKAGE NAME: that is how the tab knows
     * which installed plugin your card belongs to, and it is what lets the tab
     * render your card in place of the generic form rather than beside it. An
     * id that matches no installed plugin renders at the end of the list,
     * which is the honest outcome — the card exists, its plugin does not.
     *
     * `order` positions it; `label` is unused (the tab draws the card header
     * from the plugin's own manifest, so one plugin cannot title itself
     * differently in two places).
     */
    'omdsh.plugin.card': { kind: 'list'; scope: 'root'; owner: OmdshPluginCardOwnerProps }
  }
}

/**
 * Owner share of a bespoke plugin card: what the tab already knows and the
 * card would otherwise have to re-derive.
 */
export interface OmdshPluginCardOwnerProps {
  /** Whether the settings provider accepts writes at all in this deployment. */
  writable: boolean
  /** The active locale id, for a card resolving its own localized text. */
  locale: string
}

/** The slot name, exported so a registrant does not restate the string. */
export const PLUGIN_CARD_SLOT = 'omdsh.plugin.card'

/** The seat this tab takes in the harness's Plugins settings section. */
export const TAB_SLOT = 'settings.plugins.tab'

/** This tab's entry id inside that seat. */
export const TAB_ID = 'omdsh'

/**
 * Tab position: after the shipped `configurable` (0) and `all` (10) entries,
 * so this one lands to the right of both rather than displacing either.
 */
export const TAB_ORDER = 20

/**
 * Dictionary namespace owned by this plugin — the panel chrome only. Every
 * word ABOUT a plugin comes from that plugin's manifest and schema.
 */
export const NS = 'settings.plughub'
