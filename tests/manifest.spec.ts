/**
 * Reading somebody else's package.json.
 *
 * Every case here is a manifest this plugin does NOT control — a checkout on
 * disk, a file fetched from a repository — so the property under test is
 * always the same one: a broken field costs that field and nothing else.
 */

import { describe, expect, it } from 'vitest'
import {
  impliedNamespace, parseManifest, readLocalizedText, readManifest, readPlughubMetadata,
} from '../src/manifest.ts'

describe('readManifest', () => {
  it('recognizes a dsh bundle by its patch declaration', () => {
    const facts = readManifest({
      name: '@omdsh-plugins/omdsh-shortcuts',
      version: '0.1.0',
      description: 'Bind a chord to anything',
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    })
    expect(facts.isBundle).toBe(true)
    expect(facts.hasClient).toBe(true)
    expect(facts.name).toBe('@omdsh-plugins/omdsh-shortcuts')
    expect(facts.version).toBe('0.1.0')
  })

  it('does not treat a bundle-less package as one', () => {
    expect(readManifest({ name: 'lodash', version: '4.0.0' }).isBundle).toBe(false)
    expect(readManifest({ name: 'x', dsh: { bundle: {} } }).isBundle).toBe(false)
    expect(readManifest({ name: 'x', dsh: { bundle: { patch: '' } } }).isBundle).toBe(false)
  })

  it('survives every shape a manifest is not', () => {
    for (const input of [undefined, null, 42, 'text', [], { dsh: 'no' }, { dsh: { bundle: 7 } }]) {
      expect(readManifest(input).isBundle).toBe(false)
    }
  })

  it('drops an empty name rather than carrying one', () => {
    expect(readManifest({ name: '' }).name).toBeUndefined()
  })
})

describe('parseManifest', () => {
  it('reads JSON text', () => {
    expect(parseManifest('{"name":"a","dsh":{"bundle":{"patch":"./p.yml"}}}')?.isBundle).toBe(true)
  })

  it('returns undefined for text that is not JSON', () => {
    // A repository's default branch may well answer HTML for a missing file.
    expect(parseManifest('<!doctype html>')).toBeUndefined()
  })
})

describe('impliedNamespace', () => {
  it('strips the scope', () => {
    expect(impliedNamespace('@omdsh-plugins/omdsh-shortcuts')).toBe('omdsh-shortcuts')
    expect(impliedNamespace('omdsh-plughub')).toBe('omdsh-plughub')
  })

  it('refuses a name the settings service would refuse', () => {
    // The settings namespace grammar is lowercase kebab-case; a package name
    // that cannot be one must not be claimed as a namespace.
    expect(impliedNamespace('@scope/Some_Thing')).toBeUndefined()
    expect(impliedNamespace('@scope/9lives')).toBeUndefined()
  })
})

describe('readPlughubMetadata', () => {
  it('normalizes a full declaration', () => {
    const metadata = readPlughubMetadata({
      displayName: { '': 'Shortcuts', zh: '快捷键' },
      summary: 'One chord, one command',
      category: 'input',
      settings: ['omdsh-shortcuts'],
      docs: 'https://example.invalid/readme',
      order: 10,
    }, '@omdsh-plugins/omdsh-shortcuts')
    expect(metadata).toEqual({
      displayName: { '': 'Shortcuts', zh: '快捷键' },
      summary: 'One chord, one command',
      category: 'input',
      docs: 'https://example.invalid/readme',
      settings: ['omdsh-shortcuts'],
      order: 10,
    })
  })

  it('falls back to the implied namespace when none is declared', () => {
    expect(readPlughubMetadata(undefined, '@omdsh-plugins/omdsh-sidepanel').settings).toEqual(['omdsh-sidepanel'])
    expect(readPlughubMetadata({ category: 'ui' }, '@omdsh-plugins/omdsh-sidepanel').settings).toEqual(['omdsh-sidepanel'])
  })

  it('yields no namespaces when the declaration is present but unusable', () => {
    // An author who wrote the key meant to say something; silently falling
    // back to the implied namespace would ignore them.
    expect(readPlughubMetadata({ settings: 'omdsh-x' }, '@scope/omdsh-x').settings).toEqual([])
  })

  it('drops namespace entries the settings service would refuse', () => {
    expect(readPlughubMetadata({ settings: ['ok-one', 'Bad_Two', 7] }, 'pkg').settings).toEqual(['ok-one'])
  })

  it('defaults the order to zero for anything that is not a finite number', () => {
    expect(readPlughubMetadata({ order: 'first' }, 'pkg').order).toBe(0)
    expect(readPlughubMetadata({ order: Number.NaN }, 'pkg').order).toBe(0)
    expect(readPlughubMetadata({ order: -5 }, 'pkg').order).toBe(-5)
  })
})

describe('readLocalizedText', () => {
  it('accepts a bare string and a locale map', () => {
    expect(readLocalizedText('hello')).toBe('hello')
    expect(readLocalizedText({ '': 'hello', zh: '你好' })).toEqual({ '': 'hello', zh: '你好' })
  })

  it('drops non-string entries rather than the whole field', () => {
    expect(readLocalizedText({ '': 'hello', zh: 7 })).toEqual({ '': 'hello' })
  })

  it('reports nothing usable as undefined', () => {
    expect(readLocalizedText('')).toBeUndefined()
    expect(readLocalizedText({})).toBeUndefined()
    expect(readLocalizedText({ zh: '' })).toBeUndefined()
    expect(readLocalizedText(42)).toBeUndefined()
  })
})
