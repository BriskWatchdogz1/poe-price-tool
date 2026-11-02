/* Net Worth page — the pure part of the sync status line and the auto-sync
 * counter, split out of networth.js so a test can run it without a browser.
 * No DOM, no i18n lookup here: callers translate the key this returns. */

// Which sentence a `networth-sync-status` message gets, as { key, timed, until }
// (`timed`: the sentence has an {at} slot the caller fills from `until`), or null when the line stays empty.
// `st` is the WHOLE message: `mine` and `tradeBan` decide the cooldown wording
// (frontend/PROTOCOL.md, `networth-sync-status`).
export function syncStatusLine (st) {
  if (!st) return null
  if (st.state === 'expired') return { key: 'nw.syncExpired', timed: false, until: null }
  if (st.state === 'cooldown') {
    // `mine: false` = another user's 429 is what stopped OUR sync (the refresher
    // is one worker for all users and backs off globally). Absent means "ours",
    // so an older server that does not send the field reads as it always did.
    // `tradeBan` is the third case and not a stash 429 at all: GGG blocked the
    // trade API, and the ban reaches the address, so this path stops with it.
    const key = st.tradeBan ? 'nw.syncTradeBan'
      : st.mine === false ? 'nw.syncCooldownOther' : 'nw.syncCooldown'
    return { key, timed: true, until: st.until || null }
  }
  if (st.state === 'missing') return { key: 'nw.syncMissing', timed: false, until: null }
  return null // ok -> the slot stays empty and collapses
}

// "Synced recently" window of the auto-sync counter. A full round takes
// tabs x interval (x users), and no message tells the client the interval or
// the user count, so a threshold scaled to the round cannot be computed here.
// The counter therefore states exactly what it measures: tabs synced within
// this many ms. Cosmetic, not tied to any server config value.
export const SYNCED_RECENTLY_MS = 10 * 60 * 1000

// { recent, total, mins, windowMins } from snapshot.tabs[] (each stamped with
// `syncedAt` by the refresher), or null while no tab carries a stamp yet.
export function autosyncSummary (tabs, now) {
  const stamped = (tabs || []).filter(t => typeof t.syncedAt === 'number')
  if (!stamped.length) return null
  const recent = stamped.filter(t => now - t.syncedAt < SYNCED_RECENTLY_MS).length
  const oldest = stamped.reduce((m, t) => Math.min(m, t.syncedAt), Infinity)
  return {
    recent,
    total: stamped.length,
    mins: Math.max(0, Math.round((now - oldest) / 60000)),
    windowMins: SYNCED_RECENTLY_MS / 60000
  }
}
