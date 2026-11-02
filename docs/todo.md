# Open work

Planned changes that are not started yet. Defects live in [bugs.md](bugs.md), accepted limitations under [Known issues](../README.md#known-issues).

## Daemon reports its version

The release notice (Releases block on the settings page, one line on every page) compares the latest GitHub release with the version the **server** runs. The hotkey daemon's POST carries no version, so the notice cannot say whether a player's own clone is behind; in a multi-player install server and daemon are updated by different people and can differ. Once the daemon sends its version, the notice can tell each player whether their own clone is behind.

## pathofexile-dat 16

The language generator (`backend/v2/lang-data-gen.mjs`) is the only user of `pathofexile-dat`, and the package stays on 15.2.0 (`^15.2.0` in `package.json`, locked in `package-lock.json`). Version 16.0.1 needs Node >= 22, which the project meets now (`engines` in `package.json`, Docker images on Node 24). Raise the dependency and run `npm run gen-lang-data -- --lang de --dry-run` as a trial, at the latest when 3.30 breaks the dat export; the `[data-refresh] lang-data` line in the container log and the staleness note under the status line in the browser show that.
