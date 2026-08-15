/**
 * The hub's own configuration, put where it acts.
 *
 * ## Why this is not just another card in the installed list
 *
 * It could be, and for a while it was: this plugin registers a settings
 * namespace like any other, so the generic form at the bottom of the page
 * already rendered it. But the fields in that namespace — the local
 * directories, the upstream account, the manifest URL — are not settings ABOUT
 * a plugin somebody installed. They are the answer to "where does this list
 * come from", and the list is directly above them. Somebody looking at an
 * empty catalog, or at `github is unavailable: rate limit exceeded`, is
 * looking at the wrong end of the page for the control that fixes it.
 *
 * So the hub's namespace is hoisted here and the installed list does not draw
 * it twice. Nothing about the mechanism changes: the same schema, the same
 * route, the same revision-checked write. What moved is one region on a page.
 *
 * ## Why it opens itself
 *
 * Only when something is wrong — every configured source failed, or the
 * catalog came back empty. That is the one moment when the fields are what
 * somebody came for, and it happens once per mount so a person who closes it
 * is not argued with.
 * @module @omdsh-plugins/omdsh-plughub/client/SourcesSection
 */

import { useEffect, useState, type ReactNode } from 'react'
import { IconChevronDownOutline14, IconSettingsOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsNamespaceView } from '../contract.ts'
import { SchemaForm, type SchemaFormLabels } from './schema-form/SchemaForm.tsx'
import type { Translate } from './CatalogSection.tsx'
import css from './Panel.module.css'

/** Props of the sources region. */
export interface SourcesSectionProps {
  /** The hub's own namespace view, absent when no settings provider is composed. */
  readonly view: SettingsNamespaceView | undefined
  readonly locale: string
  readonly t: Translate
  readonly labels: SchemaFormLabels
  /** Whether the settings provider accepts writes. */
  readonly writable: boolean
  /**
   * Whether the catalog is in a state these fields would explain — every
   * source failed, or nothing came back. Opens the region once.
   */
  readonly attention: boolean
  readonly onSet: (path: readonly string[], value: unknown) => void
  readonly onUnset: (path: readonly string[]) => void
}

/**
 * Render the hub's own configuration.
 * @param props - the namespace view and the write callbacks.
 * @returns the region.
 */
export function SourcesSection(props: SourcesSectionProps): ReactNode {
  const { view, locale, t, labels, writable, attention, onSet, onUnset } = props
  const [open, setOpen] = useState(false)
  // One shot: `nudged` latches so a person who closes the region does not have
  // it reopened by the next failing refresh.
  const [nudged, setNudged] = useState(false)
  useEffect(() => {
    if (nudged || !attention) return
    setNudged(true)
    setOpen(true)
  }, [attention, nudged])

  return (
    <section className={css.section}>
      <button
        type="button"
        className={css.sourcesToggle}
        aria-expanded={open}
        aria-controls="plughub-sources"
        // Carries the hint in full, since the row keeps it to one line.
        title={t('sourcesHint')}
        onClick={() => { setOpen(value => !value) }}
      >
        <IconSettingsOutline16 className={css.cardIcon} aria-hidden="true" />
        <span className={css.cardTitleBlock}>
          <strong className={css.cardTitle}>{t('sourcesHeading')}</strong>
          <span className={`${css.cardSummary} ${css.sourcesSummary}`}>{t('sourcesHint')}</span>
        </span>
        <IconChevronDownOutline14
          className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className={css.sourcesBody} id="plughub-sources">
          {view === undefined
            ? <p className={css.status}>{t('sourcesUnavailable')}</p>
            : (
              <SchemaForm
                view={view}
                locale={locale}
                writable={writable}
                labels={labels}
                onSet={onSet}
                onUnset={onUnset}
              />
            )}
        </div>
      ) : null}
    </section>
  )
}
