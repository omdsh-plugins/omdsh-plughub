/**
 * Resolving text that a plugin wrote about itself.
 *
 * Two different places produce it — a `dsh.plughub` manifest section and a
 * schemastery `.description()` — and they use the SAME shape, because
 * schemastery's `.i18n()` already serializes a description as a locale map
 * with `''` for the default. Adopting that shape for the manifest as well
 * means one resolver, and it means a plugin author who has learned how the
 * settings schema is localized has already learned how the card is.
 *
 * The chain is: the active locale, then the empty-key default, then English,
 * then whatever the map happens to hold. A missing translation must degrade to
 * SOME text — a blank card title tells a reader nothing about what went wrong,
 * and the plugin's name in the wrong language tells them everything.
 * @module @omdsh-plugins/omdsh-plughub/client/text
 */

import type { LocalizedText } from '../contract.ts'

/**
 * Resolve one localized value for a locale.
 * @param text - the value, absent, a bare string, or a locale map.
 * @param locale - the active locale id (`zh`, `en`, …).
 * @returns the resolved text, or undefined when nothing usable is there.
 */
export function resolveText(text: LocalizedText | undefined, locale: string): string | undefined {
  if (text === undefined) return undefined
  if (typeof text === 'string') return text === '' ? undefined : text
  const candidates = [text[locale], text[''], text['en']]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  // Any entry beats none: an author who wrote only `fr` still said something.
  for (const candidate of Object.values(text)) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/**
 * Resolve one localized value, falling back to a caller-supplied literal.
 * @param text - the value.
 * @param locale - the active locale id.
 * @param fallback - what to show when the value says nothing.
 * @returns the resolved text.
 */
export function resolveTextOr(text: LocalizedText | undefined, locale: string, fallback: string): string {
  return resolveText(text, locale) ?? fallback
}

/**
 * A package name shortened for a card title, when no display name was given.
 * The scope is noise on a card that is already inside "OMDSH Plugins", and the
 * `omdsh-` prefix is the same word repeated.
 * @param packageName - the full package name.
 * @returns the shortened title.
 */
export function shortName(packageName: string): string {
  const unscoped = packageName.startsWith('@') ? packageName.slice(packageName.indexOf('/') + 1) : packageName
  return unscoped.replace(/^omdsh-/, '')
}

/**
 * One plugin's card title: its declared display name, or its shortened package
 * name when it declared none.
 *
 * ## Why the case its author wrote is kept
 *
 * This folded every title to lowercase once, because the two sources disagree
 * by construction — a package name is lowercase kebab-case, and Title Case is
 * the reflex when writing a `displayName` — so a list mixing `sidechat` with
 * `Remote Control` read as a bug rather than a choice. Folding settled that by
 * throwing the author's answer away, and `remote control` reads like a shell
 * command rather than the name of a feature.
 *
 * The disagreement is settled at the source instead: every plugin in this repo
 * declares a display name, and the conventions say what one looks like (Title
 * Case, words spelled out rather than the package's abbreviation, translated
 * the way its summary is). What still reaches the fallback is a plugin that
 * declared nothing — one from outside this repo, or a harness bundle — and
 * rendering that verbatim is the honest answer: it is not a title anybody
 * wrote, it is an identifier, and identifiers are lowercase kebab-case because
 * that is what npm names are.
 * @param displayName - the plugin's declared display name, if any.
 * @param locale - the active locale id.
 * @param packageName - the package name, for the fallback.
 * @returns the title to render.
 */
export function resolveTitle(
  displayName: LocalizedText | undefined,
  locale: string,
  packageName: string,
): string {
  return resolveText(displayName, locale) ?? shortName(packageName)
}
