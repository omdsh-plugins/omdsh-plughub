/**
 * Turning a settings schema into a form, without knowing anything about the
 * plugin that wrote it.
 *
 * This is the module that makes the whole convention pay: a plugin registers a
 * settings namespace with a schemastery schema, the Host serializes that schema
 * onto the wire (`settings.describe`), and this walks the rehydrated node tree
 * into a list of controls. No plugin-specific code anywhere, so a plugin
 * written a year from now gets a configuration page the day it is installed.
 *
 * ## Flat, not recursive
 *
 * The output is a FLAT list carrying a depth, not a tree. Rendering is then a
 * `map` over one array rather than a mutually recursive component, and — more
 * to the point — the whole plan is one value a spec can assert on. A form bug
 * is nearly always a planning bug: the wrong control for a node type, a label
 * resolved from the wrong locale, a secret that lost its role. All of those are
 * visible here, in plain data, with no DOM in sight.
 *
 * ## What it refuses to guess
 *
 * A node it does not have a control for becomes `unsupported` and renders
 * read-only, next to a pointer at the settings document. That is a deliberate
 * floor: a generic form that guesses at an arbitrary schema produces controls
 * that silently write the wrong shape, and a settings write that passes
 * validation while meaning something else is worse than no control at all.
 * @module @omdsh-plugins/omdsh-plughub/client/schema-form/plan
 */

import type { LocalizedText } from '../../contract.ts'
import { resolveText } from '../text.ts'

/**
 * As much of a rehydrated schemastery node as the planner reads.
 *
 * Structural rather than the imported `SchemaNode`, so this module — and every
 * spec over it — needs no harness value at all: a plan is asserted against
 * plain objects.
 */
export interface SchemaNodeLike {
  readonly type?: string
  readonly meta?: {
    readonly description?: LocalizedText
    readonly comment?: string
    readonly role?: string
    readonly hidden?: boolean
    readonly disabled?: boolean
    readonly required?: boolean
    readonly link?: string
    readonly default?: unknown
    readonly min?: number
    readonly max?: number
    readonly step?: number
  }
  /** Object properties, by name. */
  readonly dict?: Readonly<Record<string, SchemaNodeLike>>
  /** Element schema of an array, or value schema of a dict. */
  readonly inner?: SchemaNodeLike
  /** Members of a union, intersect, or tuple. */
  readonly list?: readonly SchemaNodeLike[]
  /** The value of a `const` node. */
  readonly value?: unknown
}

/** Which control a field gets. */
export type FieldKind =
  /** A line of text. */
  | 'string'
  /** A write-only line: the Host redacted whatever is stored. */
  | 'secret'
  | 'number'
  | 'boolean'
  /** One of a closed set of constants. */
  | 'select'
  /** An editable list of lines. */
  | 'stringList'
  /** Editable key/value rows. */
  | 'stringDict'
  /** No control this form is willing to draw; shown read-only. */
  | 'unsupported'

/** One choice of a `select` field. */
export interface FieldOption {
  readonly value: string
  readonly label: string
}

/** One control in the rendered form. */
export interface FieldNode {
  readonly node: 'field'
  /** Path from the section root; the same path a `settings.mutate` op carries. */
  readonly path: readonly string[]
  /** Nesting level, for indentation only. */
  readonly depth: number
  readonly kind: FieldKind
  /**
   * The field's title.
   *
   * Derived from the property name, NOT from the schema's description: a
   * schemastery description is a sentence ("GitHub account whose repositories
   * are offered when no registry manifest is published"), and a sentence makes
   * a poor label. The sentence goes to {@link FieldNode.description}, under
   * the control, which is where the harness's own settings rows put theirs.
   */
  readonly label: string
  /** The property name verbatim, so a person can find the field in the document. */
  readonly key: string
  /** The schema's own description, resolved for the active locale. */
  readonly description?: string
  readonly comment?: string
  readonly link?: string
  readonly disabled: boolean
  readonly options?: readonly FieldOption[]
  readonly min?: number
  readonly max?: number
  readonly step?: number
  /** The schema's own default, for the "inherited" hint beside an unset field. */
  readonly fallback?: unknown
  /** The node's declared type, so an `unsupported` control can say what it is. */
  readonly schemaType: string
}

/** A heading introducing a nested object. */
export interface GroupNode {
  readonly node: 'group'
  readonly path: readonly string[]
  readonly depth: number
  /** The group's title, derived from its property name (see {@link FieldNode.label}). */
  readonly label: string
  readonly key: string
  /** The schema's own description, resolved for the active locale. */
  readonly description?: string
  readonly comment?: string
}

/** One entry of a planned form. */
export type PlanNode = FieldNode | GroupNode

/** Whether every member of a union is a constant, i.e. whether it is a closed choice. */
function constantOptions(list: readonly SchemaNodeLike[] | undefined, locale: string): FieldOption[] | undefined {
  if (list === undefined || list.length === 0) return undefined
  const options: FieldOption[] = []
  for (const member of list) {
    if (member.type !== 'const') return undefined
    const value = member.value
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined
    options.push({
      value: String(value),
      // A member may describe itself ("Follow the system"); its literal is the
      // honest fallback.
      label: resolveText(member.meta?.description, locale) ?? String(value),
    })
  }
  return options
}

/**
 * Decide which control one node gets.
 * @param node - the schema node.
 * @param locale - the active locale, for option labels.
 * @returns the kind and, for a closed choice, its options.
 */
