// Continuous background net-worth refresher.
// Instead of the manual "scan all ~115 tabs in one burst" (which slams GGG's
// character-window endpoint into a 429), this ticks quietly: ONE request per
// interval (default ~30s), syncing the single stalest stash tab per user into
// the per-tab store. That stays far under the rate limit, keeps the snapshot
// fresh, and never bursts.
//
// Strictly sequential, one request per tick, overlap-guarded (busy flag, like
// one outstanding job at a time), .unref()'d interval. The POESESSID cookie
// NEVER touches a log, a broadcast, or the store (that discipline lives in the
// injected makeClient/stash-client + valueTab).
//
// Every I/O is injected so the whole thing is unit-testable with mocks — NO
// live GGG requests in tests:
//   store        — per-tab networth store (getTab/setTab/setMeta/pruneTabs/tabList)
//   loadUsers    — async () => ({ <user>: { accountName, poesessid } })  (creds,
//                  reloaded every round -> cookie rotation without a restart)
//   makeClient   — (user, cred) => ({ client, league })  where client has
//                  listTabs()/fetchTab(index); server binds the league.
//   valueTab     — async ({ items, tab, cdRatio, league, accountName }) => tabData
//                  (server binds valuator+normalize; see scan.mjs valueTab)
//   cdRatioFor   — (user, league) => chaosPerDivine (number)
//   onTabSynced  — (user) => void  (server broadcasts the refreshed snapshot)
//   isPaused     — () => bool  (optional yield hook; defaults to () => false.
//                  There is no manual full scan any more — the server wires
//                  nothing today, so the refresher runs continuously. The seam
//                  stays for a future pause source without touching callers.)
//   onStatus     — (user) => void  (optional; fired whenever this user's sync
//                  status changes: auth-pause set/lifted, cooldown entered.
//                  The server uses it to broadcast the new status to the UI.)

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_LIST_TTL_MS = 15 * 60 * 1000
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000

