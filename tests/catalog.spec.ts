/**
 * The catalog: what a source may say, what the merge does with it, and the one
 * property the whole install path rests on — that a specifier comes from the
 * Host's own resolution and never from a request.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_METADATA, type CatalogSource } from '../src/contract.ts'
import { Catalog, catalogOptions, mergeSources, toDocument } from '../src/catalog/index.ts'
import { readRegistryDocument, readRegistryRow, defaultRegistryUrl } from '../src/catalog/registry.ts'
import { readRepoListing } from '../src/catalog/github.ts'
import { scanLocalSource } from '../src/catalog/local.ts'
import { isGitSpec, isInstallableSpec, isPackageName, type SourceEntry, type SourceResult } from '../src/catalog/source.ts'

const temporaries: string[] = []

afterEach(() => {
  while (temporaries.length > 0) rmSync(temporaries.pop() as string, { recursive: true, force: true })
})

/** A scratch directory removed after the test. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plughub-catalog-'))
  temporaries.push(dir)
  return dir
}

/** One entry, with only what the assertion cares about spelled out. */
function entry(name: string, overrides: Partial<SourceEntry> = {}): SourceEntry {
  return { name, metadata: EMPTY_METADATA, spec: `github:owner/${name}`, ...overrides }
}

/** One source result, tagged for the merge. */
function result(source: CatalogSource, entries: SourceEntry[]): readonly [CatalogSource, SourceResult] {
  return [source, { report: { source, origin: source, ok: true, count: entries.length }, entries }]
}

describe('isInstallableSpec', () => {
  it('accepts the forms a catalog legitimately names', () => {
    expect(isInstallableSpec('github:omdsh-plugins/omdsh-shortcuts')).toBe(true)
    expect(isInstallableSpec('github:omdsh-plugins/omdsh-shortcuts#v1.2.0')).toBe(true)
    expect(isInstallableSpec('git+https://github.com/a/b.git')).toBe(true)
    expect(isInstallableSpec('@omdsh-plugins/omdsh-shortcuts')).toBe(true)
    expect(isInstallableSpec('omdsh-shortcuts@0.1.0')).toBe(true)
  })

  it('refuses an argument that would be read as an option', () => {
    // The whole reason this allowlist exists: a specifier reaches an argv,
    // and a leading dash is where argument injection lives.
    expect(isInstallableSpec('--config.foo=bar')).toBe(false)
    expect(isInstallableSpec('-g')).toBe(false)
  })

  it('refuses whitespace, however well-formed the rest looks', () => {
    expect(isInstallableSpec('pkg@1 --global')).toBe(false)
    expect(isInstallableSpec('pkg\n--global')).toBe(false)
  })

  it('admits a filesystem path only for the local source', () => {
    expect(isInstallableSpec('/Users/me/checkouts/omdsh-x', true)).toBe(true)
    // A remote manifest naming a path would install whatever this machine
    // happens to have lying there.
    expect(isInstallableSpec('/Users/me/checkouts/omdsh-x')).toBe(false)
    expect(isInstallableSpec('../evil')).toBe(false)
  })

  it('refuses the empty and the absurd', () => {
    expect(isInstallableSpec('')).toBe(false)
    expect(isInstallableSpec('x'.repeat(600))).toBe(false)
  })
})

describe('isGitSpec', () => {
  it('recognizes the specifiers whose install runs a prepare script', () => {
    expect(isGitSpec('github:a/b')).toBe(true)
    expect(isGitSpec('git+https://github.com/a/b.git')).toBe(true)
    expect(isGitSpec('https://github.com/a/b.git#main')).toBe(true)
    expect(isGitSpec('@scope/pkg')).toBe(false)
    expect(isGitSpec('/abs/path')).toBe(false)
  })
})

describe('isPackageName', () => {
  it('accepts scoped and unscoped names, and refuses the rest', () => {
    expect(isPackageName('@omdsh-plugins/omdsh-shortcuts')).toBe(true)
    expect(isPackageName('omdsh-shortcuts')).toBe(true)
    expect(isPackageName('../evil')).toBe(false)
    expect(isPackageName('has space')).toBe(false)
    expect(isPackageName(`a${'b'.repeat(300)}`)).toBe(false)
  })
})

