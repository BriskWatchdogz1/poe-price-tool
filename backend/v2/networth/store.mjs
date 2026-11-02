// Per-tab net-worth store (schema v2). Incremental: every stash tab is
// persisted on its own the moment it is valued, so a scan that stalls/aborts
// in its tail never loses the tabs already fetched. Atomic save (tmp+rename
// with a unique tmp name per writer, ENOENT-tolerant load) 1:1 from
// the same atomic tmp+rename pattern. The POESESSID cookie NEVER touches this store.
//
// Shape (/config/networth-store.json):
//   { schema_version: 2,
//     users: { "<user>": {
//       accountName, league, cdRatio,
//       tabs: { "<tabIndex>": { index, name, syncedAt,
//         items:    [ {name,kind,tab,tabIndex,qty,chaosEach,chaosTotal} ],
//         unpriced: [ {name,kind,count} ],            // count = PIECES
//         counts:   {priced,unpriced,unpricedPieces,skipped} } },
//                   // priced/unpriced/skipped = GGG ENTRIES, unpricedPieces =
//                   // the same unpriced items in PIECES. A tab written before
//                   // unpricedPieces existed simply lacks the key; aggregate.mjs
//                   // falls back to the row sum until the tab is next synced.
//       history: [ {at, totalChaos, totalDivine, league} ]  // small, last N
//     } } }
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'

const SCHEMA_VERSION = 2

function emptyStore () {
  return { schema_version: SCHEMA_VERSION, users: {} }
}

let tmpCounter = 0

