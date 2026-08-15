/**
 * `@omdsh-plugins/omdsh-plughub` — the host half: what the profile has, what the
 * upstream offers, and the one place either of those changes.
 *
 * ## Why any of this is on the Host at all
 *
 * Every question this plugin answers is a question about a directory. Which
 * plugins are installed is `dsh.profile.bundles` in the profile's
 * package.json; what one of them is called is that package's own manifest;
 * installing another is `pnpm` writing `node_modules`. A page can do none of
 * that, so the browser half asks and this half answers — over ordinary routes
 * on the webserver the base bundle already composes, the way `omdsh-shortcuts`
 * publishes its menu.
 *
 * ## What it owns of a plugin's configuration: transport, and nothing else
 *
 * Configuration values are the settings seam's — schema validation, the
 * composition-base layer, secret redaction, revision conflicts, and hot
 * commits all stay in `ctx.settings`, and this reads what that already
 * computed. It would rather not carry them at all: the harness publishes the
 * same seam to the browser, and this hub would simply use it if it could. It
 * cannot, because that wire is gated by a hard-coded allowlist of namespace
 * NAMES that no out-of-tree plugin can be in. `settings-gateway.ts` has the
 * whole story; the short version is that one route stands in for one gate,
 * and everything on either side of it is the harness's.
 *
 * It also registers its OWN namespace, so this plugin is configurable in its
 * own panel by the same convention it asks of everyone else. The panel draws
 * that one namespace beside the catalog rather than in the installed list,
 * because these fields are the answer to "where does this list come from".
 *
 * ## Install, update, remove
 *
 * Three write routes, all of them one `dsh plugin` run. An update is the same
 * `add` an install is — `pnpm` re-resolves a dependency that is already there
 * — and it exists as its own route because the preconditions are opposite (an
 * install refuses what the profile has; an update requires it) and because a
 * button, a log line, and a failure all read better for saying which one
 * happened. Whether an update is OFFERED is decided in `version.ts`, from the
 * version the catalog resolved and the version on disk.
 *
 * ## The reach
 *
 * Reads carry `/api`'s fence. Writes are loopback-only, because each of them
 * changes this machine — an install runs a package's build script, and a
 * settings write persists to the Host document. And a write names something
 * the Host already resolved: an install names a catalog ENTRY, never a package
 * specifier, and a settings write names a namespace an INSTALLED plugin
 * declares it owns. See `trust-fence.ts` for why the two fences differ.
 * @module @omdsh-plugins/omdsh-plughub
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import Schema from '@deepseek-ai/schemastery'
import {
  CATALOG_PATH, EVENTS_PATH, HUB_SETTINGS_NAMESPACE, INSTALL_PATH, INSTALLED_PATH, SETTINGS_PATH,
  UNINSTALL_PATH, UPDATE_PATH,
  type CatalogDocument, type InstalledDocument, type OperationState, type PlughubEvent,
} from './contract.ts'
import { Catalog, catalogOptions, type InstalledFacts } from './catalog/index.ts'
import { Installer } from './installer.ts'
import {
  describeOwned, ownedNamespaces, readOps, writeOwned, type SettingsSeam,
} from './settings-gateway.ts'
import {
  isRestartRequired, listInstalled, readProfileManifest, resolveHome, resolveProfile,
  ProfileResolutionError, type ResolvedProfile,
} from './profile.ts'
import { isLoopbackRequest, isTrustedRequest } from './trust-fence.ts'

export * from './contract.ts'
export { Catalog, catalogOptions, mergeSources, toDocument } from './catalog/index.ts'
export type { InstalledFacts } from './catalog/index.ts'
export { compareVersions, isLinkedSpec, parseVersion, updateStateFor, versionLabel } from './version.ts'
export {
  Installer, allowBuild, boundLog, isLauncherEntry, resolveLauncher, withAllowBuild, withPathPrefix,
} from './installer.ts'
export { resolvePnpmDir, wellKnownPnpmDirs } from './pnpm.ts'
export { readManifest, parseManifest, readPlughubMetadata, impliedNamespace } from './manifest.ts'
export {
  describeOwned, ownedNamespaces, readOps, toNamespaceView, writeOwned, SETTINGS_CONFLICT,
  type SettingsDescriptorLike, type SettingsSeam, type WriteResult,
} from './settings-gateway.ts'
export {
  isRestartRequired, listInstalled, readProfileManifest, resolveHome, resolveProfile,
  profileFromBaseUrl, profileFromDirectory, isProfileDirectory, resolvePackageDir,
} from './profile.ts'
export { isLoopbackHostname, isLoopbackRequest, isTrustedRequest } from './trust-fence.ts'

/** Stable Cordis plugin name. */
export const name = 'omdsh-plughub'

