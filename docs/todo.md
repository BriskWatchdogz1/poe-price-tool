# Open work

Planned changes that are not started yet. Defects live in [bugs.md](bugs.md), accepted limitations under [Known issues](../README.md#known-issues).

## pathofexile-dat 16

The language generator (`backend/v2/lang-data-gen.mjs`) is the only user of `pathofexile-dat`, and the package stays on 15.2.0 (`^15.2.0` in `package.json`, locked in `package-lock.json`). Version 16.0.1 needs Node >= 22, which the project meets now (`engines` in `package.json`, Docker images on Node 24). Raise the dependency and run `npm run gen-lang-data -- --lang de --dry-run` as a trial, at the latest when 3.30 breaks the dat export; the `[data-refresh] lang-data` line in the container log and the staleness note under the status line in the browser show that.

## Towards 1.0

What a 1.0 means here: a second household installs the tool from the README alone,
takes it through a league switch and an update without reading code, every number it
shows is right, marked as uncertain with a reason, or says "unpriced", nothing breaks
without the UI or the log saying so, and the public repository has what a stranger
needs to report and fix a problem. The work below is ordered; each item ships on its
own.

### Features agreed on

- **Value grid over the open stash tab** (late): frames over the
  cells from the x/y/w/h the stash API already delivers.

### Folder tabs in the session round

A session round (`roundSince` in `backend/v2/networth/refresher.mjs`) counts a tab as
read once anything was done about it at or after the moment of the start or the end.
A folder tab is read one sub-tab per tick, so a folder whose walk began before the
moment counts from its first step after it, although the sub-tabs read before the
moment are in the stored reading. Loot put into those sub-tabs in that window can be
missing from a final balance; the window is as long as the walk of the folder.
`docs/pricing-logic.md` names the limit. Change: a folder tab counts only when its walk
began at or after the moment, and the estimate of the round keeps its `1+N` steps.
