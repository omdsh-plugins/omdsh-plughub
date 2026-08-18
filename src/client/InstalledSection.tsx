/**
 * The lower region: what this profile has, how to configure it, and how to
 * take one out.
 *
 * Each installed plugin gets a row that expands into its configuration. That
 * configuration is drawn from the plugin's own settings schema, so this
 * component knows nothing about any particular plugin's fields — and a plugin
 * that registered no namespace says so, which is a meaningful answer rather
 * than an empty box.
 *
 * A plugin that registered a bespoke card in `omdsh.plugin.card` gets that
 * INSTEAD of the generic form; see `slot-contract.ts` for why the seat exists.
 *
 * Update, Enable/Disable and Remove sit on the row itself, not only inside
 * the expansion: an installed plugin that is not on offer above has nowhere
 * else to go, and one that is should not need scrolling back to Available.
 * Update is on every row, the same control Available draws — highlighted when
 * a newer version is on offer, otherwise present so the hover still says
 * current, linked, or unknown. Disable leaves the package on disk, so using
 * it again is Enable rather than another install. Built-in profile bundles
 * stay without Remove — `removable` is already false for those, which is the
 * same rule the Host uses. The hub and the mode system can be updated, and
 * cannot be disabled or removed from here.
 * @module @omdsh-plugins/omdsh-plughub/client/InstalledSection
 */

import { useState, type ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconPauseOutline16, IconPlayOutline16,
  IconRefreshOutline16, IconSettingsOutline14, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InstalledEntry, OperationState, SettingsNamespaceView, UpdateState } from '../contract.ts'
import { versionLabel } from '../version.ts'
import { ActionButton } from './ActionButton.tsx'
import { SchemaForm, type SchemaFormLabels } from './schema-form/SchemaForm.tsx'
import { compareByTitle, matches, resolveText, resolveTitle } from './text.ts'
import { UPDATE_KEY, type Translate } from './CatalogSection.tsx'
import css from './Panel.module.css'

/** Props of the installed region. */
export interface InstalledSectionProps {
  readonly entries: readonly InstalledEntry[]
  readonly locale: string
  readonly t: Translate
  /** The tab's search needle; the same one Available filters by. */
  readonly query: string
  readonly labels: SchemaFormLabels
  /** Whether the settings provider accepts writes. */
  readonly writable: boolean
  /** The namespaces one plugin owns that the Host has actually registered. */
  readonly namespacesFor: (entry: InstalledEntry) => readonly SettingsNamespaceView[]
  /**
   * Namespaces another region of this tab already draws, and that a card here
   * must therefore not draw again.
   *
   * Only the hub's own is hoisted today (into Catalog sources, where it acts),
   * but the prop is a set rather than that one name: a card whose namespace
   * has been moved says where it went, and that sentence is right for any of
   * them.
   */
  readonly hoisted: ReadonlySet<string>
  /** A bespoke card registered for this plugin, when one was. */
  readonly cardFor: (entry: InstalledEntry) => ReactNode | undefined
  readonly onSet: (ns: string, path: readonly string[], value: unknown) => void
  readonly onUnset: (ns: string, path: readonly string[]) => void
  /**
   * Whether writes are reachable from this browser at all (loopback-only
   * routes). Separate from {@link writable}: settings may be readable when
   * an uninstall is not.
   */
  readonly canWrite: boolean
  readonly operationFor: (name: string) => OperationState | undefined
  readonly onUninstall: (name: string) => void
  readonly onSetEnabled: (name: string, enabled: boolean) => void
  /**
   * What the catalog says about an installed name: whether a newer version
   * is on offer. Absent when the catalog does not list it; the row still
   * draws Update, in the unknown state, so every installed package has one.
   */
  readonly offeredFor: (name: string) => InstalledOffer | undefined
  readonly onUpdate: (name: string) => void
  /** The last write failure, when there is one to report. */
  readonly notice?: string | undefined
}

/** The catalog half of one installed row: enough to style Update. */
export interface InstalledOffer {
  readonly update?: UpdateState
  readonly version?: string
  readonly installedVersion?: string
}