/** The route registry this plugin publishes through. */
export const inject = ['webServer']

/**
 * The settings namespace this plugin owns, by the convention it asks of every
 * plugin. Declared in the contract because the browser half hoists this one
 * namespace into the catalog region — see {@link HUB_SETTINGS_NAMESPACE}.
 */
export const SETTINGS_NAMESPACE = HUB_SETTINGS_NAMESPACE

/**
 * How this plugin is configured.
 *
 * A schemastery schema rather than an interface, because that is the whole
 * convention: a namespace registered with a schema is a namespace the hub can
 * render a form for, and a hub that could not configure itself would be
 * asking of others what it does not do. Every description is localized here so
 * the browser needs no dictionary of its own for these fields.
 */
export const Config = Schema.object({
  upstream: Schema.string().default('omdsh-plugins')
    .description('GitHub account whose repositories are offered when no registry manifest is published. Empty disables enumeration.'),
  registryUrl: Schema.string().default('')
    .description('Curated catalog manifest. Empty derives it from the upstream account.'),
  localSources: Schema.array(Schema.string()).default([])
    .description('Directories of plugin checkouts offered as installable entries. Highest precedence.'),
  githubToken: Schema.string().role('secret').default('')
    .description('GitHub token, to lift the 60-requests-per-hour anonymous rate limit on enumeration.'),
  maxRepos: Schema.number().min(1).max(500).default(100)
    .description('Most repositories examined when enumerating the upstream account.'),
  timeoutMs: Schema.number().min(1000).max(120000).default(10000)
    .description('Per-request timeout for every remote catalog source, in milliseconds.'),
  cacheTtlMs: Schema.number().min(0).max(3600000).default(300000)
    .description('How long a resolved catalog is reused before the sources are consulted again, in milliseconds.'),
  profileDir: Schema.string().default('')
    .description('Profile directory to manage. Empty derives it from the profile this runtime booted from.'),
  launcher: Schema.string().default('')
    .description('Path to the dsh launcher used for installs. Empty resolves it from the running runtime, then PATH.'),
  pnpmPath: Schema.string().default('')
    .description('Path to the pnpm executable the launcher shells out to. Empty searches the runtime, the profile, and the usual install locations.'),
}).i18n({
  zh: {
    upstream: '未发布清单时枚举其仓库的 GitHub 账号；留空则关闭枚举。',
    registryUrl: '插件清单地址；留空则由上游账号推导。',
    localSources: '作为可安装条目提供的本地插件目录，优先级最高。',
    githubToken: 'GitHub 令牌，用于解除匿名枚举每小时 60 次的限流。',
    maxRepos: '枚举上游账号时最多检查的仓库数。',
    timeoutMs: '每个远程目录源的单次请求超时（毫秒）。',
    cacheTtlMs: '已解析的目录复用多久后重新拉取（毫秒）。',
    profileDir: '要管理的 profile 目录；留空则取当前运行的 profile。',
    launcher: '执行安装的 dsh 可执行文件路径；留空则先取当前运行的 runtime，再走 PATH。',
    pnpmPath: 'dsh 调用的 pnpm 可执行文件路径；留空则依次在 runtime、profile 和常见安装位置里找。',
  },
})

