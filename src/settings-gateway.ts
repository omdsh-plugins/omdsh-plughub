/**
 * The settings seam, carried to the panel over this plugin's own routes.
 *
 * ## Why this module exists at all
 *
 * The harness already publishes the settings seam to the browser, and this
 * hub would rather use it. It does not: as of 0.1.0-rc.7 the Host serves
 * every registered namespace, but the official Configurable tab only renders
 * ones that claimed `settings.plugin.item`, and this hub exists to configure
 * every omdsh plugin from the schema it already registered — including ones
 * that never wrote a card. A hub built on the official tab would configure
 * only the plugins that shipped a card, which is the one thing this hub
 * exists not to be.
 *
 * ## What it does and does not own
 *
 * It owns transport and one allowlist. It owns NO settings logic: resolution,
 * schema validation, the base/user layering, secret redaction, revisions, and
 * commits all stay in `ctx.settings`, and this reads what that already
 * computed. `describe({ redactSecrets: true })` is what strips the secrets
 * from every wire view. This module does read an unredacted describe once,
 * Host-side only, to recover whether a secret path is present in the user
 * layer — redaction deletes that key, and a form cannot mark the field
 * overridden without it. The values themselves never leave this file.
 *
 * ## The allowlist
 *
 * A namespace is reachable only when an INSTALLED bundle declares it under
 * `dsh.plughub.settings`. That is narrower than the boundary it stands in
 * for: `shell` and `agent-loop` are registered in this process and are not
 * reachable through here, because no omdsh plugin claims them. Ownership is
 * the allowlist, the same way the catalog is the allowlist for installs.
 * @module @omdsh-plugins/omdsh-plughub/settings-gateway
 */

import type {
  InstalledEntry, SettingsDocument, SettingsNamespaceView, SettingsPathOp, SettingsSecretView,
} from './contract.ts'
import { isOverridden } from './settings-path.ts'

/** One schema-declared secret position as the seam reports it. */
interface SeamSecretSlot {
  readonly path: readonly string[]
  readonly set: boolean
}

/** One descriptor as the settings seam produces it. */
export interface SettingsDescriptorLike {
  readonly ns: string
  readonly schema: unknown
  readonly value: unknown
  readonly revision: number
  readonly base?: unknown
  readonly user?: unknown
  readonly applies: 'live' | 'restart'
  readonly secrets?: readonly SeamSecretSlot[]
}

/** The settings seam, as much of it as this gateway uses. */
export interface SettingsSeam {
  /** Whether the provider can persist a write at all. */
  readonly writable: boolean
  /** Absolute path of the user-editable document, when storage is one local file. */
  readonly documentPath?: string | undefined
  /**
   * Describe every registered namespace.
   * @param options - redaction switch; every wire surface must redact.
   */
  describe: (options?: { redactSecrets?: boolean }) => readonly SettingsDescriptorLike[]
  /**
   * Apply path-addressed edits to one namespace's user section.
   * @param ns - the namespace.
   * @param ops - the ordered edits.
   * @param expectedRevision - the revision the caller read.
   */
  mutate: (ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number) => Promise<void>
}

/** The seam's own code for a write refused because the namespace moved. */
export const SETTINGS_CONFLICT = 'SETTINGS_CONFLICT'

/**
 * Every namespace the installed plugins claim.
 *
 * Read from the manifests rather than from the settings service, and that
 * direction matters: a namespace is reachable because a PACKAGE said it owns
 * it, not because something in this process happens to have registered it.
 * @param entries - the profile's composed bundles.
 * @returns the owned namespace names.
 */
export function ownedNamespaces(entries: readonly InstalledEntry[]): Set<string> {
  const owned = new Set<string>()
  for (const entry of entries) {
    for (const ns of entry.metadata.settings) owned.add(ns)
  }
  return owned
}

/**
 * Project one descriptor onto the wire.
 * @param descriptor - the seam's descriptor, already redacted.
 * @param rawUser - the unredacted user layer, Host-side only, so secret
 *   override can be recovered after redaction deleted the key. Never copied
 *   onto the view.
 * @returns the wire view.
 */
export function toNamespaceView(descriptor: SettingsDescriptorLike, rawUser?: unknown): SettingsNamespaceView {
  const secrets: SettingsSecretView[] = (descriptor.secrets ?? []).map(slot => ({
    path: slot.path,
    set: slot.set,
    overridden: isOverridden(rawUser, slot.path),
  }))
  return {
    ns: descriptor.ns,
    schema: descriptor.schema,
    value: descriptor.value,
    ...descriptor.base === undefined ? {} : { base: descriptor.base },
    ...descriptor.user === undefined ? {} : { user: descriptor.user },
    applies: descriptor.applies,
    // Absent only when the caller forgot to redact, which this module never
    // does; an empty list is then the truthful report rather than a crash.
    secrets,
    revision: descriptor.revision,
  }
}

