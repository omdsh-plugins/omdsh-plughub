/**
 * Everything both halves of `@omdsh-plugins/omdsh-plughub` have to agree on:
 * the route paths, and the shapes that travel over them.
 *
 * Kept in its own module, and its own export, because the two halves are
 * compiled into two different artifacts by two different bundlers. A shared
 * type is free — it is erased — but a shared CONSTANT (a route path) has to
 * come from somewhere both builds can reach, and this is it.
 * @module @omdsh-plugins/omdsh-plughub/contract
 */

/** Route prefix every one of this plugin's endpoints sits under. */
export const ROUTE_PREFIX = '/api/plughub'

/** GET: the merged catalog of installable plugins. `?refresh=1` bypasses the cache. */
export const CATALOG_PATH = `${ROUTE_PREFIX}/catalog`

/** GET: what this profile currently has installed, and which of it can be removed. */
export const INSTALLED_PATH = `${ROUTE_PREFIX}/installed`

/** POST `{ id }`: install one catalog entry. The id must be in the current catalog. */
export const INSTALL_PATH = `${ROUTE_PREFIX}/install`

/** POST `{ name }`: remove one dependency-managed bundle by package name. */
export const UNINSTALL_PATH = `${ROUTE_PREFIX}/uninstall`

/**
 * POST `{ name, enabled }`: take a dependency-managed plugin off the composed
 * layer stack, or put it back, without touching `node_modules`.
 *
 * Separate from {@link UNINSTALL_PATH} because the package stays installed —
 * `dsh plugin remove` is what throws it away, and this is what parks it.
 */
export const ENABLED_PATH = `${ROUTE_PREFIX}/enabled`

/**
 * This plugin's own package name. It can be updated, and it cannot be
 * disabled or uninstalled: the hub is the only UI that puts plugins back,
 * including a newer copy of itself.
 */
export const HUB_PACKAGE_NAME = '@omdsh-plugins/omdsh-plughub'

/**
 * The mode registry every mode plugin registers into. It can be updated, and
 * it cannot be disabled or uninstalled: without it a mode plugin loads inert,
 * and installing Chat or Code through the hub does not bring it (the profile
 * uses `autoInstallPeers: false`). It travels with the desktop installer for
 * that reason, the same way the hub does.
 */
export const MODE_PACKAGE_NAME = '@omdsh-plugins/omdsh-basemode'

/**
 * Plugins that stay on the composed stack. Each can be updated; none can be
 * disabled or uninstalled, even when the profile depends on them.
 */
export const REQUIRED_PACKAGE_NAMES = [HUB_PACKAGE_NAME, MODE_PACKAGE_NAME] as const

/**
 * Whether a package is one of {@link REQUIRED_PACKAGE_NAMES}.
 * @param name - the package name.
 * @returns true for the hub and the mode system.
 */
export function isRequiredPlugin(name: string): boolean {
  return (REQUIRED_PACKAGE_NAMES as readonly string[]).includes(name)
}

/**
 * Why a required plugin refused Disable or Remove.
 * @param name - the package name.
 * @param action - the write that was refused.
 * @returns the error the panel, the CLI, and the installer all print.
 */
export function requiredPluginRefusal(name: string, action: 'disabled' | 'uninstalled'): string {
  if (name === HUB_PACKAGE_NAME) return `${name} is the plugin hub and cannot be ${action}`
  if (name === MODE_PACKAGE_NAME) return `${name} is the mode system and cannot be ${action}`
  return `${name} cannot be ${action}`
}

/**
 * POST `{ name }`: reinstall one installed plugin from the specifier the
 * catalog currently resolves for it, which is how a newer version arrives.
 *
 * Separate from {@link INSTALL_PATH} because the preconditions are opposite —
 * an install refuses a package the profile already has, an update requires it
 * — and because the two read differently in a log and on a button.
 */
export const UPDATE_PATH = `${ROUTE_PREFIX}/update`

/** GET: an event stream carrying operation progress and the restart flag. */
export const EVENTS_PATH = `${ROUTE_PREFIX}/events`

