/**
 * Reading a package.json the way this plugin needs to: is it a dsh bundle, and
 * what does it want shown about itself.
 *
 * Every input here is UNTRUSTED in the same specific way — it is JSON someone
 * else wrote, fetched from a directory or a repository this runtime does not
 * control. So nothing below throws on a malformed field; it returns the
 * conservative answer and moves on. A plugin with a broken `dsh.plughub`
 * section must still be installable, because the section is decoration and the
 * `dsh.bundle` declaration is the fact.
 * @module @omdsh-plugins/omdsh-plughub/manifest
 */

import { EMPTY_METADATA, type LocalizedText, type PlughubMetadata } from './contract.ts'

/**
 * The settings service's own namespace grammar, restated. A namespace that
 * would not survive `settingsNamespace()` on the Host is not one this plugin
 * will claim a package owns.
 */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/

/** The slice of a package.json this module reads. */
export interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly description?: unknown
  readonly dsh?: unknown
}

/** What one package.json says about itself, once read. */
export interface ManifestFacts {
  /** The declared package name, when it declares a usable one. */
  readonly name?: string
  readonly version?: string
  readonly description?: string
  /** Whether it declares `dsh.bundle.patch`, i.e. whether it is a profile layer. */
  readonly isBundle: boolean
  /** Whether it declares a `dsh.client` half. */
  readonly hasClient: boolean
  readonly metadata: PlughubMetadata
}

/** Whether a value is a plain data object (not an array, null, or class instance). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One string field, when it is a non-empty string. */
function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read a localized-text field: a bare string, or a locale map whose entries
 * are strings (non-string entries are dropped rather than failing the field).
 * @param value - the raw field.
 * @returns the normalized text, or undefined when nothing usable is there.
 */
export function readLocalizedText(value: unknown): LocalizedText | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (!isRecord(value)) return undefined
  const entries: Record<string, string> = {}
  for (const [locale, text] of Object.entries(value)) {
    if (typeof text === 'string' && text !== '') entries[locale] = text
  }
  return Object.keys(entries).length === 0 ? undefined : entries
}

/**
 * The settings namespace a package owns when it does not say so itself: its
 * unscoped name. Every omdsh plugin follows that convention, and a package
 * that does not is exactly the case `dsh.plughub.settings` exists to state.
 * @param packageName - the full package name, scope included.
 * @returns the implied namespace, or undefined when the name cannot be one.
 */
export function impliedNamespace(packageName: string): string | undefined {
  const unscoped = packageName.startsWith('@') ? packageName.slice(packageName.indexOf('/') + 1) : packageName
  return NAMESPACE_PATTERN.test(unscoped) ? unscoped : undefined
}

/**
 * Read the `dsh.plughub` section.
 * @param section - the raw `dsh.plughub` value.
 * @param packageName - the package's name, for the namespace fallback.
 * @returns normalized metadata; the empty metadata when nothing is declared.
 */
export function readPlughubMetadata(section: unknown, packageName: string | undefined): PlughubMetadata {
  const fallback = packageName === undefined ? [] : [impliedNamespace(packageName)].filter(ns => ns !== undefined)
  if (!isRecord(section)) return { ...EMPTY_METADATA, settings: fallback }
  const declared = section['settings']
  const settings = Array.isArray(declared)
    ? declared.filter((ns): ns is string => typeof ns === 'string' && NAMESPACE_PATTERN.test(ns))
    // An author who declares the key but writes something unusable meant to
    // say SOMETHING; falling back to the implied namespace would quietly
    // ignore them, so an unusable declaration yields no namespaces at all.
    : declared === undefined ? fallback : []
  const order = section['order']
  const displayName = readLocalizedText(section['displayName'])
  const summary = readLocalizedText(section['summary'])
  const category = stringField(section, 'category')
  const docs = stringField(section, 'docs')
  return {
    ...displayName === undefined ? {} : { displayName },
    ...summary === undefined ? {} : { summary },
    ...category === undefined ? {} : { category },
    ...docs === undefined ? {} : { docs },
    settings,
    order: typeof order === 'number' && Number.isFinite(order) ? order : 0,
  }
}

/**
 * Read one package.json into the facts this plugin acts on.
 * @param manifest - the parsed manifest, of whatever shape it turned out to be.
 * @returns the facts; `isBundle: false` for anything unrecognizable.
 */
export function readManifest(manifest: unknown): ManifestFacts {
  if (!isRecord(manifest)) return { isBundle: false, hasClient: false, metadata: EMPTY_METADATA }
  const name = stringField(manifest, 'name')
  const version = stringField(manifest, 'version')
  const description = stringField(manifest, 'description')
  const dsh = manifest['dsh']
  const section = isRecord(dsh) ? dsh : undefined
  const bundle = section === undefined ? undefined : section['bundle']
  return {
    ...name === undefined ? {} : { name },
    ...version === undefined ? {} : { version },
    ...description === undefined ? {} : { description },
    isBundle: isRecord(bundle) && typeof bundle['patch'] === 'string' && bundle['patch'] !== '',
    hasClient: section !== undefined && isRecord(section['client']),
    metadata: readPlughubMetadata(section?.['plughub'], name),
  }
}

/**
 * Parse a package.json's text into facts, tolerating anything that is not JSON.
 * @param text - the file or response body.
 * @returns the facts, or undefined when the text is not JSON at all.
 */
export function parseManifest(text: string): ManifestFacts | undefined {
  try {
    return readManifest(JSON.parse(text))
  } catch {
    return undefined
  }
}