describe('readRegistryRow', () => {
  it('derives the specifier from the repository when none is given', () => {
    expect(readRegistryRow({ name: '@x/omdsh-a', repo: 'omdsh-plugins/omdsh-a' })?.spec)
      .toBe('github:omdsh-plugins/omdsh-a')
  })

  it('carries a declared specifier through', () => {
    expect(readRegistryRow({ name: 'omdsh-a', spec: 'omdsh-a@1.0.0' })?.spec).toBe('omdsh-a@1.0.0')
  })

  it('drops a row whose specifier is not allowlisted', () => {
    expect(readRegistryRow({ name: 'omdsh-a', spec: '--force' })).toBeUndefined()
    expect(readRegistryRow({ name: 'omdsh-a', spec: '/etc/passwd' })).toBeUndefined()
  })

  it('drops a row with no way to install it', () => {
    expect(readRegistryRow({ name: 'omdsh-a' })).toBeUndefined()
  })

  it('reads the plughub metadata the row carries', () => {
    const row = readRegistryRow({
      name: 'omdsh-a',
      repo: 'o/omdsh-a',
      plughub: { displayName: 'A', settings: ['omdsh-a'], order: 3 },
    })
    expect(row?.metadata.displayName).toBe('A')
    expect(row?.metadata.order).toBe(3)
  })
})

