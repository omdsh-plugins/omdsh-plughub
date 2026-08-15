/**
 * Reading and writing plugin configuration.
 *
 * The values come from the harness's own settings seam and are computed there:
 * schema validation, the base/user layering, secret redaction, revisions, and
 * commits are all `ctx.settings`'s, and nothing here reimplements any of it.
 * What this module owns is one route round-trip and the small amount of
 * bookkeeping a form needs on top.
 *
 * The route is this plugin's rather than the harness's `settings.describe`
 * for the reason spelled out on {@link SETTINGS_PATH}: that wire is gated by a
 * hard-coded allowlist of namespace names, so no out-of-tree plugin's
 * namespace can cross it. Everything else about the flow is identical.
 * @module @omdsh-plugins/omdsh-plughub/client/settings-source
 */

import {
  SETTINGS_PATH,
  type SettingsDocument, type SettingsNamespaceView, type SettingsPathOp,
} from '../contract.ts'
import { HubError, readJson } from './hub-source.ts'

/** Everything the panel learned from one read. */
export interface SettingsSnapshot {
  /** Whether the provider accepts writes at all (a read-only provider disables every control). */
  readonly writable: boolean
  /** Whether a local settings document exists to point a person at. */
  readonly hasDocument: boolean
  /** Every namespace an installed plugin owns, by name. */
  readonly namespaces: ReadonlyMap<string, SettingsNamespaceView>
}

/** What a write turned into. */
export type WriteOutcome =
  | { readonly status: 'ok'; readonly view: SettingsNamespaceView }
  /** The namespace moved since this form read it; the caller re-reads and retries. */
  | { readonly status: 'conflict' }
  | { readonly status: 'failed'; readonly message: string }

/** The empty snapshot, used before the first read settles. */
export const EMPTY_SETTINGS: SettingsSnapshot = {
  writable: false,
  hasDocument: false,
  namespaces: new Map(),
}

/** The status a refused write carries when the namespace moved underneath it. */
export const CONFLICT_STATUS = 409

/**
 * Read every namespace the installed plugins own.
 * @returns the snapshot.
 * @throws {HubError} when the route is unreachable or refuses.
 */
export async function describeSettings(): Promise<SettingsSnapshot> {
  const document = await readJson<SettingsDocument>(SETTINGS_PATH)
  return {
    writable: document.writable,
    hasDocument: document.hasDocument,
    namespaces: new Map(document.namespaces.map(view => [view.ns, view])),
  }
}

/**
 * Apply one path-addressed edit to a namespace.
 *
 * `expectedRevision` rides every write. Two surfaces can hold this panel open
 * at once — two tabs, a tab and the desktop shell — and without it the second
 * writer silently overwrites what the first stored. With it, the second writer
 * is refused, re-reads, and the person sees the current value instead of a
 * change that vanished.
 * @param ns - the namespace to edit.
 * @param ops - the path edits.
 * @param expectedRevision - the revision this form last read.
 * @returns what became of the write.
 */
export async function mutateSetting(
  ns: string,
  ops: readonly SettingsPathOp[],
  expectedRevision?: number,
): Promise<WriteOutcome> {
  try {
    const { namespace } = await readJson<{ namespace: SettingsNamespaceView }>(SETTINGS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ns,
        ops,
        ...expectedRevision === undefined ? {} : { expectedRevision },
      }),
    })
    return { status: 'ok', view: namespace }
  } catch (error) {
    if (error instanceof HubError && error.status === CONFLICT_STATUS) return { status: 'conflict' }
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The namespaces one plugin owns, in declaration order.
 *
 * A plugin says which namespaces are its own in `dsh.plughub.settings`; when
 * it does not, the manifest reader already fell back to its unscoped package
 * name. Only namespaces the Host actually registered survive — a declaration
 * is what a package MEANS to own, and a namespace appears here only once its
 * owner has mounted and registered it.
 * @param declared - the namespaces the package declares.
 * @param snapshot - the current snapshot.
 * @returns the views, in declaration order.
 */
export function namespacesFor(
  declared: readonly string[],
  snapshot: SettingsSnapshot,
): SettingsNamespaceView[] {
  const views: SettingsNamespaceView[] = []
  for (const ns of declared) {
    const view = snapshot.namespaces.get(ns)
    if (view !== undefined) views.push(view)
  }
  return views
}

/**
 * Whether a redacted secret slot at one path currently holds a value.
 * @param view - the namespace view.
 * @param path - the field's path.
 * @returns true when the Host reports the slot configured.
 */
export function isSecretSet(view: SettingsNamespaceView, path: readonly string[]): boolean {
  return view.secrets.some(slot =>
    slot.path.length === path.length && slot.path.every((part, index) => part === path[index]) && slot.set)
}
