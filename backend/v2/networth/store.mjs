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
//         unpriced: [ {name,kind,count} ],
//         counts:   {priced,unpriced,skipped} } },
//       history: [ {at, totalChaos, totalDivine, league} ]  // small, last N
//     } } }
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'

const SCHEMA_VERSION = 2

function emptyStore () {
  return { schema_version: SCHEMA_VERSION, users: {} }
}

let tmpCounter = 0

export function createNetworthStore (filePath, { keep = 50 } = {}) {
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
    pruneTabs (user, currentIndexes) {
      const u = store.data.users[user]
      if (!u?.tabs) return
      const keepSet = new Set((currentIndexes || []).map(String))
      for (const key of Object.keys(u.tabs)) {
        if (!keepSet.has(key)) delete u.tabs[key]
      }
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
