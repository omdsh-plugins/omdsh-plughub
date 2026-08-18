/**
 * The upper region: what can be installed, and the one button that does it.
 *
 * A card's title, summary, and documentation link are the PLUGIN's — read from
 * its `dsh.plughub` manifest section, resolved for the active locale. Nothing
 * about a specific plugin is written down here, which is what lets a plugin
 * published tomorrow show up correctly today.
 * @module @omdsh-plugins/omdsh-plughub/client/CatalogSection
 */

import { useState, type ReactNode } from 'react'
import {
  Button, IconDownloadOutline16, IconLinkOutline14, IconRefreshOutline16,
  IconSearchOutline16, Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CatalogEntry, CatalogSource, CatalogSourceReport, OperationKind, OperationState, UpdateState,
} from '../contract.ts'
import { versionLabel } from '../version.ts'
import { ActionButton } from './ActionButton.tsx'
import { compareByTitle, matches, resolveText, resolveTitle } from './text.ts'
import type { PlughubLocaleKey } from './locales.ts'
import css from './Panel.module.css'

/** Translate one dictionary key. */
export type Translate = (key: PlughubLocaleKey, params?: Record<string, string>) => string

/** Props of the catalog region. */
export interface CatalogSectionProps {
  readonly entries: readonly CatalogEntry[]
  readonly sources: readonly CatalogSourceReport[]
  readonly locale: string
  readonly t: Translate
  /** The tab's search needle; filters this list and the installed list together. */
  readonly query: string
  readonly onQuery: (query: string) => void
  readonly onRefresh: () => void
  readonly refreshing: boolean
  /** Whether writes are reachable from this browser at all (loopback-only routes). */
  readonly writable: boolean
  readonly operationFor: (name: string) => OperationState | undefined
  readonly onInstall: (name: string) => void
  readonly onUpdate: (name: string) => void
}

/** The dictionary key naming one source. */
const SOURCE_KEY: Record<CatalogSource, PlughubLocaleKey> = {
  local: 'sourceLocal',
  registry: 'sourceRegistry',
  github: 'sourceGithub',
}

/** The dictionary key naming one operation's failure. */
const FAILURE_KEY: Record<OperationKind, PlughubLocaleKey> = {
  install: 'installFailed',
  uninstall: 'uninstallFailed',
  update: 'updateFailed',
  enable: 'enableFailed',
  disable: 'disableFailed',
}

/** The dictionary key explaining one update state, on the button's tooltip. */
export const UPDATE_KEY: Record<UpdateState, PlughubLocaleKey> = {
  available: 'updateAvailable',
  current: 'updateCurrent',
  linked: 'updateLinked',
  unknown: 'updateUnknown',
}