export function createNetworthStore (filePath, { keep = 50, log = console } = {}) {
  // user -> the set of stored tab keys the LAST live tab list did not contain.
  // A drop is only carried out once a second consecutive list agrees with the
  // first about the same tab (see pruneTabs). In memory on purpose: a restart
  // forgetting a half-made proposal costs one more list before a genuinely
  // deleted tab goes, which is the harmless direction.
  const proposedDrops = new Map()

  const store = {
    data: emptyStore(),
    // Server flips this to false when the /config volume isn't writable (local
    // run) -> setTab/save become no-ops instead of throwing on every tab.
    writable: true,

    async load () {
      let raw
      try {
        raw = await readFile(filePath, 'utf8')
      } catch (err) {
        if (err.code === 'ENOENT') { store.data = emptyStore(); return }
        throw err
      }
      // Robustness: this store is a rebuildable cache, never a backup. A corrupt
      // file OR an old schema_version:1 (snapshot-based) store is structurally
      // incompatible -> start empty and rebuild per tab. NEVER crash the server.
      let parsed
      try { parsed = JSON.parse(raw) } catch { store.data = emptyStore(); return }
      if (!parsed || parsed.schema_version !== SCHEMA_VERSION ||
          typeof parsed.users !== 'object' || parsed.users === null) {
        store.data = emptyStore(); return
      }
      store.data = parsed
    },

    async save () {
      const tmpPath = `${filePath}.${process.pid}.${++tmpCounter}.tmp`
      try {
        await writeFile(tmpPath, JSON.stringify(store.data, null, 2), 'utf8')
        await rename(tmpPath, filePath)
      } catch (err) {
        await unlink(tmpPath).catch(() => {})
        throw err
      }
    },

    ensureUser (user) {
      const u = store.data.users
      if (!u[user]) u[user] = { accountName: null, league: null, cdRatio: null, tabs: {}, history: [] }
      if (!u[user].tabs || typeof u[user].tabs !== 'object') u[user].tabs = {}
      if (!Array.isArray(u[user].history)) u[user].history = []
      return u[user]
    },

    getMeta (user) {
      const u = store.data.users[user]
      if (!u) return null
      return { accountName: u.accountName ?? null, league: u.league ?? null, cdRatio: u.cdRatio ?? null }
    },

    setMeta (user, { accountName, league, cdRatio } = {}) {
      const u = store.ensureUser(user)
      if (accountName !== undefined) u.accountName = accountName
      if (league !== undefined) u.league = league
      if (cdRatio !== undefined) u.cdRatio = cdRatio
    },

    getTab (user, index) {
      return store.data.users[user]?.tabs?.[String(index)] ?? null
    },

    // Persists IMMEDIATELY (the whole point: crash-safety per tab). Stamps
    // syncedAt so isFresh() can later skip this tab within the TTL.
    async setTab (user, index, data) {
      const u = store.ensureUser(user)
      u.tabs[String(index)] = { ...data, index, syncedAt: Date.now() }
      if (store.writable) await store.save()
    },

    isFresh (user, index, ttlMs, now = Date.now()) {
      const tab = store.data.users[user]?.tabs?.[String(index)]
      if (!tab || typeof tab.syncedAt !== 'number') return false
      return (now - tab.syncedAt) < ttlMs
    },

    // All stored tabs for a user, in in-game order (by index).
    tabList (user) {
      const tabs = store.data.users[user]?.tabs
      if (!tabs) return []
      return Object.values(tabs).sort((a, b) => a.index - b.index)
    },

    // Drop tabs that no longer exist in the account (currentIndexes = the live
    // tab list's indexes). Keeps the store from accumulating deleted tabs.
    //
    // A DROP NEEDS TWO CONSECUTIVE TAB LISTS THAT AGREE ABOUT IT. This used to
    // believe one list absolutely: a single short answer took the matching part
    // of the store with it, and `pruneTabs(user, [])` wiped a user's entire
    // stored stash on one bad response — which is what made the partial-store
    // window of B2 reachable outside a fresh install. Since 2026-08-11 a tab is
    // deleted only when it is missing from the current list AND was missing
    // from the previous one; the intersection, so two lists that disagree about
    // WHICH tab vanished confirm neither. A list that drops nothing clears the
    // proposal, which is what makes "consecutive" mean consecutive.
    //
    // WHY EVERY SHORTENING AND NOT ONLY A BIG ONE. "Significantly shorter" would
    // need a threshold, and nobody has measured how often GGG answers short —
    // the whole reason the warning line below was added first. A threshold
    // invented on top of that would be a guessed number guarding against a
    // guessed frequency. Requiring agreement needs no number at all, and it
    // costs no request: the second opinion is the list the refresher fetches on
    // its own schedule anyway (`POE_NETWORTH_LIST_TTL_MS`, 15 min by default).
    //
    // WHAT IT COSTS. A tab genuinely deleted in game keeps contributing its
    // stored value to the snapshot for one more list interval. That is the
    // direction that shows a tab too long rather than the one that throws away
    // an account's worth of stash on a single hiccup.
    //
    // Frequency of the lines: zero in normal operation — the list is re-fetched
    // roughly every 15 minutes per user and normally matches the store exactly.
    // A genuine deletion produces one hold line and then one prune line; a
    // one-off short answer produces one hold line and nothing else.
    pruneTabs (user, currentIndexes) {
      const u = store.data.users[user]
      if (!u?.tabs) return
      const keepSet = new Set((currentIndexes || []).map(String))
      const storedKeys = Object.keys(u.tabs)
      const missing = storedKeys.filter(key => !keepSet.has(key))
      if (!missing.length) { proposedDrops.delete(user); return }

      const proposed = proposedDrops.get(user)
      const confirmed = proposed ? missing.filter(key => proposed.has(key)) : []
      proposedDrops.set(user, new Set(missing))

      // Routing name (player1) and counts only — no account name, no tab
      // contents.
      const emptyNote = keepSet.size === 0
        ? ' — the live tab list is EMPTY, which would take everything this user has stored'
        : ''
      if (!confirmed.length) {
        log.warn?.(`[networth-store] a live tab list of ${keepSet.size} would drop ${missing.length} of ` +
          `${storedKeys.length} stored tabs for ${user} — held back until a second list agrees${emptyNote}`)
        return
      }
      const held = missing.length - confirmed.length
      log.warn?.(`[networth-store] pruning ${confirmed.length} of ${storedKeys.length} stored tabs for ${user} ` +
        `(live tab list: ${keepSet.size}) — two consecutive lists agree they are gone` +
        (held ? `, ${held} further one(s) held back for a second opinion` : '') + emptyNote)
      for (const key of confirmed) delete u.tabs[key]
    },

    appendHistory (user, { totalChaos, totalDivine } = {}) {
      const u = store.ensureUser(user)
      // league carried along (unused-field-safe superset) so the frontend's
      // history list can label the point; kept tiny either way.
      u.history.push({ at: new Date().toISOString(), totalChaos, totalDivine, league: u.league ?? null })
      if (u.history.length > keep) u.history = u.history.slice(-keep)
    },

    history (user, n = keep) {
      return (store.data.users[user]?.history || []).slice(-n)
    }
  }
  return store
}
