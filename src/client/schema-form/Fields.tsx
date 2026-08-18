/**
 * The controls a planned form is drawn with.
 *
 * Each one is presentational: it renders the current value and reports an
 * edit. Nothing here reads the wire, holds a draft, or decides when to write —
 * that all belongs to the card, which owns the namespace's revision and is the
 * only thing that can order writes correctly.
 * @module @omdsh-plugins/omdsh-plughub/client/schema-form/Fields
 */

import { useState, type ReactNode } from 'react'
import {
  Button, IconLinkOutline14, IconPlusOutline16, IconTrashOutline16, Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FieldNode } from './plan.ts'
import css from './Fields.module.css'

/** Text this form needs from the panel's dictionary. */
export interface FieldLabels {
  readonly overridden: string
  readonly reset: string
  readonly resetTitle: string
  readonly unsupportedField: string
  readonly secretSet: string
  readonly secretUnset: string
  readonly addRow: string
  readonly removeRow: string
  readonly keyPlaceholder: string
  readonly valuePlaceholder: string
  readonly docs: string
}

/** What every control receives. */
export interface FieldProps {
  readonly field: FieldNode
  /** The resolved value: schema default, then composition base, then user layer. */
  readonly value: unknown
  /** Whether the user layer carries this path (presence, not value comparison). */
  readonly overridden: boolean
  /** Whether writes are possible at all right now. */
  readonly writable: boolean
  /** Whether a redacted secret slot currently holds a value. */
  readonly secretSet: boolean
  readonly labels: FieldLabels
  /** Write this field. */
  readonly onSet: (value: unknown) => void
  /** Drop this field's override, falling back to the composed value. */
  readonly onUnset: () => void
}

/**
 * A local draft that follows the authoritative value except while being typed.
 *
 * Without this a text field fights its own writes: every keystroke would have
 * to round-trip before the next one could render. With it, typing is local and
 * the authoritative value takes over again the moment it changes underneath —
 * which is what makes another tab's edit visible here without stealing focus
 * mid-word.
 * @param value - the authoritative value.
 * @returns the draft, its setter, and a reset to the authoritative value.
 */
function useDraft(value: string): [string, (next: string) => void] {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setDraft(value)
  }
  return [draft, setDraft]
}

/** The row chrome every control shares: label, key, override badge, reset. */
function FieldShell({
  field, overridden, writable, labels, onUnset, children, hint,
}: {
  field: FieldNode
  overridden: boolean
  writable: boolean
  labels: FieldLabels
  onUnset: () => void
  children: ReactNode
  hint?: ReactNode
}): ReactNode {
  return (
    <div className={css.field} data-field={field.path.join('.')} data-depth={field.depth}>
      <div className={css.head}>
        <span className={css.label}>
          {field.label}
          {/* The raw key beside the title, because the title is derived: a
              person reading the settings document needs the name it uses. */}
          {field.label.toLocaleLowerCase() === field.key.toLocaleLowerCase()
            ? null
            : <code className={css.key}>{field.key}</code>}
        </span>
        <span className={css.badges}>
          {overridden ? <span className={css.override}>{labels.overridden}</span> : null}
          {overridden && writable ? (
            <button type="button" className={css.reset} title={labels.resetTitle} onClick={onUnset}>
              {labels.reset}
            </button>
          ) : null}
          {field.link === undefined ? null : (
            <a className={css.docs} href={field.link} target="_blank" rel="noreferrer noopener" title={labels.docs}>
              <IconLinkOutline14 aria-hidden="true" />
            </a>
          )}
        </span>
      </div>
      <div className={css.control}>{children}</div>
      {field.description === undefined ? null : <p className={css.hint}>{field.description}</p>}
      {hint === undefined ? null : <p className={css.hint}>{hint}</p>}
      {field.comment === undefined ? null : <p className={css.hint}>{field.comment}</p>}
    </div>
  )
}

/** One line of text. */
function StringField(props: FieldProps): ReactNode {
  const current = typeof props.value === 'string' ? props.value : ''
  const [draft, setDraft] = useDraft(current)
  return (
    <FieldShell {...props} onUnset={props.onUnset}>
      <Input
        type="text"
        value={draft}
        disabled={!props.writable || props.field.disabled}
        aria-label={props.field.label}
        onChange={(event) => { setDraft(event.currentTarget.value) }}
        onBlur={() => { if (draft !== current) props.onSet(draft) }}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      />
    </FieldShell>
  )
}

/**
 * What a stored secret looks like in a box that cannot hold it.
 *
 * It is a placeholder rather than a value, which is the whole point: a
 * placeholder is not a draft, so there is no path by which the mask itself is
 * ever submitted as the key. An empty box reads as "nothing configured" no
 * matter what the hint underneath says.
 */
