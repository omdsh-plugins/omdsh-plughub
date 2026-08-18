/**
 * The schema-to-form planner — the module the whole convention rests on.
 *
 * Asserted against plain node objects rather than a live schemastery instance
 * on purpose: the wire carries `schema.toJSON()`, and what this reads is that
 * shape. A spec that built real schemas would test schemastery's serializer as
 * much as this planner, and would need the harness present to run at all.
 */

import { describe, expect, it } from 'vitest'
import {
  classify, getPath, isEditable, isOverridden, planSection, titleForKey, type SchemaNodeLike,
} from '../src/client/schema-form/plan.ts'

/** An object node with the given properties. */
function object(dict: Record<string, SchemaNodeLike>, meta?: SchemaNodeLike['meta']): SchemaNodeLike {
  return { type: 'object', dict, ...meta === undefined ? {} : { meta } }
}

describe('classify', () => {
  it('maps the primitive types to their controls', () => {
    expect(classify({ type: 'string' }, 'en').kind).toBe('string')
    expect(classify({ type: 'number' }, 'en').kind).toBe('number')
    expect(classify({ type: 'boolean' }, 'en').kind).toBe('boolean')
  })

  it('makes a secret write-only whatever its type says', () => {
    // What the wire carried is not what is stored, so this is never an
    // ordinary text box.
    expect(classify({ type: 'string', meta: { role: 'secret' } }, 'en').kind).toBe('secret')
  })

  it('turns a closed union of constants into a select', () => {
    const { kind, options } = classify({
      type: 'union',
      list: [
        { type: 'const', value: 'dark', meta: { description: { '': 'Dark', zh: '深色' } } },
        { type: 'const', value: 'light' },
      ],
    }, 'zh')
    expect(kind).toBe('select')
    expect(options).toEqual([
      { value: 'dark', label: '深色' },
      // A member that describes itself gets its description; one that does
      // not falls back to its literal.
      { value: 'light', label: 'light' },
    ])
  })

  it('refuses a union that is not closed', () => {
    expect(classify({ type: 'union', list: [{ type: 'string' }, { type: 'const', value: 'x' }] }, 'en').kind)
      .toBe('unsupported')
    expect(classify({ type: 'union', list: [] }, 'en').kind).toBe('unsupported')
  })

  it('handles arrays and dicts of strings, and refuses the rest', () => {
    expect(classify({ type: 'array', inner: { type: 'string' } }, 'en').kind).toBe('stringList')
    expect(classify({ type: 'dict', inner: { type: 'string' } }, 'en').kind).toBe('stringDict')
    expect(classify({ type: 'array', inner: { type: 'object' } }, 'en').kind).toBe('unsupported')
    expect(classify({ type: 'dict', inner: { type: 'number' } }, 'en').kind).toBe('unsupported')
  })

  it('refuses what it has no control for rather than guessing', () => {
    // A guessed control writes the wrong shape and passes validation while
    // meaning something else, which is worse than no control.
    for (const type of ['intersect', 'transform', 'tuple', 'any', 'never', 'is', 'bitset']) {
      expect(classify({ type }, 'en').kind).toBe('unsupported')
    }
  })
})