/** One plugin's card. */
function CatalogCard({
  entry, locale, t, writable, operation, onInstall, onUpdate,
}: {
  entry: CatalogEntry
  locale: string
  t: Translate
  writable: boolean
  operation: OperationState | undefined
  onInstall: () => void
  onUpdate: () => void
}): ReactNode {
  const [showLog, setShowLog] = useState(false)
  const title = resolveTitle(entry.metadata.displayName, locale, entry.name)
  const summary = resolveText(entry.metadata.summary, locale) ?? entry.description
  const running = operation?.status === 'running'
  // Only this card's own verbs: a Remove on Installed must not draw its
  // failure here as well.
  const ownKind = operation?.kind === 'install' || operation?.kind === 'update'
  const failed = operation?.status === 'failed' && ownKind
  const docs = entry.metadata.docs ?? (entry.repo === undefined ? undefined : `https://github.com/${entry.repo}`)
  const update = entry.update ?? 'unknown'
  const updatable = update === 'available'
  const version = versionLabel(entry)
  return (
    <li
      className={css.card}
      data-plugin={entry.name}
      data-installed={entry.installed ? 'true' : 'false'}
      {...entry.installed ? { 'data-update': update } : {}}
    >
      <div className={css.cardHead}>
        <div className={css.cardTitleBlock}>
          <strong className={css.cardTitle} title={entry.name}>{title}</strong>
          <span className={css.cardMeta}>
            <code className={css.cardName}>{entry.name}</code>
            {version === undefined
              ? null
              : <span className={updatable ? `${css.version} ${css.versionNew}` : css.version}>{version}</span>}
            <span className={css.sourceTag} data-source={entry.source}>{t(SOURCE_KEY[entry.source])}</span>
            {docs === undefined ? null : (
              <a className={css.docsLink} href={docs} target="_blank" rel="noreferrer noopener">
                <IconLinkOutline14 aria-hidden="true" />
                {t('docs')}
              </a>
            )}
          </span>
        </div>
        <div className={css.cardActions}>
          {entry.installed ? (
            <ActionButton
              variant={updatable ? 'primary' : 'ghost'}
              disabled={!writable || running || !updatable}
              icon={<IconRefreshOutline16 aria-hidden="true" />}
              label={running && operation.kind === 'update'
                ? t('updating')
                : t(UPDATE_KEY[update], {
                  version: entry.version ?? '',
                  installed: entry.installedVersion ?? '',
                })}
              onClick={onUpdate}
            />
          ) : (
            <ActionButton
              variant="primary"
              disabled={!writable || running}
              icon={<IconDownloadOutline16 aria-hidden="true" />}
              label={running && operation.kind === 'install' ? t('installing') : t('install')}
              onClick={onInstall}
            />
          )}
        </div>
      </div>
      {summary === undefined ? null : <p className={css.cardSummary}>{summary}</p>}
      {failed ? (
        <div className={css.failure} role="alert">
          <span>
            {t(FAILURE_KEY[operation.kind])}
            {operation.error === undefined ? '' : `: ${operation.error}`}
          </span>
          {operation.log.length === 0 ? null : (
            <button type="button" className={css.logToggle} onClick={() => { setShowLog(open => !open) }}>
              {showLog ? t('hideLog') : t('showLog')}
            </button>
          )}
        </div>
      ) : null}
      {failed && showLog ? <pre className={css.log}>{operation.log.join('\n')}</pre> : null}
    </li>
  )
}

/**
 * Render the catalog region.
 * @param props - entries, search state, and the write callbacks.
 * @returns the region.
 */
export function CatalogSection(props: CatalogSectionProps): ReactNode {
  const { entries, sources, locale, t, query } = props
  const needle = query.trim().toLocaleLowerCase()
  const visible = entries
    .filter(entry => matches(entry, needle, locale))
    .sort((a, b) => compareByTitle(a, b, locale))
  const broken = sources.filter(source => !source.ok)
  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('catalogHeading')}</h3>
        <span className={css.count} data-catalog-count={visible.length}>{visible.length}</span>
        {/* In the head's own gap rather than on a row of its own. The field
            still filters Installed below — the query is the tab's — but it
            belongs beside the count it visibly changes. */}
        <label className={css.search}>
          <span className={css.visuallyHidden}>{t('search')}</span>
          <Input
            type="search"
            icon={<IconSearchOutline16 aria-hidden="true" />}
            value={query}
            placeholder={t('search')}
            aria-label={t('search')}
            onChange={(event) => { props.onQuery(event.currentTarget.value) }}
          />
        </label>
        <Button
          variant="ghost"
          size="sm"
          disabled={props.refreshing}
          icon={<IconRefreshOutline16 aria-hidden="true" />}
          onClick={props.onRefresh}
        >
          {t('refresh')}
        </Button>
      </div>
      {broken.map(source => (
        // A source that failed is reported rather than hidden: "no plugins
        // here" and "GitHub rate-limited this account" look identical on an
        // empty list, and only one of them resolves itself.
        <p className={css.sourceFailure} key={`${source.source}:${source.origin}`} role="status">
          {t('sourceFailed', { source: t(SOURCE_KEY[source.source]), error: source.error ?? '' })}
        </p>
      ))}
      {entries.length === 0 ? <p className={css.status}>{t('catalogEmpty')}</p> : null}
      {entries.length > 0 && visible.length === 0 ? <p className={css.status}>{t('catalogEmptySearch')}</p> : null}
      {visible.length === 0 ? null : (
        <ul className={css.cards}>
          {visible.map(entry => (
            <CatalogCard
              key={entry.name}
              entry={entry}
              locale={locale}
              t={t}
              writable={props.writable}
              operation={props.operationFor(entry.name)}
              onInstall={() => { props.onInstall(entry.name) }}
              onUpdate={() => { props.onUpdate(entry.name) }}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
