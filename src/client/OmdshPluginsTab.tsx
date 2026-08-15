/**
 * The OMDSH Plugins tab: two regions, one state machine.
 *
 * The tab owns every read and every write, and the regions below it are
 * presentational. That is not tidiness — it is the only place that can order a
 * settings write correctly, because a write carries the revision the read
 * returned and a conflict has to be resolved by re-reading. Split that across
 * two components and the retry loses track of which value it is retrying.
 * @module @omdsh-plugins/omdsh-plughub/client/OmdshPluginsTab
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { HUB_SETTINGS_NAMESPACE } from '../contract.ts'
import type {
  CatalogDocument, InstalledDocument, InstalledEntry, OperationState, PlughubEvent,
  SettingsNamespaceView, SettingsPathOp,
} from '../contract.ts'
import { applyEvent, operationFor } from './hub-source.ts'
import { namespacesFor, EMPTY_SETTINGS, type SettingsSnapshot, type WriteOutcome } from './settings-source.ts'
import { CatalogSection, type Translate } from './CatalogSection.tsx'
import { InstalledSection } from './InstalledSection.tsx'
import { SourcesSection } from './SourcesSection.tsx'
import type { SchemaFormLabels } from './schema-form/SchemaForm.tsx'
import { PLUGIN_CARD_SLOT } from './slot-contract.ts'
import type {} from './slot-contract.ts'
import css from './Panel.module.css'

/** The business face the registration binds for this tab. */
export interface OmdshPluginsTabInjected {
  /** Read the catalog; `refresh` consults every source again. */
  readonly catalog: (refresh: boolean) => Promise<CatalogDocument>
  /** Read what this profile has installed. */
  readonly installed: () => Promise<InstalledDocument>
  /** Read every settings namespace the Host exposes. */
  readonly describeSettings: () => Promise<SettingsSnapshot>
  /** Ask the Host to install one catalog entry. */
  readonly install: (name: string) => Promise<void>
  /** Ask the Host to reinstall one plugin from what the catalog offers now. */
  readonly update: (name: string) => Promise<void>
  /** Ask the Host to remove one installed plugin. */
  readonly uninstall: (name: string) => Promise<void>
  /** Write one settings field. */
  readonly writeSetting: (
    ns: string,
    ops: readonly SettingsPathOp[],
    expectedRevision?: number,
  ) => Promise<WriteOutcome>
  /**
   * Follow the Host's event stream: operation progress, the restart flag, and
   * settings invalidations. One stream rather than two, because the panel
   * reacts to all three the same way — by re-reading.
   */
  readonly subscribeOperations: (listener: (event: PlughubEvent) => void) => () => void
  /** Whether this browser can reach the write routes at all (they are loopback-only). */
  readonly canWrite: boolean
  /** Package names that registered a bespoke configuration card. */
  readonly cardIds: readonly string[]
  /**
   * Read the active locale id.
   *
   * Carried on the inject face rather than read from props: `PropsLocale`
   * supplies a bound `t` and nothing else, and every label on this panel comes
   * from a plugin's own manifest or schema rather than from a dictionary — so
   * the id itself is what this tab needs.
   *
   * A thunk rather than the id, because an inject face is built ONCE per
   * registration and memoized on the entry, while a locale switch re-renders
   * every outlet with a fresh `t`. An id read at registration would leave the
   * chrome translated and every plugin's own title, summary, and field
   * description resolved against whatever language the panel first opened in.
   * The slot system's own `label` thunks exist for the same reason.
   * @returns the active locale id.
   */
  readonly activeLocale: () => string
}

/** Full component props assembled by the settings slot renderer. */
export type OmdshPluginsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plughub'>
  & PropsRenderSlots<'omdsh.plugin.card'>
  & InjectFace<OmdshPluginsTabInjected>

/**
 * Namespaces this tab draws somewhere other than the installed list, so that
 * the installed list does not draw them a second time. The hub's own is the
 * only one: it went up to {@link SourcesSection}, beside the catalog it
 * governs.
 */
const HOISTED: ReadonlySet<string> = new Set([HUB_SETTINGS_NAMESPACE])

/** What the panel has loaded. */
interface Loaded {
  readonly catalog: CatalogDocument
  readonly installed: InstalledDocument
  readonly settings: SettingsSnapshot
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly data: Loaded }

/**
 * Render the tab.
 * @param props - the slot renderer's assembled props.
 * @returns the tab body.
 */
