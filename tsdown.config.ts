/**
 * Three artifacts from one package:
 *
 * - `lib/index.js` + `lib/contract.js` — the NODE half, imported by the host
 *   Loader from the emitted `lib/types` JavaScript. Unlike a UI-only plugin
 *   this half carries real behaviour: it resolves the profile, reads the
 *   catalog, and runs installs.
 * - `lib/client.js` — the BROWSER half, a closure-factory artifact fetched
 *   outside any module graph. It calls `window.__ModuleLoader__.load({id,
 *   factory})` and resolves its externals through the injected `require`, so
 *   the platform modules it shares with the shell stay ONE instance.
 *
 * This config is a standalone restatement of the harness's own
 * `packages/client/tsdown.client.ts`. It is a sibling repository, so it
 * cannot import that preset; the values below are the contract with the
 * shell's module table and must track it.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'tsdown'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** This bundle's id: the package name, and the module-table key the shell fetches it under. */
const ID = '@omdsh-plugins/omdsh-plughub'

/**
 * The specifiers the shell seeds into the frozen module table. Mirrors
 * `@deepseek-ai/dsh-client-web/src/platform`, plus the documented
 * runtime-store exemption every UI plugin rides. Anything NOT listed here is
 * inlined: a `require()` the table cannot answer throws at factory time.
 */
const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Wire/type layers a client bundle may inline: no runtime identity to share. */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/
/** Generated descriptor/codec contribution, likewise identity-free. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/**
 * Virtual-id wrapper keeping stylesheets away from tsdown's own css pipeline
 * (its guard matches ids ending in `.css`, so the virtual id must not).
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** The node half, emitted from the JavaScript tsc already wrote to lib/types. */
const nodeHalf: UserConfig = {
  name: ID,
  entry: ['lib/types/index.js', 'lib/types/contract.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

/** The browser half, compiled from source straight into the loader artifact. */
const browserHalf: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  // Lands beside the node half; `clean` must stay off or it wipes that output.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  // Types ship from lib/types (tsc); a dts pass here would wrap the
  // banner/footer into .d.cts and break parsing.
  dts: false,
  // Fetched outside Vite's module graph, so the bundle carries its own map.
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  // tsdown auto-externalizes package dependencies; the rule here is the table
  // itself — no opinion for its entries (the `external` above wins), inline
  // everything else. This package declares no runtime dependency, so in
  // practice nothing but its own sources is inlined.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [{
    // Bundle purity gate: a cross-plugin value import either inlines a second
    // copy of another plugin's runtime or asks the frozen table for a
    // specifier it cannot answer. Collaboration goes through cordis services
    // and the slot system; type-only imports are erased and never reach here.
    //
    // The `node:` arm is this package's own addition: unlike a UI-only
    // plugin, half of these sources DO import node builtins, and a stray
    // import from src/client/ into src/ would drag `node:child_process` into
    // a browser bundle. tsc cannot see the split (both halves are one
    // program, `types: ["node"]`), so the bundler is where it is observable.
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (source.startsWith('node:')) {
        throw new Error(
          `client bundle purity: "${source}" is a node builtin reached from the browser half — `
          + 'the host half owns every filesystem, process, and profile concern',
        )
      }
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a platform module, an inline-safe wire layer, or a generated /remote contribution — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services',
      )
    },
  }, {
    // Stylesheets compiled in-bundle. A `*.module.css` import yields the
    // hashed class map; the injected <style data-plugin> tag is what the
    // loader removes on unload.
    name: 'dsh-css-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css')) return null
      if (importer === undefined || source.startsWith('\0')) return CSS_VIRTUAL_PREFIX + source + CSS_VIRTUAL_SUFFIX
      if (!source.startsWith('.')) {
        throw new Error(`dsh-css-inline: "${source}" is a bare stylesheet specifier; this package imports only its own`)
      }
      return CSS_VIRTUAL_PREFIX + resolvePath(dirname(importer), source) + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // The virtual id otherwise hides the stylesheet from the watch graph.
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const isModule = fileId.endsWith('.module.css')
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        ...(isModule ? { cssModules: { pattern: '[hash]_[local]' } } : {}),
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exported] of Object.entries(cssExports ?? {})) classMap[local] = exported.name
      const tagId = `${ID}/${basename(fileId)}`
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

/**
 * The CLI, emitted beside the other two.
 *
 * Its own config rather than a third entry on {@link nodeHalf}, because the
 * hashbang is an output banner and a banner is per-config: on the shared one
 * it would land at the top of `lib/index.js` too, which the Loader imports.
 * The cost is that the two artifacts inline their own copy of what they share;
 * these are node-side pure functions with no runtime identity to keep single,
 * so a second copy changes nothing but bytes.
 */
const cliHalf: UserConfig = {
  name: `${ID}/cli`,
  entry: ['lib/types/cli.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  outputOptions: { banner: '#!/usr/bin/env node' },
}

export default defineConfig([nodeHalf, browserHalf, cliHalf])