/**
 * Unredacted user layers of the owned namespaces. Read Host-side so secret
 * presence survives; the values never leave this function.
 * @param settings - the settings seam.
 * @param owned - the namespaces installed plugins claim.
 * @returns user layers by namespace.
 */
function rawUserByNamespace(settings: SettingsSeam, owned: ReadonlySet<string>): Map<string, unknown> {
  const layers = new Map<string, unknown>()
  for (const descriptor of settings.describe()) {
    if (owned.has(descriptor.ns)) layers.set(descriptor.ns, descriptor.user)
  }
  return layers
}

/**
 * Describe the namespaces the installed plugins own.
 * @param settings - the settings seam.
 * @param owned - the namespaces installed plugins claim.
 * @returns the wire document.
 */
export function describeOwned(settings: SettingsSeam, owned: ReadonlySet<string>): SettingsDocument {
  const rawUsers = rawUserByNamespace(settings, owned)
  return {
    writable: settings.writable,
    // Reported without the path: a Host path on the wire is a Host path an
    // attacker learns, and the panel only needs to know one exists.
    hasDocument: settings.documentPath !== undefined,
    namespaces: settings
      .describe({ redactSecrets: true })
      .filter(descriptor => owned.has(descriptor.ns))
      .map(descriptor => toNamespaceView(descriptor, rawUsers.get(descriptor.ns))),
  }
}

/** What became of one write. */
export type WriteResult =
  | { readonly status: 'ok'; readonly namespace: SettingsNamespaceView }
  /** The namespace is not one an installed plugin claims. */
  | { readonly status: 'not-owned' }
  /** The namespace moved since the caller read it; re-read and retry. */
  | { readonly status: 'conflict'; readonly message: string }
  /** The seam refused the write: schema, cross-field check, or storage. */
  | { readonly status: 'rejected'; readonly message: string }

/** Whether a value is a plain data object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one write request's ops before the seam sees them.
 * @param ops - the candidate ops.
 * @returns the ops, or undefined when the shape is not one.
 */
export function readOps(ops: unknown): SettingsPathOp[] | undefined {
  if (!Array.isArray(ops) || ops.length === 0) return undefined
  const read: SettingsPathOp[] = []
  for (const candidate of ops) {
    if (!isRecord(candidate)) return undefined
    const path = candidate['path']
    if (!Array.isArray(path) || path.some(part => typeof part !== 'string')) return undefined
    if (candidate['op'] === 'set') read.push({ op: 'set', path: path as string[], value: candidate['value'] })
    else if (candidate['op'] === 'unset') read.push({ op: 'unset', path: path as string[] })
    else return undefined
  }
  return read
}

/**
 * Apply one path-addressed edit and answer with the namespace's new view.
 * @param settings - the settings seam.
 * @param owned - the namespaces installed plugins claim.
 * @param request - the namespace, ops, and the revision the caller read.
 * @returns what became of the write.
 */
export async function writeOwned(
  settings: SettingsSeam,
  owned: ReadonlySet<string>,
  request: { ns: string; ops: readonly SettingsPathOp[]; expectedRevision?: number | undefined },
): Promise<WriteResult> {
  // Checked before the seam is touched, so an unowned namespace is refused
  // rather than written and then reported.
  if (!owned.has(request.ns)) return { status: 'not-owned' }
  try {
    await settings.mutate(request.ns, request.ops, request.expectedRevision)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return (error as { code?: unknown } | null)?.code === SETTINGS_CONFLICT
      ? { status: 'conflict', message }
      : { status: 'rejected', message }
  }
  const descriptor = settings
    .describe({ redactSecrets: true })
    .find(candidate => candidate.ns === request.ns)
  if (descriptor === undefined) {
    // The write landed and the registrant went away underneath it — a plugin
    // unloading mid-edit. Reporting it as rejected would be a lie about
    // storage; reporting the value would need one that no longer exists.
    return { status: 'rejected', message: `settings namespace "${request.ns}" is no longer registered` }
  }
  const raw = settings.describe().find(candidate => candidate.ns === request.ns)
  return { status: 'ok', namespace: toNamespaceView(descriptor, raw?.user) }
}