export function OmdshPluginsTab(props: OmdshPluginsTabProps): ReactNode {
  const {
    t, renderSlot,
    catalog, installed, describeSettings, install, update, uninstall, writeSetting,
    subscribeOperations, canWrite, cardIds, activeLocale,
  } = props
  const translate = t as Translate
  // Per render, not per registration: this outlet re-renders on a locale
  // switch, and this read is where the new id arrives.
  const active = activeLocale()

  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [operations, setOperations] = useState<readonly OperationState[]>([])
  const [restartRequired, setRestartRequired] = useState(false)
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [generation, setGeneration] = useState(0)

  /** Re-read everything. Bumped rather than called so concurrent triggers collapse. */
  const reload = useCallback(() => { setGeneration(value => value + 1) }, [])

  useEffect(() => {
    let current = true
    void (async () => {
      try {
        // In parallel: three independent reads, and the panel is useless
        // until it has all three.
        const [catalogDocument, installedDocument, settings] = await Promise.all([
          catalog(false),
          installed(),
          // A settings provider is optional in a composition, and a
          // deployment that is not loopback refuses `settings.describe`
          // outright. Neither is a broken panel — the catalog still works.
          // Reported rather than swallowed: "this plugin declares nothing to
          // configure" and "settings could not be read at all" look identical
          // on screen, and only one of them is the plugin's own doing.
          describeSettings().catch((error: unknown) => {
            console.warn('omdsh-plughub: settings.describe failed; every plugin will read as unconfigurable', error)
            return EMPTY_SETTINGS
          }),
        ])
        if (!current) return
        setRestartRequired(installedDocument.restartRequired)
        setState({ status: 'ready', data: { catalog: catalogDocument, installed: installedDocument, settings } })
      } catch (error) {
        if (!current) return
        setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => { current = false }
  }, [catalog, installed, describeSettings, generation])

  useEffect(() => subscribeOperations((event) => {
    // A commit from anywhere else — another tab, the document edited by hand —
    // is only ever a signal to re-read; the event carries no value, so it
    // cannot be a stale copy of the truth.
    if (event.kind === 'settings') {
      reload()
      return
    }
    setOperations(previous => applyEvent(previous, event))
    setRestartRequired(event.restartRequired)
    // A settled operation changed the profile on disk, so what this panel
    // holds about installed plugins is now stale.
    if (event.kind === 'operation' && event.operation.status !== 'running') reload()
  }), [subscribeOperations, reload])

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    void catalog(true).then(
      (next) => {
        setState(previous => (previous.status === 'ready'
          ? { status: 'ready', data: { ...previous.data, catalog: next } }
          : previous))
      },
      () => undefined,
    ).finally(() => { setRefreshing(false) })
  }, [catalog])

  const onInstall = useCallback((packageName: string) => {
    setNotice(undefined)
    void install(packageName).catch((error: unknown) => {
      setNotice(translate('writeFailed', { error: error instanceof Error ? error.message : String(error) }))
    })
  }, [install, translate])

  const onUpdate = useCallback((packageName: string) => {
    setNotice(undefined)
    void update(packageName).catch((error: unknown) => {
      setNotice(translate('writeFailed', { error: error instanceof Error ? error.message : String(error) }))
    })
  }, [update, translate])

  const onUninstall = useCallback((packageName: string) => {
    setNotice(undefined)
    void uninstall(packageName).catch((error: unknown) => {
      setNotice(translate('writeFailed', { error: error instanceof Error ? error.message : String(error) }))
    })
  }, [uninstall, translate])

  /** Apply one settings edit, resolving a stale revision by re-reading. */
  const write = useCallback((ns: string, ops: readonly SettingsPathOp[]) => {
    setNotice(undefined)
    setState((previous) => {
      if (previous.status !== 'ready') return previous
      const revision = previous.data.settings.namespaces.get(ns)?.revision
      void writeSetting(ns, ops, revision).then((outcome: WriteOutcome) => {
        if (outcome.status === 'ok') {
          // The Host answers with the namespace's new view, so the panel
          // adopts it without a second round trip.
          setState(current => (current.status === 'ready'
            ? { status: 'ready', data: { ...current.data, settings: adopt(current.data.settings, outcome.view) } }
            : current))
          return
        }
        if (outcome.status === 'conflict') setNotice(translate('writeConflict'))
        else setNotice(translate('writeFailed', { error: outcome.message }))
        reload()
      })
      return previous
    })
  }, [writeSetting, translate, reload])

  const onSet = useCallback((ns: string, path: readonly string[], value: unknown) => {
    write(ns, [{ op: 'set', path: [...path], value }])
  }, [write])

  const onUnset = useCallback((ns: string, path: readonly string[]) => {
    write(ns, [{ op: 'unset', path: [...path] }])
  }, [write])

  const labels = useMemo<SchemaFormLabels>(() => ({
    overridden: translate('overridden'),
    reset: translate('reset'),
    resetTitle: translate('resetTitle'),
    unsupportedField: translate('unsupportedField'),
    secretSet: translate('secretSet'),
    secretUnset: translate('secretUnset'),
    addRow: translate('addRow'),
    removeRow: translate('removeRow'),
    keyPlaceholder: translate('keyPlaceholder'),
    valuePlaceholder: translate('valuePlaceholder'),
    docs: translate('docs'),
    noSettings: translate('noSettings'),
    readOnlyProvider: translate('readOnlyProvider'),
  }), [translate])

  const cards = useMemo(() => new Set(cardIds), [cardIds])

  const onSourceSet = useCallback((path: readonly string[], value: unknown) => {
    onSet(HUB_SETTINGS_NAMESPACE, path, value)
  }, [onSet])

  const onSourceUnset = useCallback((path: readonly string[]) => {
    onUnset(HUB_SETTINGS_NAMESPACE, path)
  }, [onUnset])

  if (state.status === 'loading') return <p className={css.status}>{translate('loading')}</p>
  if (state.status === 'error') {
    return (
      <div className={css.failure}>
        <p role="alert">{translate('error')}</p>
        <p className={css.status}>{state.message}</p>
        <button type="button" className={css.logToggle} onClick={reload}>{translate('retry')}</button>
      </div>
    )
  }

  const { data } = state
  // Worth opening the sources region over: nothing came back, or nothing that
  // was consulted answered. Both are questions these fields answer.
  const attention = data.catalog.entries.length === 0
    || (data.catalog.sources.length > 0 && data.catalog.sources.every(source => !source.ok))
  return (
    <div className={css.tab}>
      {restartRequired ? (
        <div className={css.restart} role="status">
          <IconWarningOutline16 aria-hidden="true" />
          <div>
            <strong>{translate('restartTitle')}</strong>
            <p className={css.status}>{translate('restartBody')}</p>
          </div>
        </div>
      ) : null}
      {/* Above the catalog because it decides what the catalog contains: the
          local directories, the upstream account, the manifest URL. It is this
          plugin's OWN settings namespace, hoisted out of the installed list —
          the same schema and the same route, in the place it acts. */}
      <SourcesSection
        view={data.settings.namespaces.get(HUB_SETTINGS_NAMESPACE)}
        locale={active}
        t={translate}
        labels={labels}
        writable={data.settings.writable}
        attention={attention}
        onSet={onSourceSet}
        onUnset={onSourceUnset}
      />
      <CatalogSection
        entries={data.catalog.entries}
        sources={data.catalog.sources}
        locale={active}
        t={translate}
        query={query}
        onQuery={setQuery}
        onRefresh={onRefresh}
        refreshing={refreshing}
        writable={canWrite}
        operationFor={packageName => operationFor(operations, packageName)}
        onInstall={onInstall}
        onUpdate={onUpdate}
        onUninstall={onUninstall}
      />
      <InstalledSection
        entries={data.installed.entries}
        locale={active}
        t={translate}
        labels={labels}
        writable={data.settings.writable}
        namespacesFor={(entry: InstalledEntry) => namespacesFor(entry.metadata.settings, data.settings)}
        hoisted={HOISTED}
        cardFor={(entry: InstalledEntry) => (cards.has(entry.name)
          ? renderSlot(PLUGIN_CARD_SLOT, { writable: data.settings.writable, locale: active }, { only: entry.name })
          : undefined)}
        onSet={onSet}
        onUnset={onUnset}
        notice={notice}
      />
    </div>
  )
}

/**
 * Replace one namespace's view in a snapshot.
 * @param snapshot - the snapshot to update.
 * @param view - the namespace's new view.
 * @returns the next snapshot.
 */
function adopt(snapshot: SettingsSnapshot, view: SettingsNamespaceView): SettingsSnapshot {
  const namespaces = new Map(snapshot.namespaces)
  namespaces.set(view.ns, view)
  return { ...snapshot, namespaces }
}
