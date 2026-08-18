/**
 * Talking to this plugin's own Host half: the catalog, the installed list, the
 * write routes, and the event stream that says how an install is going.
 *
 * Plain `fetch` against same-origin paths rather than an RPC remote, for the
 * reason `omdsh-shortcuts` reaches the same way: a generated Remote is a
 * codegen step wired into the harness's own build, and an out-of-tree plugin
 * that needed one would need that build. Routes on the webserver the base
 * bundle already composes need nothing but a path.
 * @module @omdsh-plugins/omdsh-plughub/client/hub-source
 */

import {
  CATALOG_PATH, ENABLED_PATH, EVENTS_PATH, INSTALL_PATH, INSTALLED_PATH, UNINSTALL_PATH, UPDATE_PATH,
  type CatalogDocument, type InstalledDocument, type OperationState, type PlughubEvent,
} from '../contract.ts'

/** A failure carrying what the Host said, so the panel can show it verbatim. */
export class HubError extends Error {
  /** The HTTP status, when the request reached the Host at all. */
  readonly status: number

  /**
   * @param status - the response status, or 0 when the request never landed.
   * @param message - the Host's own words where it gave any.
   */
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HubError'
    this.status = status
  }
}

/**
 * Read one route's JSON, turning a non-2xx into the Host's own error text.
 * @param path - the route.
 * @param init - fetch options.
 * @returns the parsed body.
 * @throws {HubError} carrying the status and the Host's own words.
 */
export async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    // The page is up and the runtime is not — worth distinguishing from a
    // refusal, because one of them resolves itself and the other does not.
    throw new HubError(0, error instanceof Error ? error.message : String(error))
  }
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `${path} answered ${String(response.status)}`
    throw new HubError(response.status, message)
  }
  return body as T
}

/**
 * Read the catalog.
 * @param refresh - bypass the Host's cache and consult every source again.
 * @returns the catalog document.
 */
export function fetchCatalog(refresh = false): Promise<CatalogDocument> {
  return readJson<CatalogDocument>(refresh ? `${CATALOG_PATH}?refresh=1` : CATALOG_PATH)
}

/**
 * Read what this profile has installed.
 * @returns the installed document.
 */
export function fetchInstalled(): Promise<InstalledDocument> {
  return readJson<InstalledDocument>(INSTALLED_PATH)
}

/** Post one small JSON body to a write route. */
function post(path: string, body: unknown): Promise<{ operation: OperationState }> {
  return readJson<{ operation: OperationState }>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Ask the Host to install one catalog entry.
 *
 * The request names an ID from the catalog, never a package specifier: the
 * Host looks the specifier up in the catalog IT resolved, so this route can
 * reach nothing the configured upstreams did not offer.
 * @param id - the catalog entry's package name.
 * @returns the accepted operation.
 */
export function requestInstall(id: string): Promise<{ operation: OperationState }> {
  return post(INSTALL_PATH, { id })
}

/**
 * Ask the Host to reinstall one installed plugin from what the catalog offers
 * now.
 *
 * Names the package and nothing else, exactly as an install does: the version
 * the panel is showing is a fact it READ, and sending it back would let a
 * stale page pin an install to a version that is no longer the one on offer.
 * The Host re-resolves and acts on what it finds.
 * @param name - the package name.
 * @returns the accepted operation.
 */
export function requestUpdate(name: string): Promise<{ operation: OperationState }> {
  return post(UPDATE_PATH, { name })
}

/**
 * Ask the Host to remove one installed plugin.
 * @param name - the package name.
 * @returns the accepted operation.
 */
export function requestUninstall(name: string): Promise<{ operation: OperationState }> {
  return post(UNINSTALL_PATH, { name })
}

/**
 * Ask the Host to put a dependency-managed plugin on the composed stack, or
 * take it off, without touching `node_modules`.
 * @param name - the package name.
 * @param enabled - the intended composed state.
 * @returns the accepted operation.
 */
export function requestSetEnabled(name: string, enabled: boolean): Promise<{ operation: OperationState }> {
  return post(ENABLED_PATH, { name, enabled })
}

/** How an event stream is opened; injected so specs need no EventSource. */
export type OpenStream = (url: string) => {
  addEventListener: (type: 'message', listener: (event: { data: string }) => void) => void
  close: () => void
}

/**
 * Parse one event-stream payload.
 * @param data - the `data:` line's contents.
 * @returns the event, or undefined when it is not one this client knows.
 */
export function parseEvent(data: string): PlughubEvent | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const kind = (parsed as { kind?: unknown }).kind
  return kind === 'snapshot' || kind === 'operation' || kind === 'settings'
    ? parsed as PlughubEvent
    : undefined
}

/**
 * Follow the Host's operation stream.
 * @param open - how to open the stream.
 * @param onEvent - receives every event this client understands.
 * @returns the disposer closing the stream.
 */
export function followOperations(open: OpenStream, onEvent: (event: PlughubEvent) => void): () => void {
  const stream = open(EVENTS_PATH)
  stream.addEventListener('message', (event) => {
    const parsed = parseEvent(event.data)
    if (parsed !== undefined) onEvent(parsed)
  })
  return () => { stream.close() }
}

/**
 * Fold one event into the operation list a panel holds.
 *
 * The Host is the authority on an operation's state, so an update REPLACES the
 * row rather than merging into it; a snapshot replaces the list outright,
 * which is what makes a reconnect self-healing.
 * @param operations - what the panel currently holds.
 * @param event - the arriving event.
 * @returns the next list.
 */
export function applyEvent(
  operations: readonly OperationState[],
  event: PlughubEvent,
): readonly OperationState[] {
  if (event.kind === 'snapshot') return event.operations
  // A settings invalidation says nothing about any operation; the caller
  // re-reads on it, and the list is left exactly as it stands.
  if (event.kind !== 'operation') return operations
  const index = operations.findIndex(candidate => candidate.id === event.operation.id)
  if (index === -1) return [...operations, event.operation]
  const next = [...operations]
  next[index] = event.operation
  return next
}

/**
 * The operation currently deciding one package's fate, if any.
 * @param operations - the panel's operation list.
 * @param name - the package name.
 * @returns the latest operation naming it.
 */
export function operationFor(
  operations: readonly OperationState[],
  name: string,
): OperationState | undefined {
  // Latest first: a package can be installed, removed, and installed again in
  // one session, and only the last of those describes where it stands now.
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index]
    if (operation?.name === name) return operation
  }
  return undefined
}
