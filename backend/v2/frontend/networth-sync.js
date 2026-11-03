/* Net Worth page — the pure part of the sync status line and the auto-sync
 * counter, split out of networth.js so a test can run it without a browser.
 * No DOM and no i18n table here: syncLineText takes the translator from its
 * caller, the other helpers return keys the caller translates. */

// Which sentence a `networth-sync-status` message gets, as { key, timed, until }
// (`timed`: the sentence has an {at} slot the caller fills from `until`; a pace
// line adds `min` for its {min} slot and `info: true`), or null when the line
// stays empty.
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
  // Sync follows the game (`pace`, only for a user whose daemon reports the
  // game not running): said only while the sync runs normally, because no
  // pace applies during a cooldown. `min` is the idle group's spacing, so the
  // sentence says "about"; `info` marks a line that is no fault to fix.
  const pace = st.pace
  if (pace && (pace.mode === 'yields' || pace.mode === 'rests')) {
    const everyMs = Number(pace.everyMs) || 0
    // everyMs 0 (POE_NETWORTH_IDLE_REST=1): this user's tabs are not read. In
    // `yields` others still play, so the sentence names the own game.
    if (everyMs <= 0) {
      return { key: pace.mode === 'yields' ? 'nw.syncYieldsFully' : 'nw.syncRestsFully', timed: false, until: null, min: null, info: true }
    }
    const min = Math.max(1, Math.round(everyMs / 60000))
    return { key: pace.mode === 'yields' ? 'nw.syncYields' : 'nw.syncRests', timed: false, until: null, min, info: true }
  }
  return null // ok -> the slot stays empty and collapses
}

// The session round (`sessionRound`: every tab of this user once from a
// session's start or end, refresher.prioritize) as { key, done, total, info },
// or null. Said only while the sync runs normally, like the pace: during a
// cooldown or with an expired cookie that sentence is the one to read. The
// pages put it after the line of syncStatusLine.
export function sessionRoundLine (st) {
  if (!st || st.state !== 'ok') return null
  const r = st.sessionRound
  if (!r || !Number.isFinite(r.done) || !Number.isFinite(r.total) || r.total <= 0) return null
  return { key: 'nw.syncSessionRound', done: r.done, total: r.total, info: true }
}

// The whole sync line of the Net Worth and Settings pages, as text: the
// sentence of syncStatusLine, then the session round of sessionRoundLine (a
// pace says why the round goes slowly). '' for a plain ok. `T(key, params)`
// translates, `locale` formats the clock time of a timed sentence.
export function syncLineText (st, T, locale) {
  const line = syncStatusLine(st)
  const round = sessionRoundLine(st)
  const text = !line ? ''
    : !line.timed ? T(line.key, line.min != null ? { min: line.min } : undefined)
      : T(line.key, { at: line.until ? new Date(line.until).toLocaleTimeString(locale) : T('nw.syncSoon') })
  return [text, round ? T(round.key, { done: round.done, total: round.total }) : ''].filter(Boolean).join(' ')
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
