/**
 * One settings namespace, rendered as a form.
 *
 * The schema arrives over the wire as schemastery's own serialized envelope;
 * `rehydrateSchema` turns it back into the SAME validator the Host resolves
 * that namespace with, so what this form draws and what the Host will accept
 * cannot drift. The plan is computed from the rehydrated node tree
 * (`plan.ts`), and everything here is the rendering of that plan.
 * @module @omdsh-plugins/omdsh-plughub/client/schema-form/SchemaForm
 */

import { useMemo, type ReactNode } from 'react'
import { rehydrateSchema } from '@deepseek-ai/dsh-client-schema-form'
import type { SettingsNamespaceView } from '../../contract.ts'
import { isFieldOverridden, isSecretSet } from '../settings-source.ts'
import { Field, GroupHeading, type FieldLabels } from './Fields.tsx'
import { getPath, planSection, type PlanNode, type SchemaNodeLike } from './plan.ts'
import css from './SchemaForm.module.css'

/** What the form needs beyond the field labels. */
export interface SchemaFormLabels extends FieldLabels {
  readonly noSettings: string
  readonly readOnlyProvider: string
}

/** Props of one namespace's form. */
export interface SchemaFormProps {
  readonly view: SettingsNamespaceView
  readonly locale: string
  readonly writable: boolean
  readonly labels: SchemaFormLabels
  /** Write one field. */
  readonly onSet: (path: readonly string[], value: unknown) => void
  /** Drop one field's override. */
  readonly onUnset: (path: readonly string[]) => void
}

/**
 * Rehydrate a served schema envelope, tolerating one this client cannot read.
 *
 * Rehydration reconstructs a live validator, and schemastery revives
 * serialized callbacks through `new Function` — so an envelope this client
 * cannot rehydrate is one it must not try harder on. An empty plan renders the
 * "nothing to configure" state, which is the honest report.
 * @param envelope - the serialized schema from `settings.describe`.
 * @returns the root node, or undefined.
 */
export function rehydrate(envelope: unknown): SchemaNodeLike | undefined {
  try {
    return rehydrateSchema(envelope) as unknown as SchemaNodeLike
  } catch {
    return undefined
  }
}

/**
 * Render one namespace's controls.
 * @param props - the namespace view and the write callbacks.
 * @returns the form.
 */
export function SchemaForm({ view, locale, writable, labels, onSet, onUnset }: SchemaFormProps): ReactNode {
  const plan = useMemo<PlanNode[]>(
    () => planSection(rehydrate(view.schema), locale),
    [view.schema, locale],
  )
  if (plan.length === 0) return <p className={css.empty}>{labels.noSettings}</p>
  return (
    <div className={css.form} data-namespace={view.ns}>
      {writable ? null : <p className={css.notice}>{labels.readOnlyProvider}</p>}
      {plan.map((entry) => {
        const key = entry.path.join('.') || entry.node
        if (entry.node === 'group') {
          return (
            <GroupHeading
              key={key}
              label={entry.label}
              depth={entry.depth}
              description={entry.description}
              comment={entry.comment}
            />
          )
        }
        return (
          <Field
            key={key}
            field={entry}
            value={getPath(view.value, entry.path)}
            overridden={isFieldOverridden(view, entry.path)}
            writable={writable}
            secretSet={isSecretSet(view, entry.path)}
            labels={labels}
            onSet={(value) => { onSet(entry.path, value) }}
            onUnset={() => { onUnset(entry.path) }}
          />
        )
      })}
    </div>
  )
}
