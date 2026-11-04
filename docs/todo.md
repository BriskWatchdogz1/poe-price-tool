# Open work

Planned changes that are not started yet. Defects live in [bugs.md](bugs.md), accepted limitations under [Known issues](../README.md#known-issues).

## pathofexile-dat 16

The language generator (`backend/v2/lang-data-gen.mjs`) is the only user of `pathofexile-dat`, and the package stays on 15.2.0 (`^15.2.0` in `package.json`, locked in `package-lock.json`). Version 16.0.1 needs Node >= 22, which the project meets now (`engines` in `package.json`, Docker images on Node 24). Raise the dependency and run `npm run gen-lang-data -- --lang de --dry-run` as a trial, at the latest when 3.30 breaks the dat export; the `[data-refresh] lang-data` line in the container log and the staleness note under the status line in the browser show that.

## Dependabot alerts from the renderer lockfile

GitHub reports 79 Dependabot alerts on the public repository's default branch (32 high,
40 moderate, 7 low, counted on 2026-11-03). They come from `renderer/package-lock.json`,
the lockfile of the vendored Awakened PoE Trade renderer: `npm --prefix renderer ci`
installs its 421 packages in the Docker build and in CI, where they build the engine
bundle and the search indices (`renderer/src/assets/make-index-files.mjs`); the runtime
image holds no `renderer/node_modules`. `npm --prefix renderer audit` on 2026-11-03: 44
findings (13 high, 31 moderate), 38 of them in production dependencies (10 high:
`@vue/server-renderer`, `brace-expansion`, `glob`, `js-yaml`, `nanoid`, `picomatch`,
`postcss`, `source-map-js`, `vue`, `vue-i18n`). The main package has no finding in its
production dependencies and 1 moderate one in a dev dependency (`esbuild`). Change:
refresh the renderer lockfile within the ranges `renderer/package.json` allows (`npm
--prefix renderer update`, then `npm --prefix renderer audit`) without touching the
renderer's code, rebuild the engine bundle and run `npm test`; for what stays, check
whether the engine bundle (built from `renderer/src` with the shims under
`backend/v2/shims/`) carries the package at runtime at all, and say so in
`docs/admin.md`. A fix that needs a change under `renderer/` belongs upstream
(CONTRIBUTING.md, "Pull requests").

## Towards 1.0

What a 1.0 means here: a second household installs the tool from the README alone,
takes it through a league switch and an update without reading code, every number it
shows is right, marked as uncertain with a reason, or says "unpriced", nothing breaks
without the UI or the log saying so, and the public repository has what a stranger
needs to report and fix a problem. The work below is ordered; each item ships on its
own.

### Folder tabs in the session round

A session round (`roundSince` in `backend/v2/networth/refresher.mjs`) counts a tab as
read once anything was done about it at or after the moment of the start or the end.
A folder tab is read one sub-tab per tick, so a folder whose walk began before the
moment counts from its first step after it, although the sub-tabs read before the
moment are in the stored reading. Loot put into those sub-tabs in that window can be
missing from a final balance; the window is as long as the walk of the folder.
`docs/pricing-logic.md` names the limit. Change: a folder tab counts only when its walk
began at or after the moment, and the estimate of the round keeps its `1+N` steps.
