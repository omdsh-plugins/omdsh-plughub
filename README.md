# omdsh-plughub

English | [中文](README.zh.md)

A plugin hub inside the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
Settings: one more tab beside the shipped Plugins pages, listing what you can
install from a configurable upstream, and configuring everything already
installed.

Installing a plugin used to be `dsh plugin --profile web add <path>` in a
terminal, and configuring one used to be editing a profile's `cordis.patch.yml`
by hand. This makes both a page.

## What it adds

| Surface | Where it comes from |
|---|---|
| A third tab in Settings → Plugins, **Plugin hub** | An entry in `settings.plugins.tab`, the seat ui-settings declares for inventory and configuration plugins |
| The merged catalog, and what each source reported | `GET /api/plughub/catalog`, resolved from the `local`, `registry` and `github` sources |
| Install, Update and Remove on every card | `POST /api/plughub/install`, `/update` and `/uninstall`, each shelling out to `dsh plugin --profile <name>` |
| A configuration form for every installed plugin | `GET`/`POST /api/plughub/settings`, carrying `ctx.settings.describe({ redactSecrets: true })` and `ctx.settings.mutate` |
| Operation progress and the restart banner | `GET /api/plughub/events`, an event stream |
| The `omdsh.plugin.card` slot | `ctx.slots`, where a plugin whose control the generic form cannot draw registers its own face |
| Its own settings namespace, `omdsh-plughub` | `ctx.settings.register`, rendered by the same generic form every other plugin gets |