const SECRET_MASK = '••••••••'

/** A write-only line: what is stored was never sent here. */
function SecretField(props: FieldProps): ReactNode {
  const [draft, setDraft] = useState('')
  return (
    <FieldShell
      {...props}
      onUnset={props.onUnset}
      hint={props.secretSet
        ? <strong>{props.labels.secretSet}</strong>
        : props.labels.secretUnset}
    >
      <Input
        type="password"
        value={draft}
        placeholder={props.secretSet ? SECRET_MASK : undefined}
        autoComplete="off"
        disabled={!props.writable || props.field.disabled}
        aria-label={props.field.label}
        onChange={(event) => { setDraft(event.currentTarget.value) }}
        onBlur={() => {
          if (draft === '') return
          props.onSet(draft)
          // Cleared rather than kept: the field is write-only, and a box still
          // holding what was just sent invites a second, identical write.
          setDraft('')
        }}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      />
    </FieldShell>
  )
}

/** A number, with whatever bounds the schema declared. */
function NumberField(props: FieldProps): ReactNode {
  const current = typeof props.value === 'number' ? String(props.value) : ''
  const [draft, setDraft] = useDraft(current)
  const commit = (): void => {
    if (draft === current) return
    if (draft === '') {
      props.onUnset()
      return
    }
    const parsed = Number(draft)
    // A schema-invalid write would be refused by the Host anyway; refusing it
    // here means the person is not told "saved" about something that was not.
    if (Number.isFinite(parsed)) props.onSet(parsed)
  }
  return (
    <FieldShell {...props} onUnset={props.onUnset}>
      <Input
        type="number"
        value={draft}
        disabled={!props.writable || props.field.disabled}
        aria-label={props.field.label}
        {...props.field.min === undefined ? {} : { min: props.field.min }}
        {...props.field.max === undefined ? {} : { max: props.field.max }}
        {...props.field.step === undefined ? {} : { step: props.field.step }}
        onChange={(event) => { setDraft(event.currentTarget.value) }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      />
    </FieldShell>
  )
}

/** A checkbox. */
function BooleanField(props: FieldProps): ReactNode {
  const current = props.value === true
  return (
    <FieldShell {...props} onUnset={props.onUnset}>
      <label className={css.checkbox}>
        <input
          type="checkbox"
          checked={current}
          disabled={!props.writable || props.field.disabled}
          aria-label={props.field.label}
          onChange={(event) => { props.onSet(event.currentTarget.checked) }}
        />
      </label>
    </FieldShell>
  )
}

/** One of a closed set of constants. */
function SelectField(props: FieldProps): ReactNode {
  const options = props.field.options ?? []
  const current = props.value === undefined ? '' : String(props.value)
  return (
    <FieldShell {...props} onUnset={props.onUnset}>
      <select
        className={css.select}
        value={current}
        disabled={!props.writable || props.field.disabled}
        aria-label={props.field.label}
        onChange={(event) => {
          const chosen = options.find(option => option.value === event.currentTarget.value)
          if (chosen === undefined) return
          // The plan flattened every constant to its string form; a union of
          // numbers or booleans has to be widened back before it is written,
          // or the schema refuses the string.
          props.onSet(reviveConstant(chosen.value))
        }}
      >
        {options.some(option => option.value === current) ? null : <option value="">—</option>}
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </FieldShell>
  )
}

/** Widen a flattened constant back to the primitive the schema declared. */
function reviveConstant(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value !== '' && Number.isFinite(Number(value))) return Number(value)
  return value
}