describe('readRegistryDocument', () => {
  it('reads both the wrapped and the bare form', () => {
    const rows = [{ name: 'omdsh-a', repo: 'o/omdsh-a' }]
    expect(readRegistryDocument({ plugins: rows })).toHaveLength(1)
    expect(readRegistryDocument(rows)).toHaveLength(1)
  })

  it('keeps the first of two rows naming one package', () => {
    const entries = readRegistryDocument([
      { name: 'omdsh-a', repo: 'first/omdsh-a' },
      { name: 'omdsh-a', repo: 'second/omdsh-a' },
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.repo).toBe('first/omdsh-a')
  })

  it('costs one bad row exactly one row', () => {
    const entries = readRegistryDocument([
      { name: 'omdsh-a', repo: 'o/omdsh-a' },
      { name: '../evil', spec: '--force' },
      { name: 'omdsh-b', repo: 'o/omdsh-b' },
    ])
    expect(entries.map(candidate => candidate.name)).toEqual(['omdsh-a', 'omdsh-b'])
  })

  it('reads nothing out of a document that is not one', () => {
    expect(readRegistryDocument({ nope: 1 })).toEqual([])
    expect(readRegistryDocument('text')).toEqual([])
  })
})

describe('defaultRegistryUrl', () => {
  it('points at the upstream account\'s registry repository', () => {
    expect(defaultRegistryUrl('omdsh-plugins'))
      .toBe('https://raw.githubusercontent.com/omdsh-plugins/registry/HEAD/registry.json')
  })
})

describe('readRepoListing', () => {
  it('keeps ordinary repositories', () => {
    expect(readRepoListing([{ name: 'omdsh-a', description: 'x', archived: false, fork: false }]))
      .toEqual([{ name: 'omdsh-a', description: 'x', archived: false, fork: false }])
  })

  it('skips archives and forks', () => {
    const rows = readRepoListing([
      { name: 'gone', archived: true, fork: false },
      { name: 'theirs', archived: false, fork: true },
      { name: 'mine', archived: false, fork: false },
    ])
    expect(rows.map(row => row.name)).toEqual(['mine'])
  })

  it('reads nothing out of an error body', () => {
    expect(readRepoListing({ message: 'API rate limit exceeded' })).toEqual([])
  })
})

describe('scanLocalSource', () => {
  it('offers every child directory that declares a bundle patch', () => {
    const root = scratch()
    mkdirSync(join(root, 'omdsh-a'))
    writeFileSync(join(root, 'omdsh-a', 'package.json'), JSON.stringify({
      name: '@x/omdsh-a', version: '0.1.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    mkdirSync(join(root, 'not-a-plugin'))
    writeFileSync(join(root, 'not-a-plugin', 'package.json'), JSON.stringify({ name: 'lib' }))
    mkdirSync(join(root, 'notes'))

    const scanned = scanLocalSource(root)
    expect(scanned.report.ok).toBe(true)
    expect(scanned.entries).toHaveLength(1)
    expect(scanned.entries[0]?.name).toBe('@x/omdsh-a')
    // The specifier is the absolute checkout path — built here, not read out
    // of anybody's manifest.
    expect(scanned.entries[0]?.spec).toBe(join(root, 'omdsh-a'))
  })

  it('reports an unreadable directory instead of throwing', () => {
    const scanned = scanLocalSource(join(scratch(), 'absent'))
    expect(scanned.report.ok).toBe(false)
    expect(scanned.entries).toEqual([])
  })

  it('skips dotfiles and node_modules', () => {
    const root = scratch()
    for (const child of ['.git', 'node_modules']) {
      mkdirSync(join(root, child))
      writeFileSync(join(root, child, 'package.json'), JSON.stringify({
        name: 'sneaky', dsh: { bundle: { patch: './p.yml' } },
      }))
    }
    expect(scanLocalSource(root).entries).toEqual([])
  })
})

describe('mergeSources', () => {
  it('lets the higher-precedence source win outright', () => {
    const merged = mergeSources([
      result('github', [entry('omdsh-a', { version: '9.9.9', spec: 'github:o/omdsh-a' })]),
      result('local', [entry('omdsh-a', { version: '0.0.1', spec: '/checkouts/omdsh-a' })]),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.source).toBe('local')
    expect(merged[0]?.entry.spec).toBe('/checkouts/omdsh-a')
    expect(merged[0]?.entry.version).toBe('0.0.1')
  })

  it('lets a losing source fill in a repository the winner lacks', () => {
    const merged = mergeSources([
      result('github', [entry('omdsh-a', { repo: 'omdsh-plugins/omdsh-a' })]),
      result('local', [entry('omdsh-a', { spec: '/checkouts/omdsh-a' })]),
    ])
    expect(merged[0]?.source).toBe('local')
    expect(merged[0]?.entry.spec).toBe('/checkouts/omdsh-a')
    // A checkout rarely knows where it is published; the card's link is
    // nicer for the loser having said so.
    expect(merged[0]?.entry.repo).toBe('omdsh-plugins/omdsh-a')
  })

  it('sorts by declared order, then by name', () => {
    const ordered = mergeSources([result('registry', [
      entry('omdsh-z', { metadata: { ...EMPTY_METADATA, order: 0 } }),
      entry('omdsh-a', { metadata: { ...EMPTY_METADATA, order: 5 } }),
      entry('omdsh-b', { metadata: { ...EMPTY_METADATA, order: 0 } }),
    ])])
    expect(ordered.map(candidate => candidate.entry.name)).toEqual(['omdsh-b', 'omdsh-z', 'omdsh-a'])
  })
})

describe('toDocument', () => {
  it('marks what is installed and carries no specifier', () => {
    const merged = mergeSources([result('local', [entry('omdsh-a', { spec: '/checkouts/omdsh-a' })])])
    const document = toDocument(merged, [], new Map([['omdsh-a', {}]]), 3)
    expect(document.entries[0]?.installed).toBe(true)
    expect(document.generation).toBe(3)
    // The specifier stops at the Host. There is no request shape that can
    // carry one, and this is the structural half of that guarantee.
    expect(JSON.stringify(document)).not.toContain('/checkouts/omdsh-a')
  })

  it('says nothing about updates for a plugin this profile does not have', () => {
    // "No update" and "not installed" are different answers; collapsing them
    // would put a disabled Update button beside every Install button.
    const merged = mergeSources([result('local', [entry('omdsh-a', { version: '2.0.0' })])])
    const document = toDocument(merged, [], new Map(), 1)
    expect(document.entries[0]?.update).toBeUndefined()
    expect(document.entries[0]?.installedVersion).toBeUndefined()
  })

  it('offers an update when the source is ahead of the profile', () => {
    const merged = mergeSources([result('registry', [entry('omdsh-a', { version: '0.2.0' })])])
    const document = toDocument(merged, [], new Map([['omdsh-a', { version: '0.1.0', spec: '^0.1.0' }]]), 1)
    expect(document.entries[0]?.update).toBe('available')
    // Both halves ride, so the card can say which way the arrow points.
    expect(document.entries[0]?.installedVersion).toBe('0.1.0')
    expect(document.entries[0]?.version).toBe('0.2.0')
  })

  it('reports a checkout install as linked rather than as up to date', () => {
    // The files ARE the source's files, so there is nothing to fetch — and
    // "up to date" would suggest an update could ever have been needed.
    const merged = mergeSources([result('local', [entry('omdsh-a', { version: '0.1.0' })])])
    const document = toDocument(merged, [], new Map([
      ['omdsh-a', { version: '0.1.0', spec: 'link:/checkouts/omdsh-a' }],
    ]), 1)
    expect(document.entries[0]?.update).toBe('linked')
  })
})

describe('Catalog', () => {
  /** A registry manifest served from memory. The url is named so calls can be asserted. */
  const serving = (body: unknown, ok = true) => vi.fn(async (_url: string) => ({
    ok,
    status: ok ? 200 : 404,
    text: () => Promise.resolve(JSON.stringify(body)),
  }))

  const options = (registryUrl: string) => catalogOptions({
    upstream: '',
    registryUrl,
    localSources: [],
    maxRepos: 10,
    timeoutMs: 1000,
  })

  it('answers a specifier only for what it resolved', async () => {
    const catalog = new Catalog(
      options('https://registry.invalid/registry.json'),
      serving({ plugins: [{ name: 'omdsh-a', repo: 'o/omdsh-a' }] }),
      60_000,
    )
    expect((await catalog.specFor('omdsh-a'))?.entry.spec).toBe('github:o/omdsh-a')
    // The enforcement of "the catalog is the allowlist": a name nobody
    // offered has no specifier here, so there is nothing to run.
    expect(await catalog.specFor('anything-else')).toBeUndefined()
  })

  it('reuses a resolution until the ttl lapses', async () => {
    let now = 0
    const fetchImpl = serving({ plugins: [{ name: 'omdsh-a', repo: 'o/omdsh-a' }] })
    const catalog = new Catalog(options('https://registry.invalid/r.json'), fetchImpl, 1000, () => now)
    await catalog.document(new Map())
    await catalog.document(new Map())
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    now = 1001
    await catalog.document(new Map())
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('resolves afresh when asked to refresh', async () => {
    const fetchImpl = serving({ plugins: [] })
    const catalog = new Catalog(options('https://registry.invalid/r.json'), fetchImpl, 60_000, () => 0)
    await catalog.document(new Map())
    await catalog.document(new Map(), true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('collapses concurrent readers onto one resolution', async () => {
    const fetchImpl = serving({ plugins: [] })
    const catalog = new Catalog(options('https://registry.invalid/r.json'), fetchImpl, 60_000, () => 0)
    await Promise.all([catalog.document(new Map()), catalog.document(new Map()), catalog.document(new Map())])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reports an unreachable source rather than failing the catalog', async () => {
    const catalog = new Catalog(options('https://registry.invalid/r.json'), serving({}, false), 60_000, () => 0)
    const document = await catalog.document(new Map())
    expect(document.entries).toEqual([])
    expect(document.sources[0]?.ok).toBe(false)
    // Shown verbatim, because "404" and "rate limited" call for different
    // things from the person reading it.
    expect(document.sources[0]?.error).toContain('404')
  })

  it('drops the cache when the configuration changes', async () => {
    const fetchImpl = serving({ plugins: [] })
    const catalog = new Catalog(options('https://registry.invalid/a.json'), fetchImpl, 60_000, () => 0)
    await catalog.document(new Map())
    catalog.reconfigure(options('https://registry.invalid/b.json'), 60_000)
    await catalog.document(new Map())
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://registry.invalid/b.json')
  })

  it('adopts the ttl with the rest of the configuration', async () => {
    let now = 0
    const fetchImpl = serving({ plugins: [] })
    const catalog = new Catalog(options('https://registry.invalid/r.json'), fetchImpl, 60_000, () => now)
    await catalog.document(new Map())
    // The panel offers this field, and the namespace applies `live`: the
    // minute the composition entry asked for must not outlive the second the
    // person just configured.
    catalog.reconfigure(options('https://registry.invalid/r.json'), 1000)
    await catalog.document(new Map())
    now = 1001
    await catalog.document(new Map())
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})

describe('catalogOptions', () => {
  it('derives the registry url from the upstream account', () => {
    expect(catalogOptions({ upstream: 'omdsh-plugins', localSources: [], maxRepos: 1, timeoutMs: 1 }).registryUrl)
      .toBe('https://raw.githubusercontent.com/omdsh-plugins/registry/HEAD/registry.json')
  })

  it('leaves an explicit url alone, and disables the source when there is no upstream', () => {
    expect(catalogOptions({
      upstream: 'x', registryUrl: 'https://elsewhere.invalid/r.json', localSources: [], maxRepos: 1, timeoutMs: 1,
    }).registryUrl).toBe('https://elsewhere.invalid/r.json')
    expect(catalogOptions({ upstream: '', localSources: [], maxRepos: 1, timeoutMs: 1 }).registryUrl).toBe('')
  })
})