/** One installed plugin's expandable row. */
function InstalledCard({
  entry, locale, t, labels, writable, canWrite, operation, views, hoisted, card,
  offered, onSet, onUnset, onUninstall, onSetEnabled, onUpdate,
}: {
  entry: InstalledEntry
  locale: string
  t: Translate
  labels: SchemaFormLabels
  writable: boolean
  canWrite: boolean
  operation: OperationState | undefined
  views: readonly SettingsNamespaceView[]
  hoisted: ReadonlySet<string>
  card: ReactNode | undefined
  offered: InstalledOffer | undefined
  onSet: (ns: string, path: readonly string[], value: unknown) => void
  onUnset: (ns: string, path: readonly string[]) => void
  onUninstall: () => void
  onSetEnabled: () => void
  onUpdate: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const title = resolveTitle(entry.metadata.displayName, locale, entry.name)
  const summary = resolveText(entry.metadata.summary, locale) ?? entry.description
  const shown = views.filter(view => !hoisted.has(view.ns))
  // A plugin whose only namespace moved elsewhere is configurable; it is just
  // not configurable HERE. Saying "declares nothing to configure" would be the
  // one wrong answer, so the two empties are distinguished.
  const elsewhere = shown.length === 0 && views.length > 0
  const configurable = card !== undefined || views.length > 0
  const needsRestart = shown.some(view => view.applies === 'restart')
  const running = operation?.status === 'running'
  const update = offered?.update ?? 'unknown'
  const updatable = update === 'available'
  const rowKind = operation?.kind === 'uninstall' || operation?.kind === 'enable'
    || operation?.kind === 'disable' || operation?.kind === 'update'
  const failed = operation?.status === 'failed' && rowKind
  const failureKey = operation?.kind === 'enable'
    ? 'enableFailed'
    : operation?.kind === 'disable'
      ? 'disableFailed'
      : operation?.kind === 'update'
        ? 'updateFailed'
        : 'uninstallFailed'
  const installedVersion = offered?.installedVersion ?? entry.version
  const version = versionLabel({
    update,
    ...offered?.version === undefined ? {} : { version: offered.version },
    ...installedVersion === undefined ? {} : { installedVersion },
  })
  const detailId = `plughub-${entry.name.replace(/[^a-zA-Z0-9]/g, '-')}`
  return (
    <li
      className={css.card}
      data-plugin={entry.name}
      data-configurable={configurable ? 'true' : 'false'}
      data-removable={entry.removable ? 'true' : 'false'}
      data-enabled={entry.enabled ? 'true' : 'false'}
      data-toggleable={entry.toggleable ? 'true' : 'false'}
      data-update={update}
    >
      <div className={css.cardHead}>
        <button
          type="button"
          className={css.cardToggle}
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconSettingsOutline14 className={css.cardIcon} aria-hidden="true" />
          <span className={css.cardTitleBlock}>
            <strong className={css.cardTitle} title={entry.name}>{title}</strong>
            <span className={css.cardMeta}>
              <code className={css.cardName}>{entry.name}</code>
              {version === undefined
                ? null
                : <span className={updatable ? `${css.version} ${css.versionNew}` : css.version}>{version}</span>}
              {entry.removable ? null : <span className={css.sourceTag}>{t('builtIn')}</span>}
              {entry.enabled ? null : <span className={css.sourceTag}>{t('disabledTag')}</span>}
              {needsRestart ? <span className={css.sourceTag}>{t('appliesRestart')}</span> : null}
            </span>
          </span>
          <IconChevronDownOutline14
            className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron}
            aria-hidden="true"
          />
        </button>
        <div className={css.cardActions}>
          <ActionButton
            variant={updatable ? 'primary' : 'ghost'}
            disabled={!canWrite || running || !updatable}
            icon={<IconRefreshOutline16 aria-hidden="true" />}
            label={running && operation?.kind === 'update'
              ? t('updating')
              : t(UPDATE_KEY[update], {
                version: offered?.version ?? '',
                installed: offered?.installedVersion ?? entry.version ?? '',
              })}
            onClick={onUpdate}
          />
          {entry.toggleable ? (
            <ActionButton
              disabled={!canWrite || running}
              icon={entry.enabled
                ? <IconPauseOutline16 aria-hidden="true" />
                : <IconPlayOutline16 aria-hidden="true" />}
              label={running && operation?.kind === 'enable'
                ? t('enabling')
                : running && operation?.kind === 'disable'
                  ? t('disabling')
                  : entry.enabled ? t('disable') : t('enable')}
              onClick={onSetEnabled}
            />
          ) : null}
          {entry.removable ? (
            <ActionButton
              disabled={!canWrite || running}
              icon={<IconTrashOutline16 aria-hidden="true" />}
              label={running && operation?.kind === 'uninstall' ? t('uninstalling') : t('uninstall')}
              onClick={onUninstall}
            />
          ) : null}
        </div>
      </div>
      {failed ? (
        <div className={css.failure} role="alert">
          <span>
            {t(failureKey)}
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
      {open ? (
        <div className={css.cardBody} id={detailId}>
          {summary === undefined ? null : <p className={css.cardSummary}>{summary}</p>}
          {card ?? (shown.length === 0
            ? <p className={css.status}>{t(elsewhere ? 'configuredAbove' : 'noSettings')}</p>
            : shown.map(view => (
              <SchemaForm
                key={view.ns}
                view={view}
                locale={locale}
                writable={writable}
                labels={labels}
                onSet={(path, value) => { onSet(view.ns, path, value) }}
                onUnset={(path) => { onUnset(view.ns, path) }}
              />
            )))}
        </div>
      ) : null}
    </li>
  )
}

/**
 * Render the installed region.
 * @param props - the entries and everything a card needs to configure one.
 * @returns the region.
 */
export function InstalledSection(props: InstalledSectionProps): ReactNode {
  const { entries, locale, t, query } = props
  const needle = query.trim().toLocaleLowerCase()
  const visible = entries
    .filter(entry => matches(entry, needle, locale))
    .sort((a, b) => compareByTitle(a, b, locale))
  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('installedHeading')}</h3>
        <span className={css.count} data-installed-count={visible.length}>{visible.length}</span>
      </div>
      {props.notice === undefined ? null : <p className={css.sourceFailure} role="alert">{props.notice}</p>}
      {entries.length === 0 ? <p className={css.status}>{t('installedEmpty')}</p> : null}
      {entries.length > 0 && visible.length === 0 ? <p className={css.status}>{t('installedEmptySearch')}</p> : null}
      {visible.length === 0 ? null : (
        <ul className={css.cards}>
          {visible.map(entry => (
            <InstalledCard
              key={entry.name}
              entry={entry}
              locale={locale}
              t={t}
              labels={props.labels}
              writable={props.writable}
              canWrite={props.canWrite}
              operation={props.operationFor(entry.name)}
              views={props.namespacesFor(entry)}
              hoisted={props.hoisted}
              card={props.cardFor(entry)}
              offered={props.offeredFor(entry.name)}
              onSet={props.onSet}
              onUnset={props.onUnset}
              onUninstall={() => { props.onUninstall(entry.name) }}
              onSetEnabled={() => { props.onSetEnabled(entry.name, !entry.enabled) }}
              onUpdate={() => { props.onUpdate(entry.name) }}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