/** An editable list of lines. */
function StringListField(props: FieldProps): ReactNode {
  const items = Array.isArray(props.value) ? props.value.filter((item): item is string => typeof item === 'string') : []
  const disabled = !props.writable || props.field.disabled
  const write = (next: string[]): void => { props.onSet(next) }
  return (
    <FieldShell {...props} onUnset={props.onUnset}>
      <ul className={css.rows}>
        {items.map((item, index) => (
          // eslint-disable-next-line react/no-array-index-key -- the list is
          // positional: two identical entries are two entries, and any
          // value-derived key would collapse them.
          <li className={css.row} key={index}>
            <Input
              type="text"
              value={item}
              disabled={disabled}
              aria-label={`${props.field.label} ${String(index + 1)}`}
              onChange={(event) => {
                const next = [...items]
                next[index] = event.currentTarget.value
                write(next)
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              title={props.labels.removeRow}
              aria-label={props.labels.removeRow}
              icon={<IconTrashOutline16 aria-hidden="true" />}
              onClick={() => { write(items.filter((_, at) => at !== index)) }}
            />
          </li>
        ))}
      </ul>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        icon={<IconPlusOutline16 aria-hidden="true" />}
        onClick={() => { write([...items, '']) }}
      >
        {props.labels.addRow}
      </Button>
    </FieldShell>
  )
}

/** Editable key/value rows. */
function StringDictField(props: FieldProps): ReactNode {
  const source = typeof props.value === 'object' && props.value !== null && !Array.isArray(props.value)
    ? props.value as Record<string, unknown>
    : {}
  const entries = Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  const disabled = !props.writable || props.field.disabled
  // Held locally so a half-typed key is not written as an empty one on every
  // keystroke — a dict key IS the identity, and renaming it in place would
  // create one entry per prefix.
  const [pendingKey, setPendingKey] = useState('')
  const [pendingValue, setPendingValue] = useState('')
  const write = (next: readonly (readonly [string, string])[]): void => {
    props.onSet(Object.fromEntries(next))
  }
  return (
    <FieldShell {...props} onUnset={props.onUnset}>
      <ul className={css.rows}>
        {entries.map(([key, value], index) => (
          <li className={css.row} key={key}>
            <code className={css.dictKey}>{key}</code>
            <Input
              type="text"
              value={value}
              disabled={disabled}
              aria-label={`${props.field.label} ${key}`}
              onChange={(event) => {
                const next = entries.map((entry, at) =>
                  (at === index ? [key, event.currentTarget.value] as const : entry))
                write(next)
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              title={props.labels.removeRow}
              aria-label={`${props.labels.removeRow} ${key}`}
              icon={<IconTrashOutline16 aria-hidden="true" />}
              onClick={() => { write(entries.filter((_, at) => at !== index)) }}
            />
          </li>
        ))}
      </ul>
      <div className={css.row}>
        <Input
          type="text"
          value={pendingKey}
          disabled={disabled}
          placeholder={props.labels.keyPlaceholder}
          aria-label={props.labels.keyPlaceholder}
          onChange={(event) => { setPendingKey(event.currentTarget.value) }}
        />
        <Input
          type="text"
          value={pendingValue}
          disabled={disabled}
          placeholder={props.labels.valuePlaceholder}
          aria-label={props.labels.valuePlaceholder}
          onChange={(event) => { setPendingValue(event.currentTarget.value) }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || pendingKey === ''}
          icon={<IconPlusOutline16 aria-hidden="true" />}
          onClick={() => {
            write([...entries.filter(([key]) => key !== pendingKey), [pendingKey, pendingValue]])
            setPendingKey('')
            setPendingValue('')
          }}
        >
          {props.labels.addRow}
        </Button>
      </div>
    </FieldShell>
  )
}

/** A shape this form declines to draw a control for. */
function UnsupportedField(props: FieldProps): ReactNode {
  return (
    <FieldShell
      {...props}
      onUnset={props.onUnset}
      hint={props.labels.unsupportedField.replace('{type}', props.field.schemaType)}
    >
      <pre className={css.readonly}>{JSON.stringify(props.value, undefined, 2) ?? 'undefined'}</pre>
    </FieldShell>
  )
}

/**
 * Render one planned field with the control its kind calls for.
 * @param props - the field, its value, and the write callbacks.
 * @returns the control.
 */
export function Field(props: FieldProps): ReactNode {
  switch (props.field.kind) {
    case 'string': return <StringField {...props} />
    case 'secret': return <SecretField {...props} />
    case 'number': return <NumberField {...props} />
    case 'boolean': return <BooleanField {...props} />
    case 'select': return <SelectField {...props} />
    case 'stringList': return <StringListField {...props} />
    case 'stringDict': return <StringDictField {...props} />
    default: return <UnsupportedField {...props} />
  }
}

/**
 * A heading introducing a nested object.
 * @param props.label - the group's resolved label.
 * @param props.depth - its nesting level.
 * @param props.description - the schema's description, resolved for the locale.
 * @param props.comment - the schema's comment, when it wrote one.
 * @returns the heading.
 */
export function GroupHeading({ label, depth, description, comment }: {
  label: string
  depth: number
  description?: string | undefined
  comment?: string | undefined
}): ReactNode {
  return (
    <div className={css.group} data-depth={depth}>
      <h5 className={css.groupLabel}>{label}</h5>
      {description === undefined ? null : <p className={css.hint}>{description}</p>}
      {comment === undefined ? null : <p className={css.hint}>{comment}</p>}
    </div>
  )
}