describe('planSection', () => {
  it('plans one control per property, in declaration order', () => {
    const plan = planSection(object({
      upstream: { type: 'string', meta: { description: 'GitHub account' } },
      maxRepos: { type: 'number', meta: { min: 1, max: 500, default: 100 } },
      verbose: { type: 'boolean' },
    }), 'en')
    expect(plan.map(node => node.key)).toEqual(['upstream', 'maxRepos', 'verbose'])
    expect(plan[0]).toMatchObject({
      node: 'field', kind: 'string', depth: 0,
      // The title is derived from the key; the schema's sentence is the hint.
      label: 'Upstream', description: 'GitHub account',
    })
    expect(plan[1]).toMatchObject({ kind: 'number', min: 1, max: 500, fallback: 100, label: 'Max repos' })
  })

  it('titles a field from its key, described or not', () => {
    // Mechanical on purpose: a rule a reader can predict beats one that is
    // occasionally cleverer, and a schema author who wants different words
    // has the description for them.
    expect(planSection(object({ verbose: { type: 'boolean' } }), 'en')[0]?.label).toBe('Verbose')
    expect(titleForKey('cacheTtlMs')).toBe('Cache ttl ms')
    expect(titleForKey('local_sources')).toBe('Local sources')
    expect(titleForKey('')).toBe('')
  })

  it('prefers a title the schema declared for itself, in the active locale', () => {
    // Without this a form built from a schema alone titles every field with an
    // English identifier, and a page in Chinese comes out half translated.
    const dict = {
      provider: { type: 'string', meta: { extra: { label: { '': 'Model route', zh: '模型路由' } } } },
      apiKey: { type: 'string', meta: { role: 'secret', extra: { label: { '': 'API key', zh: '密钥' } } } },
    }
    expect(planSection(object(dict), 'zh').map(node => node.label)).toEqual(['模型路由', '密钥'])
    expect(planSection(object(dict), 'en').map(node => node.label)).toEqual(['Model route', 'API key'])
  })

  it('falls back to the property name when the extra slot holds anything else', () => {
    // `role(text, extra)` writes the same slot, so whatever a role put there is
    // read defensively rather than rendered as a title.
    const plan = planSection(object({
      upstream: { type: 'string', meta: { extra: { filter: 'llm' } } },
      maxRepos: { type: 'number', meta: { extra: 'llm' } },
      verbose: { type: 'boolean', meta: { extra: { label: '' } } },
    }), 'zh')
    expect(plan.map(node => node.label)).toEqual(['Upstream', 'Max repos', 'Verbose'])
  })

  it('titles a group the same way', () => {
    const plan = planSection(object({
      retry: object({ attempts: { type: 'number' } }, { extra: { label: { zh: '重试' } } }),
    }), 'zh')
    expect(plan[0]).toMatchObject({ node: 'group', label: '重试' })
  })

  it('resolves a localized description for the active locale', () => {
    const dict = { upstream: { type: 'string', meta: { description: { '': 'Account', zh: '账号' } } } }
    expect(planSection(object(dict), 'zh')[0]?.description).toBe('账号')
    expect(planSection(object(dict), 'en')[0]?.description).toBe('Account')
    // A locale nobody translated for falls back to the default entry.
    expect(planSection(object(dict), 'fr')[0]?.description).toBe('Account')
  })

  it('honors hidden', () => {
    const plan = planSection(object({
      shown: { type: 'string' },
      internal: { type: 'string', meta: { hidden: true } },
    }), 'en')
    expect(plan.map(node => node.key)).toEqual(['shown'])
  })

  it('emits a heading and indents a nested object', () => {
    const plan = planSection(object({
      retry: object({ attempts: { type: 'number' } }, { description: 'Retry' }),
    }), 'en')
    expect(plan[0]).toMatchObject({ node: 'group', label: 'Retry', description: 'Retry', depth: 0, path: ['retry'] })
    expect(plan[1]).toMatchObject({ node: 'field', key: 'attempts', depth: 1, path: ['retry', 'attempts'] })
  })

  it('stops nesting past the depth it will indent', () => {
    let deepest: SchemaNodeLike = object({ leaf: { type: 'string' } })
    for (let level = 0; level < 5; level += 1) deepest = object({ [`level${String(level)}`]: deepest })
    const plan = planSection(deepest, 'en')
    // Beyond the indent depth the object becomes one `unsupported` control
    // rather than an unreadable cascade.
    expect(plan.filter(node => node.node === 'group')).toHaveLength(3)
    const tail = plan[plan.length - 1]
    expect(tail).toMatchObject({ node: 'field', kind: 'unsupported', schemaType: 'object' })
  })

  it('reports a root that is not an object rather than rendering nothing', () => {
    const plan = planSection({ type: 'string' }, 'en')
    expect(plan).toEqual([expect.objectContaining({ kind: 'unsupported', schemaType: 'string' })])
  })

  it('plans nothing from a schema that could not be rehydrated', () => {
    expect(planSection(undefined, 'en')).toEqual([])
  })
})

describe('isEditable', () => {
  it('is false when every control is unsupported or disabled', () => {
    expect(isEditable(planSection(object({ x: { type: 'string' } }), 'en'))).toBe(true)
    expect(isEditable(planSection(object({ x: { type: 'is' } }), 'en'))).toBe(false)
    expect(isEditable(planSection(object({ x: { type: 'string', meta: { disabled: true } } }), 'en'))).toBe(false)
  })
})

describe('getPath', () => {
  it('reads a nested value and stops at a missing branch', () => {
    expect(getPath({ retry: { attempts: 3 } }, ['retry', 'attempts'])).toBe(3)
    expect(getPath({ retry: { attempts: 3 } }, ['retry', 'nope'])).toBeUndefined()
    expect(getPath({ retry: 3 }, ['retry', 'attempts'])).toBeUndefined()
    expect(getPath(undefined, ['a'])).toBeUndefined()
  })
})

describe('isOverridden', () => {
  it('reads presence, never value equality', () => {
    // The settings seam marks a field overridden by its PRESENCE in the user
    // layer; an override written to exactly the composed value is still one.
    expect(isOverridden({ upstream: 'omdsh-plugins' }, ['upstream'])).toBe(true)
    expect(isOverridden({ upstream: undefined }, ['upstream'])).toBe(true)
    expect(isOverridden({}, ['upstream'])).toBe(false)
    expect(isOverridden(undefined, ['upstream'])).toBe(false)
  })

  it('reads a nested path', () => {
    expect(isOverridden({ retry: { attempts: 1 } }, ['retry', 'attempts'])).toBe(true)
    expect(isOverridden({ retry: {} }, ['retry', 'attempts'])).toBe(false)
  })

  it('is false for the section root, which is never one field', () => {
    expect(isOverridden({ a: 1 }, [])).toBe(false)
  })
})
