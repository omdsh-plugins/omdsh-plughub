/**
 * The local catalog source: a directory of plugin checkouts.
 *
 * This exists because a plugin's life starts on a disk, not on a registry. The
 * omdsh plugins this hub was written for were installed by hand, from a
 * sibling directory, with no git remote between them — and a hub that could
 * only offer what GitHub already published would have been useless on the
 * machine it was written on.
 *
 * It is also the only source whose specifiers are filesystem paths, and the
 * only one whose content this runtime authored: the paths are built HERE, from
 * a directory the deployment configured, so `isInstallableSpec`'s path arm is
 * reachable from nowhere else.
 *
 * ## Why it looks exactly one directory deep
 *
 * A configured root holds plugin checkouts, and a plugin checkout declares
 * `dsh.bundle.patch` in its own `package.json`. Anything that does not — a
 * harness checkout, a monorepo whose installable half is buried in
 * `packages/`, notes, a build output — is passed over.
 *
 * That leaves a monorepo plugin invisible here, and deliberately so: what a
 * monorepo usually holds is a bundle for a DIFFERENT surface, and a profile
 * composes exactly one surface. Point `localSources` straight at the inner
 * directory when you do want one offered.
 * @module @omdsh-plugins/omdsh-plughub/catalog/local
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseManifest } from '../manifest.ts'
import { isInstallableSpec, isPackageName, report, type SourceEntry, type SourceResult } from './source.ts'

/**
 * Scan one directory for plugin checkouts.
 *
 * A child directory qualifies when its `package.json` declares
 * `dsh.bundle.patch` — the same test `dsh plugin` applies when deciding
 * whether an installed dependency joins the profile's layer stack. Anything
 * else in the directory (a harness checkout, notes, a build output) is simply
 * not a plugin and is passed over without comment.
 * @param directory - the directory to scan, absolute or relative to cwd.
 * @returns the entries found and how the scan fared.
 */
export function scanLocalSource(directory: string): SourceResult {
  const root = resolve(directory)
  let children: string[]
  try {
    children = readdirSync(root, { withFileTypes: true })
      .filter(child => child.isDirectory() || child.isSymbolicLink())
      .map(child => child.name)
      .sort()
  } catch (error) {
    return { report: report('local', root, [], error), entries: [] }
  }
  const entries: SourceEntry[] = []
  for (const child of children) {
    if (child.startsWith('.') || child === 'node_modules') continue
    const packageDir = join(root, child)
    let text: string
    try {
      text = readFileSync(join(packageDir, 'package.json'), 'utf8')
    } catch {
      continue // not a package; the directory is allowed to hold other things
    }
    const facts = parseManifest(text)
    if (facts?.isBundle !== true || facts.name === undefined) continue
    if (!isPackageName(facts.name)) continue
    // Built here, from a configured root and a directory entry — never read
    // out of anybody's manifest. The check still runs, because a path with a
    // newline in it is a path this plugin declines to hand to pnpm.
    if (!isInstallableSpec(packageDir, true)) continue
    entries.push({
      name: facts.name,
      ...facts.version === undefined ? {} : { version: facts.version },
      ...facts.description === undefined ? {} : { description: facts.description },
      metadata: facts.metadata,
      spec: packageDir,
    })
  }
  return { report: report('local', root, entries), entries }
}

/**
 * Scan every configured local directory, newest configuration first.
 * @param directories - the configured roots.
 * @returns one result per directory, in configuration order.
 */
export function scanLocalSources(directories: readonly string[]): SourceResult[] {
  return directories.map(directory => scanLocalSource(directory))
}