/**
 * GET: every settings namespace an installed omdsh plugin owns.
 * POST `{ ns, ops, expectedRevision }`: apply one path-addressed edit.
 *
 * ## Why this is not the harness's `settings.describe`
 *
 * It ought to be. The Host settings seam is exactly the right source, and
 * since 0.1.0-rc.7 the harness publishes every registered namespace to the
 * browser. The official Configurable tab, however, only renders namespaces
 * that claimed `settings.plugin.item` — a card each plugin has to write.
 * This hub's premise is the opposite: a plugin becomes configurable by
 * registering a schema, with no change anywhere else.
 *
 * So this half of the transport is ours and the rest is not: plugins still
 * register ordinary settings namespaces, the Host seam still owns validation,
 * layering, redaction, revisions, and commits, and this route only carries
 * what that seam already computed. The official card slot is still there for
 * a plugin that needs a control the generic form cannot draw.
 *
 * The boundary this route draws is NARROWER than the Host's: a namespace is
 * reachable only when an installed bundle declares it under
 * `dsh.plughub.settings`. Ownership is the allowlist, exactly as the catalog
 * is the allowlist for installs.
 */
export const SETTINGS_PATH = `${ROUTE_PREFIX}/settings`

/**
 * The settings namespace this plugin owns, by the convention it asks of every
 * plugin it lists.
 *
 * It lives in the contract because BOTH halves need it: the Host registers the
 * namespace under this name, and the browser hoists that one namespace out of
 * the installed list and into the catalog region — the configuration that
 * decides where the catalog comes from belongs beside the catalog, not filed
 * under one more plugin at the bottom of the page.
 */
export const HUB_SETTINGS_NAMESPACE = 'omdsh-plughub'

/**
 * Text in one or more locales, in schemastery's own serialized shape: a bare
 * string is locale-independent, and a map keys text by locale id with `''` as
 * the fallback. Using schemastery's shape rather than inventing one means a
 * plugin's package.json metadata and its settings schema descriptions are
 * read by the same resolver in the browser.
 */
export type LocalizedText = string | Readonly<Record<string, string>>

/**
 * The `dsh.plughub` manifest section, normalized. Every field is optional in
 * the manifest — a plugin that declares nothing still appears, under its
 * package name — so this is what parsing produces, not what an author writes.
 */
export interface PlughubMetadata {
  /** Display title; the package name is used when absent. */
  readonly displayName?: LocalizedText
  /** One-line description; the manifest `description` is used when absent. */
  readonly summary?: LocalizedText
  /** Free-form grouping hint (`input`, `system`, `editor`, …). */
  readonly category?: string
  /**
   * Settings namespaces this plugin owns. Declared rather than discovered
   * because nothing on the wire attributes a namespace to a package; when it
   * is absent the reader falls back to the package's unscoped name, which is
   * the convention every omdsh plugin follows.
   */
  readonly settings: readonly string[]
  /** Documentation URL shown on the card. */
  readonly docs?: string
  /** Sort position among cards, ascending. */
  readonly order: number
}

/**
 * Where a catalog entry came from. Also its precedence when two sources offer
 * the same package name, highest first: a checkout you are editing beats a
 * curated list, which beats whatever enumeration happened to find.
 */
export type CatalogSource = 'local' | 'registry' | 'github'

/** Precedence order of {@link CatalogSource}, highest first. */
export const SOURCE_PRECEDENCE: readonly CatalogSource[] = ['local', 'registry', 'github']

/**
 * Where an installed plugin stands against the version its source offers.
 *
 * Absent on an entry this profile does not have: "no update" and "not
 * installed" are different answers, and collapsing them would put a disabled
 * Update button beside every Install button on the page.
 */
export type UpdateState =
  /** The source advertises a version newer than the installed one. */
  | 'available'
  /** Installed, and at the version the source advertises. */
  | 'current'
  /**
   * Installed from a directory on this machine (`link:`), so the installed
   * files ARE the source's files. Nothing can be fetched, and nothing needs to
   * be — a change in the checkout is already in the profile.
   */
  | 'linked'
  /**
   * One of the two versions is missing or is not semver, so the comparison has
   * no answer. Reported rather than assumed either way.
   */
  | 'unknown'