Two strings name this package on that page, one word apart, and the difference
is a convention rather than an accident. The tab reads **Plugin hub**: it is
settings chrome, so it takes the sentence case of the tab the harness ships
beside it, **Plugin list**. **Plugin Hub** is this package's own
`dsh.plughub.displayName`, which titles exactly one card in the installed list —
the card for this plugin itself, drawn by the same code that titles every other
card from the same field, and Title Case is what [rule 5](https://omdsh-plugins.github.io/conventions/?lang=en#rule-5)
asks of every `displayName` here. Nothing in the harness is modified: the tab is
a published seat, and removing the row hands it straight back.

## The idea

The hard part of a plugin hub is not the install button. It is the second half:
once a plugin is installed, where does its configuration UI come from?

Two answers were possible. Every plugin could ship a card for this panel — but
then a plugin published after this one shows up with nothing to click, and this
package grows an entry per plugin forever. Or the panel could read what the
plugin ALREADY declares.

The harness makes the second answer available, because it already has a
user-settings seam. A plugin registers a namespace with a [schemastery] schema;
`ctx.settings.describe({ redactSecrets: true })` hands back that schema together
with the current value, the composition base, the raw user layer, the redacted
secret slots, and a revision. That is the complete input a configuration form
needs.

So this package renders forms and installs packages, and knows nothing about
any particular plugin. A plugin written next year gets a configuration page the
day it is installed, having done nothing but follow
[the conventions](https://omdsh-plugins.github.io/conventions/?lang=en).

```
  plugin (host half)          plughub (host half)        plughub (browser half)
  ──────────────────          ───────────────────        ──────────────────────
  ctx.settings.register(      describe(redact) ────────→ rehydrateSchema
    'omdsh-shortcuts',                                    ─→ plan ─→ controls
    Config,                   settings.mutate  ←──────── one path-addressed edit
    { base: entryConfig })
```

Nothing in the left column mentions this package; nothing in the right column
mentions chords.

### The middle column, and why it is there

That middle step ought to be nothing at all. The harness publishes the same
seam straight to the browser, and this hub would use it — except that
`settings.describe` and `settings.mutate` are gated by a hard-coded allowlist
of namespace NAMES in `dsh-host-apiproxy`. Its own comment is unambiguous:

> adding a section to that page is a decision made here rather than by the
> registering plugin. Moving that declaration to `settings.register()`, so a
> plugin can expose its own configuration without a change in this package, is
> deferred work.

No out-of-tree namespace can be in that list, so a hub built on it could
configure only the plugins the harness already knew about — the one thing this
hub exists not to be. It therefore carries the seam over a route of its own.

It carries transport and nothing else: validation, layering, redaction,
revisions, and commits all stay in `ctx.settings`. And the boundary it draws is
narrower than the one it stands in for — a namespace is reachable only when an
INSTALLED bundle declares it under `dsh.plughub.settings`, so `shell` and
`agent-loop` are registered in the same process and unreachable here. When that
deferred work lands upstream, this route becomes redundant and deletable
without touching a single plugin.

## What the tab shows

**Catalog sources** — this plugin's own configuration, at the top, because
these fields are the answer to "where does the list below come from". It is an
ordinary settings namespace rendered by the same generic form every other
plugin gets; it simply sits here instead of in the installed list, so nobody
looking at an empty catalog has to hunt for the control that fixes it. It opens
itself once when every source failed or nothing came back.

**Available** — the merged catalog, with Install, Update, and Remove. A card's
title, summary, and documentation link are the plugin's own, read from its
`dsh.plughub` manifest section and resolved for the active locale.

**Installed** — one row per bundle this profile has composed. Expanding it
shows a form built from that plugin's settings schema; a plugin that registered
no namespace says so, which is a real answer rather than an empty box.

A change to the profile puts a restart banner at the top. Plugin layers are
composed at boot and only the user patch layers are watched, so a newly
installed bundle genuinely cannot be hot-mounted — saying "restart" is the
honest report, not a limitation being papered over.

## Updates

The Update button sits left of Remove and is grey until there is something to
fetch. Which it is, is decided on the Host from two numbers it already holds —
the version the winning catalog source advertises, and the version of the
package on disk — compared by semver, not by string order (`0.10.0` is newer
than `0.9.0`, and `1.0.0` is newer than `1.0.0-rc.2`).

| State | The card shows | The button |
|---|---|---|
| `available` | `0.1.0 → 0.2.0` | Highlighted |
| `current` | the one version | Grey: up to date |
| `linked` | the one version | Grey: installed from a directory on this machine, so its files already ARE the source |
| `unknown` | whatever version is known | Grey: this source publishes no version to compare against |

An update runs the same `dsh plugin add` an install does — `pnpm` re-resolves a
dependency that is already there, which for a registry specifier means the
latest published version and for a git one means whatever the ref now points
at. It is its own route because the preconditions are opposite: an install
refuses a package the profile has, an update requires it.

Afterwards the restart banner appears. An update changes no bundle LIST — the
same package name, different code behind it — so the usual comparison would
miss the one operation that swaps running code out from under the process; the
runtime latches it instead. Conservative on purpose: an update that fetched the
same version costs a needless restart, and the other way costs somebody running
code they believe they replaced.

`linked` is what a checkout install looks like, and `dsh plugin add <path>`
records `link:`. So a profile assembled from local directories will show every
Update button grey, correctly — editing the checkout is already editing the
plugin.

## Where the catalog comes from

Three sources, merged on the package name, highest precedence first:

| Source | What it is | Why it exists |
|---|---|---|
| `local` | Directories of plugin checkouts | The copy you are editing beats the copy somebody published |
| `registry` | One curated JSON manifest | One request, full metadata, and the upstream's chance to say what it recommends |
| `github` | Repository enumeration | Zero maintenance: push a plugin repo to the account and it appears |

A losing source still contributes its `repo` when the winner has none — a local
checkout rarely knows where it is published, and the card's link is nicer for
it.

Out of the box both remote sources point at
[`github.com/omdsh-plugins`](https://github.com/omdsh-plugins), the account this
collection is published under: `upstream` defaults to `omdsh-plugins`, and
`registryUrl` derives from it as
`https://raw.githubusercontent.com/omdsh-plugins/registry/HEAD/registry.json`.
So installing this one plugin is the whole bootstrap — the rest of the
collection is in the catalog the first time the tab is opened, with nothing to
configure. Point `upstream` at your own account to publish a collection of your
own, or empty it to run on `localSources` alone.

A local source is scanned exactly one directory deep, so a monorepo whose
installable half sits in `packages/` is not offered. That is usually right —
what a monorepo here holds is a bundle for a DIFFERENT surface, and a profile
composes one surface. Point `localSources` at the inner directory when you do
want one listed.

A source that fails is REPORTED rather than hidden. "No plugins here" and
"GitHub rate-limited this account" look identical on an empty list, and only
one of them resolves itself.

With one exception, in the other direction: a **404 on a derived manifest URL**
is absence, not failure. Publishing no curated manifest is the ordinary state of
an upstream account, enumeration is what covers it, and a red row under every
default install — naming a file nobody ever promised — would only teach people
to ignore the place failures are reported. A URL somebody typed into
`registryUrl` is the opposite case: they meant a manifest to be there, so a 404
on it is reported like any other.

The registry manifest is `{ "plugins": [...] }` (or a bare array):

```json
{
  "plugins": [
    {
      "name": "@omdsh-plugins/omdsh-shortcuts",
      "repo": "omdsh-plugins/omdsh-shortcuts",
      "version": "0.1.0",
      "plughub": { "displayName": { "": "Shortcuts", "zh": "快捷键" }, "order": 10 }
    }
  ]
}
```

`spec` may be given explicitly; omitted, it is `github:<repo>`.

The manifest this account publishes lives in
[`omdsh-plugins/registry`](https://github.com/omdsh-plugins/registry), generated
from the plugins' own `package.json` files rather than kept by hand.

## The routes it holds

| Route | Method | What it does |
|---|---|---|
| `/api/plughub/catalog` | GET | The merged catalog. `?refresh=1` consults every source again |
| `/api/plughub/installed` | GET | This profile's bundles, and which of them can be removed |
| `/api/plughub/install` | POST | `{ id }` — install one catalog entry |
| `/api/plughub/update` | POST | `{ name }` — reinstall one installed plugin from what the catalog offers now |
| `/api/plughub/uninstall` | POST | `{ name }` — remove one dependency-managed bundle |
| `/api/plughub/events` | GET | Operation progress, the restart flag, and settings invalidations, as an event stream |
| `/api/plughub/settings` | GET | Every namespace an installed plugin owns, redacted |
| `/api/plughub/settings` | POST | `{ ns, ops, expectedRevision }` — one path-addressed edit |

## Reach

The read routes carry the same fence `/api` carries: a Host header naming us —
loopback, or an authority this deployment was told to serve — plus same-origin
browser markers. They are exactly as reachable as the settings panel that
renders them.

The write routes are **loopback only**, whatever `--trusted-host` says. Each of
them changes this machine: an install runs that package's `prepare` script, and
a settings write persists to the Host document. "The deployment published
`/api` to the LAN" is not consent to either. Someone who genuinely wants to
install over a published `dsh web` still can, from a terminal, where the
decision is visibly theirs.

And a write names something the Host already resolved. An install names a
catalog ENTRY, never a package specifier — the Host looks the specifier up in
the catalog it resolved itself, so no request can reach a package the
configured upstreams did not offer, and there is no request shape that can
carry a specifier at all. A settings write names a namespace an INSTALLED
plugin declares it owns. Both allowlists are structural rather than checks
somebody has to remember to write.

## How an install actually runs

It shells out to `dsh plugin --profile <name> add <spec>`.

`pnpm add` is only half of an install; the other half is reconciling
`dsh.profile.bundles` against what is now on disk, and that reconciliation
belongs to the launcher this runtime was started by. Reimplementing it here
would mean carrying a copy that has to track a program the user upgrades
independently, and getting it wrong means a profile that boots without the
plugin it just "installed".

One thing this package does have to know: pnpm ≥10 refuses to run a
dependency's install scripts until they are allowlisted, and a git-hosted dsh
plugin BUILDS ITSELF in `prepare` — its published tree has no `lib/`. So a git
install that is not allowlisted succeeds, writes the dependency, reconciles the
bundle list, and then the next boot dies on `Cannot find module .../lib/index.js`.
The `allowBuilds` entry is written into the profile's `pnpm-workspace.yaml`
BEFORE the install, because the failure arrives one restart later than the
mistake.

The package NAME is the right entry for a registry dependency and not enough
for a git one. pnpm keys a git-hosted package by the tarball it resolved —
`@scope/name@https://codeload.github.com/owner/repo/tar.gz/<sha>` — and refuses
an allowlist naming anything else, so the entry written ahead of the install is
correct in form and inert in fact. That commit is not knowable beforehand
without re-implementing pnpm's resolution, and it changes on every push.

So the name goes in first, and if pnpm refuses anyway it is asked. Its refusal
prints the exact key it wants; that key is read back, written, and the install
runs again.

It runs again as many times as it keeps learning something, because pnpm
reports the refusals it REACHED rather than the ones it would reach next. A
plugin with a native dependency is blocked on that dependency first and on its
own `prepare` only once the dependency is allowed — `omdsh-remdev` takes three
passes for exactly that reason. Progress is the loop's condition, not a count:
an entry already set to `true` is nothing new to write, so the loop ends the
moment an attempt teaches it nothing, and a bound of four is a backstop rather
than the thing that stops a healthy install.

One thing pnpm does that has to be answered rather than read: it writes the
blocked package into that file ITSELF, valued `set this to true or false`. That
is a question, and the person who pressed Install already answered it, so the
value is replaced rather than treated as an entry that already exists.

Operations run one at a time: two `pnpm` runs in one directory race over the
same lockfile, and the loser's diagnostic describes the race rather than
anything the person did.

## Which controls the form draws

| Schema node | Control |
|---|---|
| `string` | Text field |
| `string` with `role('secret')` | Write-only field; the Host reports only whether a value is stored |
| `number` | Number field, honoring `min` / `max` / `step` |
| `boolean` | Checkbox |
| `union` of constants | Select |
| `array(string)` | Editable list |
| `dict(string)` | Editable key/value rows |
| `object` | Heading plus indented children, to three levels |
| anything else | Read-only JSON, with a pointer at the settings document |

The last row is deliberate. A generic form that guesses at an arbitrary schema
produces controls that silently write the wrong shape, and a settings write
that passes validation while meaning something else is worse than no control
at all. A plugin that needs a control this form will not draw registers a card
in `omdsh.plugin.card` instead — see rule 6 of [the conventions](https://omdsh-plugins.github.io/conventions/?lang=en#rule-6).

Every write is one path-addressed op carrying the revision this panel read.
Path-addressed rather than wholesale because what the panel received was
redacted: a `replace` rebuilt from what is on screen would delete every secret
the wire never sent. Revision-carrying because two surfaces can hold this panel
open at once, and without it the second writer silently overwrites the first —
with it, the second is refused, re-reads, and shows the current value.

A field's TITLE is derived from its property name (`maxRepos` → `Max repos`)
and the schema's description goes underneath it. Schemastery descriptions are
sentences, and a sentence makes a poor label; this way a schema author writes
one thing and it lands where it reads well.

## Configuring it

This plugin follows its own conventions, so it configures itself in its own
panel — under **Catalog sources**, at the top of the tab. Every field but one is
reachable from there without touching a file; the same fields can still be set
as the composition entry in `cordis.patch.yml`, which becomes the base layer
the panel writes over. Namespace `omdsh-plughub`:

| Field | Default | What it does |
|---|---|---|
| `upstream` | `omdsh-plugins` | GitHub account enumerated as the fallback source; empty disables it |
| `registryUrl` | derived | The curated manifest; empty derives it from `upstream` |
| `localSources` | `[]` | Directories of plugin checkouts to offer |
| `githubToken` | — | Lifts the 60-per-hour anonymous rate limit (secret) |
| `maxRepos` | `100` | Most repositories examined when enumerating |
| `timeoutMs` | `10000` | Per-request timeout for remote sources |
| `cacheTtlMs` | `300000` | How long a resolved catalog is reused |
| `profileDir` | derived | The profile to manage; empty uses the one this runtime booted from. Composition only — see below |
| `launcher` | derived | Path to `dsh`; empty uses the running runtime, then `PATH` |
| `pnpmPath` | derived | Path to `pnpm`; empty searches the runtime, the profile, and the usual install locations |

`profileDir` is the one field the panel does not offer. Which profile this
runtime manages is settled when the plugin mounts — the installer, the routes,
and the bundle list a restart is judged against are all bound to it, and the
settings layer is resolved after that. So it is `.hidden()` from the form and
set where the plugin is composed, which is the same line `omdsh-shortcuts`
draws between its `items` and its `bindings`.

With no settings provider composed at all — a headless surface, a test bench —
the hub runs on that composition entry and nothing else: **Catalog sources**
says so instead of drawing a form, every installed plugin reads as declaring
nothing to configure, and the catalog, the installs, and the removals work
exactly as they otherwise would. The registration rides
`ctx.inject(['settings'], …)`, so being configurable is additive here rather
than a precondition.

## Install

```sh
dsh plugin --profile web add @omdsh-plugins/omdsh-plughub
dsh web
```

Then **Settings → Plugins → OMDSH Plugins**, where the rest of the collection is
already listed — the upstream account is the default, so this is the only plugin
that has to be installed from a terminal. A release can equally be named the way
the hub names one on a card, straight from the account:

```sh
dsh plugin --profile web add github:omdsh-plugins/omdsh-plughub
```

Or from a checkout, when you are working on the hub itself:

```sh
pnpm install && pnpm run build
dsh plugin --profile web add /path/to/omdsh-plughub
```

To offer your local checkouts alongside the upstream, set `localSources` to the
directory holding them; a checkout wins over anything published under the same
package name.

Remove it the same way:

```sh
dsh plugin --profile web remove @omdsh-plugins/omdsh-plughub
```

which takes the tab, the routes, and the settings gateway with it. The Plugins
section goes back to **Plugin configuration** and **Plugin list**, and every
plugin installed THROUGH the hub stays installed — those are the profile's own
bundle rows, written by the launcher, not held by this package.

Nothing else has to be composed beside it. The host half injects `webServer` and
nothing more, and the settings registration rides `ctx.inject(['settings'], …)`,
so a profile with no settings provider at all still gets the tab, the catalog,
the installs and the removals — every installed plugin simply reads as declaring
nothing to configure.

## Commands

```sh
pnpm install
pnpm run build       # tsc → lib/types, then tsdown → lib/{index,contract,client}.js
pnpm test
pnpm run typecheck
pnpm run harness:local ../../deepseek-harness   # build against a checkout
pnpm run harness:npm                            # back to the committed pin
pnpm run check:harness-pin                      # fails while anything is linked
```

## Where it came from

The harness declares `settings.plugins.tab` precisely so that "inventory and
configuration plugins collaborate without depending on one another"
(`packages/client/ui-settings/src/client/contract/slots.ts`). This package is a
third occupant of that seat, beside the two tabs the harness ships there:
**Plugin configuration** (the `configurable` entry, which owns the shipped Bash,
Agent loop and Web search cards) and **Plugin list** (the `all` entry, the
inventory of every composed bundle). It adds no slot to the harness, patches
nothing, and removing it leaves the Plugins section with those two.

## Known limitations

- **Every install, update and removal needs a restart.** Plugin layers are
  composed at boot and only the user patch layers are watched, so a newly
  installed bundle cannot be hot-mounted. The banner says so; there is nothing
  behind it that a future version quietly fixes.
- **A local source is scanned exactly one directory deep.** A configured root
  holds plugin checkouts, and anything that does not declare `dsh.bundle.patch`
  in its own `package.json` is passed over — so a monorepo whose installable
  half sits in `packages/` is not offered. Point `localSources` at the inner
  directory when you want one listed.
- **Anonymous GitHub enumeration is rate-limited.** 60 requests an hour without
  a token, and `maxRepos` stops at 100 repositories in any case. The failure is
  reported on the source row rather than hidden; `githubToken` lifts it.
- **`profileDir` cannot be set from the panel.** Which profile this runtime
  manages is settled when the plugin mounts, before the settings layer resolves,
  so the field is `.hidden()` and belongs on the composition entry.
- **The write routes are loopback only.** A `dsh web` published to the LAN can
  browse the catalog and read the panel, but installs, updates, removals and
  settings writes are refused — publishing `/api` is not consent to run a
  package's `prepare` script on this machine.
- **A namespace is reachable only when an installed bundle declares it.** The
  gateway resolves ownership from `dsh.plughub.settings`, so a namespace
  registered by something the profile does not carry as a bundle — the harness's
  own `shell` or `agent-loop` — is invisible here by construction.
- **The generic form refuses schemas it cannot draw.** Anything outside strings,
  numbers, booleans, closed unions, string lists, string dictionaries and nested
  objects renders as read-only JSON with a pointer at the settings document. A
  plugin that needs more registers a card in `omdsh.plugin.card`.

[schemastery]: https://github.com/shigma/schemastery