export function createNetworthRefresher ({
  store,
  loadUsers,
  makeClient,
  valueTab,
  cdRatioFor,
  onTabSynced = () => {},
  onStatus = () => {},
  isPaused = () => false,
  intervalMs = DEFAULT_INTERVAL_MS,
  listTtlMs = DEFAULT_LIST_TTL_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = () => Date.now(),
  log = console
} = {}) {
  // Per-user in-memory state (survives across ticks, NOT across a restart):
  //   tabs           — last live tab list [{index,name,type,id}] from listTabs
  //   listFetchedAt  — when that list was fetched (drives the listTtl refetch)
  //   cooldownUntil  — set on a 429; the user is skipped until now() passes it
  //   pausedPoesessid— set on an auth failure; the user is skipped until the
  //                    reloaded creds carry a DIFFERENT poesessid (cookie renewed)
  const state = new Map()
  let cursor = 0            // round-robin pointer across the user list
  let busy = false          // overlap guard (only one tick's work in flight)
  let intervalHandle = null

  function getState (user) {
    let st = state.get(user)
    if (!st) { st = { tabs: null, listFetchedAt: 0, cooldownUntil: 0, pausedPoesessid: null, attempts: new Map() }; state.set(user, st) }
    return st
  }

  // Stalest tab from the cached live list, on ONE unified timeline:
  //   - a synced tab            -> its stored syncedAt
  //   - a never-synced tab that we just ATTEMPTED (and skipped on a rejected/
  //     timeout/5xx) -> the in-memory attempt timestamp
  //   - a never-synced, never-attempted tab -> -Infinity (picked first)
  // The smallest wins. Recording the attempt is what keeps a persistently
  // failing "poison" tab from blocking the whole round-robin (mirrors the
  // cursor advances even on throw): after it's tried, every other tab
  // is now older, so the loop moves on and only comes back once it laps.
  function pickStalest (user, st) {
    let best = null
    let bestAt = Infinity
    for (const t of st.tabs) {
      const stored = store.getTab(user, t.index)
      const at = (stored && typeof stored.syncedAt === 'number')
        ? stored.syncedAt
        : (st.attempts.has(t.index) ? st.attempts.get(t.index) : -Infinity)
      if (at < bestAt) { bestAt = at; best = t }
    }
    return best
  }

  function handleError (user, cred, league, e) {
    const st = getState(user)
    const kind = e?.kind
    if (kind === 'auth') {
      // Cookie invalid/expired -> pause this user until the cookie is renewed
      // in networth-users.json (detected on the next reload via a changed
      // poesessid). Cookie value is NEVER logged.
      st.pausedPoesessid = cred.poesessid
      log.warn?.(`[networth-refresher] cookie expired for ${user}, renew networth-users.json`)
      onStatus(user)
      return
    }
    if (kind === 'ratelimit') {
      // 429 -> back off this user for a whole cooldown window, then resume
      // gently. NEVER hammer.
      st.cooldownUntil = now() + cooldownMs
      log.warn?.(`[networth-refresher] rate-limited on ${user}, cooling down ${Math.round(cooldownMs / 1000)}s`)
      onStatus(user)
      return
    }
    // rejected / server / timeout / unknown -> skip THIS tab, keep its old
    // stored state; the next tick picks the next-stalest tab. No loop abort.
    log.warn?.(`[networth-refresher] tab sync failed for ${user} (skipped): ${e?.message || e}`)
  }

  // ONE step for one user: either refresh the tab list (1 request) when it's
  // stale/unknown, or sync the single stalest tab (1 request). Never both.
  async function step (user, cred) {
    const ctx = makeClient(user, cred)
    const client = ctx?.client ?? ctx
    const league = ctx?.league
    const accountName = cred.accountName
    const st = getState(user)

    const listAge = now() - (st.listFetchedAt || 0)
    const needList = !st.tabs || st.tabs.length === 0 || listAge >= listTtlMs

    try {
      if (needList) {
        const tabs = await client.listTabs()
        // type + id have to come along: folder tabs (Unique/Maps) are readable
        // only by their id on the newer endpoint, and the type is what decides
        // which route to take in the first place. This used to be boiled down
        // to {index,name} — which is why those two tabs kept arriving empty.
        st.tabs = (tabs || []).map(t => ({ index: t.index, name: t.name, type: t.type ?? null, id: t.id ?? null }))
        st.listFetchedAt = now()
        store.pruneTabs(user, st.tabs.map(t => t.index))
        store.setMeta(user, { accountName, league, cdRatio: cdRatioFor(user, league) })
        return // one request spent — the tab syncs happen on following ticks
      }

      const target = pickStalest(user, st)
      if (!target) return
      // Record the attempt BEFORE the request: on success setTab stamps a
      // (newer) syncedAt that supersedes it; on a skip it's what pushes this
      // tab to the back so the round-robin keeps advancing.
      st.attempts.set(target.index, now())
      // Pass the tab entry along: folder tabs (Unique/Maps) need their id,
      // their items only arrive via the newer endpoint's sub-folders.
      const items = await client.fetchTab(target.index, target)
      const cdRatio = cdRatioFor(user, league)
      const tabData = await valueTab({ items, tab: target, cdRatio, league, accountName })
      await store.setTab(user, target.index, tabData) // persists immediately, stamps syncedAt
      onTabSynced(user)
    } catch (e) {
      handleError(user, cred, league, e)
    }
  }

  // One tick: overlap-guarded, picks the next eligible user round-robin and
  // does exactly one step (=one request) for them.
  async function tickOnce () {
    if (busy) return
    if (isPaused()) return // a manual full scan owns the GGG budget right now
    busy = true
    try {
      const users = await loadUsers()
      const names = Object.keys(users || {}).sort()
      if (!names.length) return

      // Reactivate any auth-paused user whose cookie was renewed in the config.
      for (const u of names) {
        const st = getState(u)
        if (st.pausedPoesessid && users[u]?.poesessid !== st.pausedPoesessid) {
          st.pausedPoesessid = null
          onStatus(u)
        }
      }

      for (let i = 0; i < names.length; i++) {
        const u = names[(cursor + i) % names.length]
        const st = getState(u)
        if (st.pausedPoesessid) continue          // auth-paused
        if (now() < (st.cooldownUntil || 0)) continue // rate-limit cooldown
        cursor = (cursor + i + 1) % names.length
        await step(u, users[u])
        return
      }
      // nobody eligible this tick (all paused / cooling down) -> quiet lapse
    } finally {
      busy = false
    }
  }

  function start () {
    if (intervalHandle) clearInterval(intervalHandle)
    intervalHandle = setInterval(() => {
      tickOnce().catch(e => log.error?.(`[networth-refresher] tick failed: ${e?.message || e}`))
    }, intervalMs)
    intervalHandle.unref?.()
    return intervalHandle
  }

  function stop () {
    if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null }
  }

  // Clean status export for the UI ("missing" is decided by the caller, who
  // knows whether credentials exist at all — the refresher only knows its own
  // pause/cooldown state). `currentPoesessid` is the value the credential file
  // holds RIGHT NOW: an auth pause counts only while the file still carries the
  // exact cookie that failed — the same comparison the reactivation loop in
  // tickOnce uses. So the instant a new cookie is saved, the status reads 'ok'
  // even before the next tick formally lifts the pause. NOTE: this NEVER
  // returns the cookie value itself, only a state derived from comparing it.
  function statusFor (user, currentPoesessid) {
    const st = state.get(user)
    if (!st) return { state: 'ok' }
    if (st.pausedPoesessid && st.pausedPoesessid === currentPoesessid) return { state: 'expired' }
    if (now() < (st.cooldownUntil || 0)) return { state: 'cooldown', until: st.cooldownUntil }
    return { state: 'ok' }
  }

  return { start, stop, tickOnce, statusFor }
}