/** The resolved configuration, as the schema admits it. */
export type PlughubConfig = ReturnType<typeof Config>

/** The webserver seam, structurally: as much of it as this plugin uses. */
export interface WebServerLike {
  /**
   * Register an exact-path HTTP route.
   * @param route - the path and its handler.
   * @returns the disposer removing it.
   */
  register: (route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }) => () => void
}

/** The web runtime's trust facts, structurally (see `omdsh-sidepanel` for the same mirror). */
interface WebRuntimeTrust {
  /** LAN literals sampled at bind, followed by explicit `--trusted-host` authorities. */
  readonly trustedHosts: readonly string[]
}

/** One namespace's owner handle, as much of `SettingsScope` as this plugin uses. */
interface SettingsScopeLike<T> {
  get: () => T
  watch: (callback: (next: T) => void) => () => void
}

/** The settings seam, structurally: the registration half plus the gateway's. */
interface SettingsLike extends SettingsSeam {
  register: <T>(
    ns: string,
    schema: unknown,
    options?: { base?: Partial<T>; applies?: 'live' | 'restart' },
  ) => SettingsScopeLike<T>
}

/**
 * The plugin context, as much of it as this plugin uses.
 *
 * Structural rather than imported, and notably NOT a `declare module` on
 * cordis's `Context`: a package compiled outside the harness typechecks its
 * browser and host halves as ONE program, so two declarations of one Context
 * key are resolved by whichever the compiler saw first. Services are therefore
 * resolved BY NAME here, and the browser half — where consumers write
 * `ctx.slots` and expect it to mean the browser's — keeps the ambient types.
 */
export interface PlughubContext {
  webServer: WebServerLike
  /** The include-rooted base URL; `file://<profileDir>/` under `dsh --profile`. */
  baseUrl?: string
  /**
   * Hold a disposable for as long as the plugin is mounted.
   * @param setup - produces the disposer.
   * @param label - what the effect owns, for diagnostics.
   */
  effect: (setup: () => () => void, label?: string) => void
  /**
   * Run `callback` while every named service is available.
   * @param deps - service names.
   * @param callback - receives a context scoped to their availability.
   */
  inject: (deps: string[], callback: (ctx: PlughubContext) => void) => void
  /**
   * Observe a runtime event.
   * @param event - the event name.
   * @param listener - invoked with the event's arguments.
   * @returns the disposer removing the listener.
   */
  on: (event: string, listener: (...args: never[]) => void) => () => void
  /**
   * Resolve one service by name.
   * @param serviceName - the service name.
   * @returns the service, or undefined when nothing provides it.
   */
  get: (serviceName: string) => unknown
  logger?: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void }
}

/** Answer one JSON request. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/**
 * Read one request body, bounded so a runaway upload cannot hold memory.
 * @param req - the request to drain.
 * @param limit - the largest body accepted, in bytes.
 * @returns the body, or undefined when it exceeded the limit.
 */
export async function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<string | undefined> {
  let body = ''
  for await (const chunk of req) {
    body += String(chunk)
    if (body.length > limit) return undefined
  }
  return body
}

/** Whether a request asks the catalog to be resolved afresh. */
function wantsRefresh(req: IncomingMessage): boolean {
  // The base is a placeholder: `req.url` on a server is origin-relative, and
  // `URL` needs one to parse against. Nothing reads the host back.
  return new URL(req.url ?? '/', 'http://plughub.invalid').searchParams.get('refresh') === '1'
}

/** One connected event-stream subscriber. */
interface Subscriber {
  send: (event: PlughubEvent) => void
}

/**
 * Serve this profile's plugin hub.
 * @param ctx - the host context carrying the webserver.
 * @param entry - the composition's configuration for this row.
 */