/** One installable plugin, as the catalog offers it. */
export interface CatalogEntry {
  /**
   * The package name, which is also the id an install request names. One id
   * per package after the merge, so a request can never be ambiguous about
   * which source it meant — the merge already decided that.
   */
  readonly name: string
  /** Which source won this entry. */
  readonly source: CatalogSource
  /** Version the source advertises, when it knows one. */
  readonly version?: string
  /** `owner/repo`, when the entry came from (or names) a GitHub repository. */
  readonly repo?: string
  /** The package's own `description`, when the source could read one. */
  readonly description?: string
  /** Normalized `dsh.plughub` metadata. */
  readonly metadata: PlughubMetadata
  /** Whether this profile already has it. */
  readonly installed: boolean
  /** The version this profile has on disk, when it has the plugin at all. */
  readonly installedVersion?: string
  /** Where the installed copy stands against {@link version}; absent when not installed. */
  readonly update?: UpdateState
}

/** How one configured catalog source fared on the last resolution. */
export interface CatalogSourceReport {
  readonly source: CatalogSource
  /** What was consulted: a directory, a manifest URL, an account name. */
  readonly origin: string
  readonly ok: boolean
  /** How many entries it contributed before the merge. */
  readonly count: number
  /** Why it failed, when it did — shown verbatim so a rate limit is legible. */
  readonly error?: string
}

/** The catalog as one document. */
export interface CatalogDocument {
  readonly entries: readonly CatalogEntry[]
  readonly sources: readonly CatalogSourceReport[]
  /**
   * Monotonic resolution counter, not a clock: the only question ever asked
   * of it is "is this newer than what I hold", and a counter answers that
   * without a clock's ways of being wrong.
   */
  readonly generation: number
}

/** One bundle this profile has composed. */
export interface InstalledEntry {
  /** Package name, as it appears in `dsh.profile.bundles`. */
  readonly name: string
  readonly version?: string
  readonly description?: string
  readonly metadata: PlughubMetadata
  /**
   * Whether this plugin can be removed from here. False for the profile
   * template's own bundles (`dsh-base`, `dsh-web-app`) and for this hub:
   * template bundles are not dependencies, so `pnpm remove` has nothing to
   * take out, and the hub is the only UI that puts plugins back.
   */
  readonly removable: boolean
  /**
   * Whether this plugin's bundle layer is on the composed stack. A disabled
   * plugin is still installed — its files stay in `node_modules` — and
   * Enable puts the layer back without another fetch.
   */
  readonly enabled: boolean
  /**
   * Whether Enable/Disable is offered. Template bundles cannot leave the
   * stack, and neither can the hub: Update is the one write the hub
   * accepts.
   */
  readonly toggleable: boolean
}

/** What this profile has installed. */
export interface InstalledDocument {
  /**
   * The profile's name. Deliberately NOT its directory: a Host path on the
   * wire is a Host path an attacker learns, and the browser has no use for
   * one — every operation names the profile by name and runs Host-side.
   */
  readonly profile: string
  readonly entries: readonly InstalledEntry[]
  /** Whether an operation has landed that this process has not composed. */
  readonly restartRequired: boolean
}

/**
 * One schema-declared secret position inside a redacted namespace value.
 *
 * The value itself never rides; `set` is how a form learns a write-only field
 * exists and whether it currently holds anything. `overridden` is how it
 * learns the user layer carries the key — redaction strips that key from
 * `user`, so presence there cannot be read from the wire.
 */
export interface SettingsSecretView {
  /** Path from the section root to the removed field. */
  readonly path: readonly string[]
  readonly set: boolean
  /**
   * Whether the user layer carries this path. Same meaning as presence in
   * {@link SettingsNamespaceView.user} for every other field.
   */
  readonly overridden: boolean
}

/** Wire view of one registered settings namespace, redacted. */
export interface SettingsNamespaceView {
  /** The namespace key. */
  readonly ns: string
  /** Serialized schemastery schema (`schema.toJSON()`); rehydrate with `new Schema(json)`. */
  readonly schema: unknown
  /** Redacted resolved value: schema defaults, then composition base, then the user layer. */
  readonly value: unknown
  /** Redacted composition base layer, when the registrant declared one. */
  readonly base?: unknown
  /**
   * Redacted raw user section, when one exists. A field's PRESENCE here is
   * what marks it user-overridden — presence, never value comparison.
   */
  readonly user?: unknown
  /** When the owner acts on a change. */
  readonly applies: 'live' | 'restart'
  /** Every schema-declared secret position with its configured state. */
  readonly secrets: readonly SettingsSecretView[]
  /**
   * Monotonic revision of the raw user section this view was read at. Sent
   * back as `expectedRevision` on a write, so a stale editor is refused
   * rather than silently overwriting a concurrent change.
   */
  readonly revision: number
}

