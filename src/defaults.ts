/**
 * The catalog defaults, in one place because two callers need them.
 *
 * The settings schema in `index.ts` is the plugin's answer to "how is this
 * configured", and it is the only answer while the hub is a Settings tab. The
 * CLI has no settings layer to read — it runs outside any profile's cordis
 * tree, often through `npx`, where the harness peer dependencies that
 * schemastery arrives with are not installed — so it cannot ask the schema
 * what its own defaults are.
 *
 * Restating them in the CLI would be two lists that agree until somebody
 * changes one. These constants are the list; both sides name them.
 * @module @omdsh-plugins/omdsh-plughub/defaults
 */

/** GitHub account enumerated when no registry manifest is configured. Empty disables enumeration. */
export const DEFAULT_UPSTREAM = ''

/**
 * Curated manifest URL.
 *
 * The collection already publishes every plugin in one file, and GitHub's raw
 * host plus API are the slow half of opening the tab — so the default is that
 * file, served from a CDN that caches GitHub, with enumeration off. Empty
 * derives the URL from {@link DEFAULT_UPSTREAM} instead
 * (`https://raw.githubusercontent.com/<account>/registry/HEAD/registry.json`).
 */
export const DEFAULT_REGISTRY_URL = 'https://cdn.jsdmirror.com/gh/omdsh-plugins/registry/registry.json'

/** Most repositories examined when enumerating an account. */
export const DEFAULT_MAX_REPOS = 100

/** Per-request timeout for every remote source, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000

/** How long a resolved catalog is reused, in milliseconds. */
export const DEFAULT_CACHE_TTL_MS = 300_000

/**
 * The profile a terminal means when it does not say.
 *
 * `web` rather than "the one this runtime booted from", because the CLI has
 * not booted from anything — it is a program a person ran, and the profile the
 * whole collection documents is this one.
 */
export const DEFAULT_PROFILE = 'web'