export function apply(ctx: PlughubContext, entry: Partial<PlughubConfig> = {}): void {
  const home = resolveHome()
  const composed = Config(entry as never)

  let profile: ResolvedProfile | undefined
  let profileError: string | undefined
  try {
    profile = resolveProfile({
      configuredDir: composed.profileDir,
      baseUrl: ctx.baseUrl,
      home,
    })
  } catch (error) {
    // Not fatal. A runtime that did not boot from a profile still gets the
    // panel; every route simply reports why it cannot act, which is far more
    // useful than a plugin that refuses to mount.
    if (!(error instanceof ProfileResolutionError)) throw error
    profileError = error.message
    ctx.logger?.warn('omdsh-plughub: %s', error.message)
  }

  // The launcher composed the tree from this list; anything else on disk later
  // is drift only a restart can settle.
  const bootBundles = profile === undefined ? [] : readProfileManifest(profile.dir).bundles

  /** The active configuration: the settings layer while one is attached, else the entry. */
  let current: () => PlughubConfig = () => composed

  const catalog = new Catalog(
    catalogOptions({
      upstream: composed.upstream,
      registryUrl: composed.registryUrl,
      localSources: composed.localSources,
      githubToken: composed.githubToken === '' ? undefined : composed.githubToken,
      maxRepos: composed.maxRepos,
      timeoutMs: composed.timeoutMs,
    }),
    // The global fetch satisfies FetchLike structurally.
    (url, init) => fetch(url, init),
    composed.cacheTtlMs,
  )

  const subscribers = new Set<Subscriber>()
  const operations: OperationState[] = []

  /** The current profile manifest, re-read per request: another terminal may have written it. */
  const manifest = (): ReturnType<typeof readProfileManifest> =>
    profile === undefined ? { bundles: [] } : readProfileManifest(profile.dir)

  /**
   * Whether an update has landed in this runtime.
   *
   * Tracked separately because {@link isRestartRequired} compares bundle
   * LISTS, and an update changes no list — the same package name, a different
   * package behind it. Without this latch the one operation that swaps running
   * code out from under the process is the one that never asks for a restart.
   */
  let updated = false

  const restartRequired = (): boolean => updated || isRestartRequired(bootBundles, manifest().bundles)

  /**
   * What the profile holds, keyed by package name: the version on disk and the
   * dependency specifier that records how it got there. Both are what the
   * catalog compares against to decide whether an update exists, and both are
   * re-read per request because either can change under another terminal.
   */
  const installedFacts = (): Map<string, InstalledFacts> => {
    if (profile === undefined) return new Map()
    const current = manifest()
    const dependencies = current.dependencies ?? {}
    return new Map(listInstalled(profile.dir, current).map(entry => [entry.name, {
      version: entry.version,
      spec: dependencies[entry.name],
    }]))
  }

  const publish = (event: PlughubEvent): void => {
    for (const subscriber of subscribers) subscriber.send(event)
  }

  const installer = profile === undefined ? undefined : new Installer({
    profileDir: profile.dir,
    profileName: profile.name,
    home,
    launcher: () => {
      const configured = current().launcher
      return configured === '' ? undefined : configured
    },
    pnpm: () => {
      const configured = current().pnpmPath
      return configured === '' ? undefined : configured
    },
  }, (operation) => {
    const index = operations.findIndex(candidate => candidate.id === operation.id)
    if (index === -1) operations.push(operation)
    else operations[index] = operation
    // A settled operation changed what is installed, so the next catalog read
    // must not answer from a resolution taken before it.
    if (operation.status !== 'running') catalog.invalidate()
    // Conservative on purpose: an update that fetched the same version needed
    // no restart, and this runtime cannot tell which one it just ran. Asking
    // for a restart that turns out to be unnecessary costs a restart; not
    // asking costs a person running code they believe they replaced.
    if (operation.kind === 'update' && operation.status === 'ok') updated = true
    publish({ kind: 'operation', operation, restartRequired: restartRequired() })
  })

  /**
   * The pair a write route needs, or undefined after answering 503 itself.
   * Returned rather than asserted so the routes below narrow honestly.
   */
  const writable = (res: ServerResponse): { profile: ResolvedProfile; installer: Installer } | undefined => {
    if (profile !== undefined && installer !== undefined) return { profile, installer }
    sendJson(res, 503, { error: profileError ?? 'omdsh-plughub: no profile resolved' })
    return undefined
  }

  const trustedHosts = (): readonly string[] =>
    (ctx.get('webRuntime') as WebRuntimeTrust | undefined)?.trustedHosts ?? []

  /** Guard a read route; answers 403 itself when the request is not ours. */
  const guardRead = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (isTrustedRequest(req, trustedHosts())) return true
    sendJson(res, 403, { error: 'forbidden' })
    return false
  }

  /**
   * Guard a write route: loopback only, whatever `--trusted-host` says.
   * @param req - the request.
   * @param res - the response, answered here when the request is refused.
   * @param what - what the caller was trying to change, for the refusal.
   * @returns whether the request may proceed.
   */
  const guardWrite = (req: IncomingMessage, res: ServerResponse, what: string): boolean => {
    if (isLoopbackRequest(req)) return true
    sendJson(res, 403, {
      error: `${what} changes this machine, so it is reachable from this machine only — `
        + 'a deployment publishing /api to a network did not consent to that',
    })
    return false
  }

  /** Read one string field out of a JSON request body. */
  const readField = async (
    req: IncomingMessage,
    res: ServerResponse,
    field: string,
  ): Promise<string | undefined> => {
    const body = await readBody(req)
    if (body === undefined) {
      sendJson(res, 413, { error: 'the request body is too large' })
      return undefined
    }
    let value: unknown
    try {
      value = (JSON.parse(body) as Record<string, unknown>)[field]
    } catch {
      sendJson(res, 400, { error: 'the request is not JSON' })
      return undefined
    }
    if (typeof value !== 'string' || value === '') {
      sendJson(res, 400, { error: `the request names a ${field}` })
      return undefined
    }
    return value
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CATALOG_PATH,
    handler: async (req, res) => {
      if (!guardRead(req, res)) return
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'the catalog is read with GET' })
        return
      }
      let document: CatalogDocument
      try {
        document = await catalog.document(installedFacts(), wantsRefresh(req))
      } catch (error) {
        // Every source contains its own failure, so reaching here means the
        // merge itself broke — a bug, not an unreachable upstream.
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      sendJson(res, 200, document)
    },
  }), 'omdsh-plughub: catalog route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: INSTALLED_PATH,
    handler: (req, res) => {
      if (!guardRead(req, res)) return
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'the installed list is read with GET' })
        return
      }
      if (profile === undefined) {
        sendJson(res, 503, { error: profileError ?? 'omdsh-plughub: no profile resolved' })
        return
      }
      const document: InstalledDocument = {
        profile: profile.name,
        entries: listInstalled(profile.dir, manifest()),
        restartRequired: restartRequired(),
      }
      sendJson(res, 200, document)
    },
  }), 'omdsh-plughub: installed route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: INSTALL_PATH,
    handler: async (req, res) => {
      if (!guardWrite(req, res, 'installing a plugin')) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'an install is posted' })
        return
      }
      const ready = writable(res)
      if (ready === undefined) return
      const id = await readField(req, res, 'id')
      if (id === undefined) return
      const merged = await catalog.specFor(id)
      if (merged === undefined) {
        // The catalog is the allowlist, and this is where that is enforced:
        // a name the configured sources did not offer has no specifier here,
        // so there is nothing to run.
        sendJson(res, 404, { error: `the catalog offers no plugin named ${JSON.stringify(id)}` })
        return
      }
      if (manifest().bundles.includes(merged.entry.name)) {
        sendJson(res, 409, { error: `${merged.entry.name} is already installed` })
        return
      }
      sendJson(res, 202, { operation: ready.installer.install(merged.entry.name, merged.entry.spec) })
    },
  }), 'omdsh-plughub: install route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: UPDATE_PATH,
    handler: async (req, res) => {
      if (!guardWrite(req, res, 'updating a plugin')) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'an update is posted' })
        return
      }
      const ready = writable(res)
      if (ready === undefined) return
      const target = await readField(req, res, 'name')
      if (target === undefined) return
      // Installed FIRST: updating something this profile does not have is an
      // install wearing the wrong name, and the two routes have opposite
      // preconditions on purpose.
      if (!manifest().bundles.includes(target)) {
        sendJson(res, 409, { error: `${target} is not installed in this profile` })
        return
      }
      const merged = await catalog.specFor(target)
      if (merged === undefined) {
        // The same allowlist the install route enforces: an update runs `add`
        // against a specifier, and a specifier only ever comes from the
        // catalog this Host resolved.
        sendJson(res, 404, {
          error: `the catalog offers no plugin named ${JSON.stringify(target)}, so there is nothing to update it from`,
        })
        return
      }
      sendJson(res, 202, { operation: ready.installer.update(merged.entry.name, merged.entry.spec) })
    },
  }), 'omdsh-plughub: update route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: UNINSTALL_PATH,
    handler: async (req, res) => {
      if (!guardWrite(req, res, 'removing a plugin')) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'a removal is posted' })
        return
      }
      const ready = writable(res)
      if (ready === undefined) return
      const target = await readField(req, res, 'name')
      if (target === undefined) return
      const entry = listInstalled(ready.profile.dir, manifest()).find(candidate => candidate.name === target)
      if (entry === undefined) {
        sendJson(res, 404, { error: `${target} is not installed in this profile` })
        return
      }
      if (!entry.removable) {
        // A template bundle is not a dependency, so `pnpm remove` would report
        // success and change nothing — worse than refusing.
        sendJson(res, 409, {
          error: `${target} came with the profile rather than as a dependency, so it cannot be removed from here`,
        })
        return
      }
      sendJson(res, 202, { operation: ready.installer.uninstall(target) })
    },
  }), 'omdsh-plughub: uninstall route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SETTINGS_PATH,
    handler: async (req, res) => {
      const settings = ctx.get('settings') as SettingsLike | undefined
      if (settings === undefined) {
        sendJson(res, 503, { error: 'this deployment composes no settings provider' })
        return
      }
      // Ownership is read per request, from the manifests: a plugin installed
      // a moment ago is configurable a moment later, without a restart of
      // anything but the plugin whose settings it holds.
      const owned = ownedNamespaces(profile === undefined ? [] : listInstalled(profile.dir, manifest()))
      if (req.method === 'GET') {
        if (!guardRead(req, res)) return
        sendJson(res, 200, describeOwned(settings, owned))
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'settings are read with GET and written with POST' })
        return
      }
      // A settings write is a Host write, held to the same bar as an install.
      if (!guardWrite(req, res, 'changing a plugin\'s settings')) return
      const body = await readBody(req)
      if (body === undefined) {
        sendJson(res, 413, { error: 'the request body is too large' })
        return
      }
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(body) as Record<string, unknown>
      } catch {
        sendJson(res, 400, { error: 'the request is not JSON' })
        return
      }
      const ns = payload['ns']
      const ops = readOps(payload['ops'])
      if (typeof ns !== 'string' || ns === '' || ops === undefined) {
        sendJson(res, 400, { error: 'a settings write names a namespace and a non-empty list of path ops' })
        return
      }
      const revision = payload['expectedRevision']
      const result = await writeOwned(settings, owned, {
        ns,
        ops,
        expectedRevision: typeof revision === 'number' ? revision : undefined,
      })
      switch (result.status) {
        case 'not-owned':
          sendJson(res, 403, { error: `no installed plugin declares the settings namespace ${JSON.stringify(ns)}` })
          return
        case 'conflict':
          // Distinct from a rejection because the caller recovers by
          // re-reading rather than by telling somebody.
          sendJson(res, 409, { error: result.message })
          return
        case 'rejected':
          sendJson(res, 400, { error: result.message })
          return
        default:
          sendJson(res, 200, { namespace: result.namespace })
      }
    },
  }), 'omdsh-plughub: settings route')

  // A commit from anywhere — this panel, another tab, the document edited by
  // hand — reaches every open panel. Without it, two panels disagree until one
  // of them is reopened.
  ctx.effect(() => ctx.on('settings/document-updated', ((ns: string) => {
    publish({ kind: 'settings', ns })
  }) as (...args: never[]) => void), 'omdsh-plughub: settings invalidations')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: EVENTS_PATH,
    handler: (req, res) => {
      if (!guardRead(req, res)) return
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'the event stream is read with GET' })
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const subscriber: Subscriber = {
        send: (event) => { res.write(`data: ${JSON.stringify(event)}\n\n`) },
      }
      subscribers.add(subscriber)
      // Published on connect rather than waited for: a page that opened while
      // an install was already running must see it, and a page that opened
      // after one finished must see the restart flag.
      subscriber.send({ kind: 'snapshot', operations: [...operations], restartRequired: restartRequired() })
      req.on('close', () => { subscribers.delete(subscriber) })
    },
  }), 'omdsh-plughub: event stream')

  // This plugin's own configuration, by the convention it asks of every other
  // plugin: the composition entry is the `base` layer, the user layer sits on
  // top, and a change re-points the catalog at the new sources at once. The
  // registration rides a scoped fiber, so a composition with no settings
  // provider simply runs on the entry config.
  ctx.inject(['settings'], (sctx) => {
    const settings = sctx.get('settings') as SettingsLike | undefined
    if (settings === undefined) {
      // Reachable when the name is provided by a fiber that is not active, so
      // saying so beats a panel that reports this plugin as having nothing to
      // configure — which is what an unregistered namespace looks like.
      ctx.logger?.warn('omdsh-plughub: no settings service resolved; this plugin will not be configurable')
      return
    }
    let scope: SettingsScopeLike<PlughubConfig>
    try {
      scope = settings.register<PlughubConfig>(SETTINGS_NAMESPACE, Config, {
        base: entry as Partial<PlughubConfig>,
        applies: 'live',
      })
    } catch (error) {
      // A registration failure is contained here rather than taken to the
      // fiber: the routes above are the plugin's real work and they do not
      // depend on this. The panel then shows this one plugin as
      // unconfigurable, and the log says why.
      ctx.logger?.warn('omdsh-plughub: could not register the "%s" settings namespace', SETTINGS_NAMESPACE)
      ctx.logger?.warn(error)
      return
    }
    ctx.logger?.info('omdsh-plughub: registered the "%s" settings namespace', SETTINGS_NAMESPACE)
    current = () => scope.get()
    const adopt = (): void => {
      const next = current()
      catalog.reconfigure(catalogOptions({
        upstream: next.upstream,
        registryUrl: next.registryUrl,
        localSources: next.localSources,
        githubToken: next.githubToken === '' ? undefined : next.githubToken,
        maxRepos: next.maxRepos,
        timeoutMs: next.timeoutMs,
      }))
    }
    adopt()
    sctx.effect(() => scope.watch(() => { adopt() }), 'omdsh-plughub: settings adoption')
  })

  ctx.effect(() => () => {
    for (const subscriber of subscribers) subscriber.send({ kind: 'snapshot', operations: [], restartRequired: false })
    subscribers.clear()
    // A queued install is still going to write this profile; unmounting the
    // plugin does not un-write it, and abandoning the promise would leave an
    // unhandled rejection behind.
    void installer?.drain().catch(() => undefined)
  }, 'omdsh-plughub: retract the streams on unmount')
}

// No default export, deliberately. The Loader prefers a module's `default`
// when it has one and reads `inject` off THAT — so exporting the bare `apply`
// function as the default silently discards the named `inject` list, and the
// plugin dies on `cannot get property "webServer" without inject`. The named
// exports are the plugin, exactly as in every sibling package here.