/**
 * One path-addressed edit. `set` writes the value at the path (creating
 * intermediate objects); `unset` removes it.
 *
 * Path-addressed rather than wholesale because a caller holding a REDACTED
 * view cannot restate the section: a `replace` rebuilt from what a form shows
 * would delete every secret the wire never sent.
 */
export type SettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/** Everything the panel needs to configure the installed plugins. */
export interface SettingsDocument {
  /** Whether the provider accepts writes at all; false disables every control. */
  readonly writable: boolean
  /** Whether a local settings document exists to point a person at. */
  readonly hasDocument: boolean
  /** One view per namespace an installed plugin owns, in registration order. */
  readonly namespaces: readonly SettingsNamespaceView[]
}

/** What a POST to {@link SETTINGS_PATH} carries. */
export interface SettingsWriteRequest {
  /** The namespace to edit; must be one an installed plugin declares. */
  readonly ns: string
  readonly ops: readonly SettingsPathOp[]
  /** The revision the caller read; a namespace that moved past it is refused. */
  readonly expectedRevision?: number
}

/** What a successful write answers with: the namespace's new redacted view. */
export interface SettingsWriteResponse {
  readonly namespace: SettingsNamespaceView
}

/** Which way an operation goes. */
export type OperationKind = 'install' | 'uninstall' | 'update' | 'enable' | 'disable'

/** Where one operation stands. */
export type OperationStatus = 'running' | 'ok' | 'failed'

/** One install or removal, from start to settled. */
export interface OperationState {
  /** Monotonic per-runtime id, so a client can tell two runs of one package apart. */
  readonly id: number
  readonly kind: OperationKind
  /** The package name being installed or removed. */
  readonly name: string
  readonly status: OperationStatus
  /** The failure, when there was one. */
  readonly error?: string
  /**
   * The tail of what the package manager printed, bounded. Kept because the
   * commonest install failure — pnpm ≥10 blocking a git dependency's build
   * script — is only diagnosable from pnpm's own words.
   */
  readonly log: readonly string[]
}

/** Everything {@link EVENTS_PATH} carries. */
export type PlughubEvent =
  /** Sent once on connect: the operations this runtime has seen, and the flag. */
  | { readonly kind: 'snapshot'; readonly operations: readonly OperationState[]; readonly restartRequired: boolean }
  /** One operation changed state. */
  | { readonly kind: 'operation'; readonly operation: OperationState; readonly restartRequired: boolean }
  /**
   * One namespace's stored section moved — from this panel, another tab, or
   * the settings document edited by hand. Carries no value: the reader
   * re-reads, so one notification cannot be a stale copy of the truth.
   */
  | { readonly kind: 'settings'; readonly ns: string }

/** What a POST to {@link INSTALL_PATH} carries. */
export interface InstallRequest {
  /** A {@link CatalogEntry.name} from the catalog this runtime last resolved. */
  readonly id: string
}

/** What a POST to {@link UNINSTALL_PATH} carries. */
export interface UninstallRequest {
  /** An {@link InstalledEntry.name} that reported `removable`. */
  readonly name: string
}

/** What a POST to {@link UPDATE_PATH} carries. */
export interface UpdateRequest {
  /** A {@link CatalogEntry.name} that is installed and that the catalog still offers. */
  readonly name: string
}

/** What a POST to {@link ENABLED_PATH} carries. */
export interface EnabledRequest {
  /** An {@link InstalledEntry.name} that reported `toggleable`. */
  readonly name: string
  /** The intended composed state. */
  readonly enabled: boolean
}

/** What both write routes answer with on success. */
export interface OperationAccepted {
  readonly operation: OperationState
}

/** Metadata defaults for a package that declares no `dsh.plughub` section. */
export const EMPTY_METADATA: PlughubMetadata = { settings: [], order: 0 }
