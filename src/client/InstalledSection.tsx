/**
 * The lower region: what this profile has, and how to configure it.
 *
 * Each installed plugin gets a row that expands into its configuration. That
 * configuration is drawn from the plugin's own settings schema, so this
 * component knows nothing about any particular plugin's fields — and a plugin
 * that registered no namespace says so, which is a meaningful answer rather
 * than an empty box.
 *
 * A plugin that registered a bespoke card in `omdsh.plugin.card` gets that
 * INSTEAD of the generic form; see `slot-contract.ts` for why the seat exists.
 * @module @omdsh-plugins/omdsh-plughub/client/InstalledSection
 */

import { useState, type ReactNode } from 'react'
import { IconChevronDownOutline14, IconSettingsOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InstalledEntry, SettingsNamespaceView } from '../contract.ts'
import { SchemaForm, type SchemaFormLabels } from './schema-form/SchemaForm.tsx'
import { resolveText, resolveTitle } from './text.ts'
import type { Translate } from './CatalogSection.tsx'
import css from './Panel.module.css'

/** Props of the installed region. */
export interface InstalledSectionProps {
  readonly entries: readonly InstalledEntry[]
  readonly locale: string
  readonly t: Translate
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
  /** The last write failure, when there is one to report. */
  readonly notice?: string | undefined
}

/** One installed plugin's expandable row. */
function InstalledCard({
  entry, locale, t, labels, writable, views, hoisted, card, onSet, onUnset,
}: {
  entry: InstalledEntry
  locale: string
  t: Translate
  labels: SchemaFormLabels
  writable: boolean
  views: readonly SettingsNamespaceView[]
  hoisted: ReadonlySet<string>
  card: ReactNode | undefined
  onSet: (ns: string, path: readonly string[], value: unknown) => void
  onUnset: (ns: string, path: readonly string[]) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const title = resolveTitle(entry.metadata.displayName, locale, entry.name)
  const summary = resolveText(entry.metadata.summary, locale) ?? entry.description
  const shown = views.filter(view => !hoisted.has(view.ns))
  // A plugin whose only namespace moved elsewhere is configurable; it is just
  // not configurable HERE. Saying "declares nothing to configure" would be the
  // one wrong answer, so the two empties are distinguished.
  const elsewhere = shown.length === 0 && views.length > 0
  const configurable = card !== undefined || views.length > 0
  const needsRestart = shown.some(view => view.applies === 'restart')
  const detailId = `plughub-${entry.name.replace(/[^a-zA-Z0-9]/g, '-')}`
  return (
    <li className={css.card} data-plugin={entry.name} data-configurable={configurable ? 'true' : 'false'}>
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
            {entry.version === undefined ? null : <span className={css.version}>{entry.version}</span>}
            {entry.removable ? null : <span className={css.sourceTag}>{t('builtIn')}</span>}
            {needsRestart ? <span className={css.sourceTag}>{t('appliesRestart')}</span> : null}
          </span>
        </span>
        <IconChevronDownOutline14
          className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron}
          aria-hidden="true"
        />
      </button>
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
  const { entries, locale, t } = props
  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('installedHeading')}</h3>
        <span className={css.count} data-installed-count={entries.length}>{entries.length}</span>
      </div>
      {props.notice === undefined ? null : <p className={css.sourceFailure} role="alert">{props.notice}</p>}
      {entries.length === 0 ? <p className={css.status}>{t('installedEmpty')}</p> : (
        <ul className={css.cards}>
          {entries.map(entry => (
            <InstalledCard
              key={entry.name}
              entry={entry}
              locale={locale}
              t={t}
              labels={props.labels}
              writable={props.writable}
              views={props.namespacesFor(entry)}
              hoisted={props.hoisted}
              card={props.cardFor(entry)}
              onSet={props.onSet}
              onUnset={props.onUnset}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