export function classify(node: SchemaNodeLike, locale: string): { kind: FieldKind; options?: FieldOption[] } {
  // The role wins over the type: a `role('secret')` string is never an
  // ordinary text box, because what the wire carried is not what is stored.
  if (node.meta?.role === 'secret') return { kind: 'secret' }
  switch (node.type) {
    case 'string':
      return { kind: 'string' }
    case 'number':
      return { kind: 'number' }
    case 'boolean':
      return { kind: 'boolean' }
    case 'union': {
      const options = constantOptions(node.list, locale)
      return options === undefined ? { kind: 'unsupported' } : { kind: 'select', options }
    }
    case 'array':
      return node.inner?.type === 'string' ? { kind: 'stringList' } : { kind: 'unsupported' }
    case 'dict':
      return node.inner?.type === 'string' ? { kind: 'stringDict' } : { kind: 'unsupported' }
    default:
      return { kind: 'unsupported' }
  }
}

/**
 * A property name as a title: `maxRepos` → `Max repos`, `upstream` →
 * `Upstream`. Mechanical on purpose — a schema author who wants different
 * words has the description for them, and a rule a reader can predict beats
 * one that is occasionally cleverer.
 * @param key - the property name.
 * @returns the title.
 */
export function titleForKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLocaleLowerCase()
  return words === '' ? key : words.charAt(0).toLocaleUpperCase() + words.slice(1)
}

/** Build one field node from a schema node. */
function toField(
  node: SchemaNodeLike,
  path: readonly string[],
  depth: number,
  locale: string,
): FieldNode {
  const key = path[path.length - 1] ?? ''
  const { kind, options } = classify(node, locale)
  const meta = node.meta
  const description = resolveText(meta?.description, locale)
  return {
    node: 'field',
    path,
    depth,
    kind,
    label: titleForKey(key),
    key,
    ...description === undefined ? {} : { description },
    ...meta?.comment === undefined || meta.comment === '' ? {} : { comment: meta.comment },
    ...meta?.link === undefined || meta.link === '' ? {} : { link: meta.link },
    disabled: meta?.disabled === true,
    ...options === undefined ? {} : { options },
    ...typeof meta?.min === 'number' ? { min: meta.min } : {},
    ...typeof meta?.max === 'number' ? { max: meta.max } : {},
    ...typeof meta?.step === 'number' ? { step: meta.step } : {},
    ...meta?.default === undefined ? {} : { fallback: meta.default },
    schemaType: node.type ?? 'unknown',
  }
}

/** Depth beyond which nesting is reported rather than rendered. */
const MAX_DEPTH = 3

/**
 * Plan the form for one settings section.
 *
 * Only an `object` root yields controls: a settings section IS an object of
 * named keys — that is what `settings.mutate`'s path ops address — so any
 * other root is a namespace this form cannot edit and says so.
 * @param root - the rehydrated section schema.
 * @param locale - the active locale id.
 * @returns the flat plan, in schema declaration order.
 */
export function planSection(root: SchemaNodeLike | undefined, locale: string): PlanNode[] {
  const plan: PlanNode[] = []
  if (root === undefined) return plan
  if (root.type !== 'object' || root.dict === undefined) {
    plan.push({
      node: 'field',
      path: [],
      depth: 0,
      kind: 'unsupported',
      label: resolveText(root.meta?.description, locale) ?? '',
      key: '',
      disabled: true,
      schemaType: root.type ?? 'unknown',
    })
    return plan
  }
  const walk = (node: SchemaNodeLike, path: readonly string[], depth: number): void => {
    for (const [key, child] of Object.entries(node.dict ?? {})) {
      // `hidden` is the schema author saying "not in a form"; honoring it is
      // the difference between a generic renderer and an indiscriminate one.
      if (child.meta?.hidden === true) continue
      const childPath = [...path, key]
      if (child.type === 'object' && child.dict !== undefined && depth < MAX_DEPTH) {
        plan.push({
          node: 'group',
          path: childPath,
          depth,
          label: titleForKey(key),
          key,
          ...resolveText(child.meta?.description, locale) === undefined
            ? {}
            : { description: resolveText(child.meta?.description, locale) as string },
          ...child.meta?.comment === undefined || child.meta.comment === ''
            ? {}
            : { comment: child.meta.comment },
        })
        walk(child, childPath, depth + 1)
        continue
      }
      plan.push(toField(child, childPath, depth, locale))
    }
  }
  walk(root, [], 0)
  return plan
}

/**
 * Whether a plan has anything a person can actually change.
 * @param plan - the planned form.
 * @returns true when at least one supported, enabled control exists.
 */
export function isEditable(plan: readonly PlanNode[]): boolean {
  return plan.some(entry => entry.node === 'field' && entry.kind !== 'unsupported' && !entry.disabled)
}

/**
 * Read a nested value by path.
 * @param value - the root value.
 * @param path - key path from the root.
 * @returns the value at the path, or undefined along a missing branch.
 */
export function getPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * Whether the raw user section carries this path — which is what "overridden"
 * means at the settings seam. Presence, never value comparison: an override
 * written to exactly the composition base is still an override, and the seam
 * treats it as one.
 * @param user - the raw user section, when the Host sent one.
 * @param path - the field's path.
 * @returns true when the user layer has the key.
 */
export function isOverridden(user: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return false
  const parent = getPath(user, path.slice(0, -1))
  if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) return false
  return Object.prototype.hasOwnProperty.call(parent, path[path.length - 1] as string)
}
