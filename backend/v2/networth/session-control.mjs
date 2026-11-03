// What starts and ends a farm or game session, and who hears of it.
//
// sessions.mjs keeps the sessions and computes their balance; this module is
// the part that acts on them, so that every way in does the same three things:
//   - ask the refresher to read every tab of the user once from the moment of
//     a start or an end (refresher.prioritize, "A SESSION ROUND"), which is
//     what the baseline and the final balance wait for;
//   - tell the hotkey daemon (the feed's `session` event: started, baseline
//     set, ended, final, unfinished) and the user's pages (onChange, the
//     `networth-session` message);
//   - never send a request of its own. Everything here is memory and the
//     sessions file; the reads it asks for come out of the user's own ticks.
//
// THE WAYS IN. The History page's buttons and the daemon's session key
// (POST /daemon/session, `toggle`) start and end farm sessions. A game session
// follows the game: the daemon's presence (daemon-presence.mjs) turning
// `playing` starts one when none runs; `idle` ends it, but only once no
// `playing` came for gapMs, so a game restarted or crashed within the gap is
// still the same evening, and the end is dated to the moment the game stopped.
// `unknown` (no daemon, a daemon that cannot tell, a network that is down)
// starts, ends and resets nothing by itself: a gap that began with `idle`
// still runs out through it (the game was closed, then the PC shut down), and
// a game session that saw no `idle` runs on until nobody could tell the game
// state for finalizeMaxMs, and is then closed as unfinished, dated to the last
// word. What `unknown` cannot do is join two evenings: a `playing` that comes
// after gapMs or longer without a word (the PC was shut down with the game
// running, and the next evening begins) ends the running game session dated
// to the last word, as a gap would have, and starts a new one; so does a
// `playing` after an `idle` gap that ran out before the sweep saw it.
// `playing` and `idle` come only from daemons that
// report the game (`[presence] report_game`), so the automatic game session
// exists only for a user with such a daemon; autoGame false
// (POE_SESSION_AUTO_GAME=0) starts none, and one that runs still ends as above.
// A farm session does not end with its game session.
//
// Memory only (the gap's start and the last word per user); a server start
// counts as a word, so a game session from before a restart is not closed
// before any daemon could report.
import { SESSION_FINALIZE_MAX_MS_DEFAULT } from './sessions.mjs'

export const GAME_GAP_MS_DEFAULT = 10 * 60 * 1000

const isNum = v => typeof v === 'number' && Number.isFinite(v)

// The feed's copy of a session: everything the History page gets, without the
// item lists (a card has no room for them).
function feedSession (s) {
  if (!s) return null
  let balance = null
  if (s.balance) {
    const { gains, losses, ...rest } = s.balance
    balance = rest
  }
  return {
    id: s.id,
    kind: s.kind,
    parent: s.parent ?? null,
    state: s.state,
    baseline: s.baseline ?? null,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    about: s.about ?? null,
    balance
  }
}

export function createSessionControl ({
  sessions,
  latestOf = () => null,
  withheldOf = () => [],
  refresher = () => null,
  pushFeed = () => {},
  onChange = () => {},
  presenceOf = () => 'unknown',
  autoGame = true,
  gapMs = GAME_GAP_MS_DEFAULT,
  finalizeMaxMs = SESSION_FINALIZE_MAX_MS_DEFAULT,
  now = Date.now,
  log = console
} = {}) {
  const bootAt = now()
  const idleSince = new Map() // user -> when the game was last seen to stop
  const lastWord = new Map()  // user -> last time the presence was not unknown

  const roundSinceFor = user => since => refresher()?.roundSince(user, since) ?? null
  // Whole minutes until every tab was read once since a moment, at least 1
  // while it is not done; null when the refresher cannot say.
  const aboutFor = user => since => {
    const e = refresher()?.etaFor?.(user, since)
    return e && isNum(e.ms) ? Math.max(1, Math.ceil(e.ms / 60_000)) : null
  }
  const optsFor = user => ({ roundSince: roundSinceFor(user), aboutOf: aboutFor(user), withheld: withheldOf(user) })
  const viewOf = (user, id) => sessions.get(user, id, latestOf(user), optsFor(user))

  function tell (user, id, by = null) {
    try {
      pushFeed(user, feedSession(viewOf(user, id)), { by })
    } catch (e) {
      log.warn?.(`[networth-sessions] feed failed: ${e?.message || e}`)
    }
  }

  function askRound (user, since) {
    try { refresher()?.prioritize?.(user, since) } catch (e) { log.warn?.(`[networth-sessions] round request failed: ${e?.message || e}`) }
  }

  async function start (user, kind, { by = null } = {}) {
    if (!refresher()) return { ok: false, error: 'sync-off' }
    const r = await sessions.start(user, latestOf(user), { kind })
    if (!r.ok) return r
    askRound(user, r.session.startedAt)
    tell(user, r.session.id, by)
    onChange(user)
    return { ok: true, session: viewOf(user, r.session.id) }
  }

  async function end (user, kind, { at, by = null } = {}) {
    const r = await sessions.end(user, { kind, at })
    if (!r.ok) return r
    askRound(user, r.session.endedAt)
    tell(user, r.session.id, by)
    onChange(user)
    return { ok: true, session: viewOf(user, r.session.id) }
  }

  async function discard (user, kind) {
    const r = await sessions.discard(user, { kind })
    if (r.ok) onChange(user)
    return r
  }

  // The daemon's key: end the running farm session, else start one.
  async function toggle (user, { by = null } = {}) {
    const action = sessions.runningOf(user, 'farm') ? 'end' : 'start'
    const r = action === 'end' ? await end(user, 'farm', { by }) : await start(user, 'farm', { by })
    return { ...r, action }
  }

  // After every recorded history point while a session is open.
  async function onPoint (user) {
    if (!sessions.isOpen(user)) return
    try {
      const r = await sessions.observe(user, latestOf(user), { roundSince: roundSinceFor(user), withheld: withheldOf(user) })
      for (const c of r.changes) tell(user, c.id)
    } finally { onChange(user) }
  }

  // When the running game session of a user ended, if `playing` now comes
  // after its evening was over: an `idle` gap that ran out, or gapMs or longer
  // without any word (head of this file). null while it is the same evening.
  function eveningOverAt (user, game, t) {
    const stopped = idleSince.get(user)
    if (stopped != null) return t - stopped >= gapMs ? stopped : null
    const word = Math.max(lastWord.get(user) ?? bootAt, game.startedAt)
    return t - word >= gapMs ? word : null
  }

  // A presence edge (daemon-presence.mjs onChange). The work is fired off; the
  // promise is returned for tests, and never rejects: a failure is one log
  // line and changes nothing else.
  function onPresence (user, before, after) {
    const t = now()
    if (after === 'playing') {
      const game = sessions.runningOf(user, 'game')
      const overAt = game ? eveningOverAt(user, game, t) : null
      lastWord.set(user, t)
      idleSince.delete(user)
      return (async () => {
        if (overAt != null) await end(user, 'game', { at: overAt })
        if (autoGame && !sessions.runningOf(user, 'game')) await start(user, 'game')
      })().catch(e => log.warn?.(`[networth-sessions] game session change failed for ${user}: ${e?.message || e}`))
    }
    if (after === 'idle') {
      lastWord.set(user, t)
      if (!idleSince.has(user)) idleSince.set(user, t)
    }
    return Promise.resolve()
  }

  // sessions.expire() for one user, and everyone who has to hear of what it
  // changed (the feed, the page). The sweep and GET /networth-sessions go
  // through here, so a change is never consumed without being told.
  async function expire (user) {
    if (!sessions.isOpen(user)) return { finalized: [], changes: [] }
    const r = await sessions.expire(user, latestOf(user), { withheld: withheldOf(user) })
    for (const c of r.changes) tell(user, c.id)
    if (r.changes.length) onChange(user)
    return r
  }

  // Every half minute (server.mjs, with the daemons' sweep): the gap, the
  // window of a game session nobody reports on, and the windows of
  // sessions.expire(). Never starts a session: after a discard the player
  // keeps playing, and that is no new evening.
  async function sweep (userList) {
    for (const user of userList) {
      try {
        const t = now()
        const p = presenceOf(user)
        if (p === 'playing' || p === 'idle') lastWord.set(user, t)
        if (p === 'playing') idleSince.delete(user)
        else if (p === 'idle' && !idleSince.has(user)) idleSince.set(user, t)
        const game = sessions.runningOf(user, 'game')
        if (game) {
          const stopped = idleSince.get(user)
          if (stopped != null && t - stopped >= gapMs) {
            idleSince.delete(user)
            await end(user, 'game', { at: stopped })
          } else if (stopped == null && p === 'unknown') {
            const word = Math.max(lastWord.get(user) ?? bootAt, bootAt, game.startedAt)
            if (t - word >= finalizeMaxMs) {
              const r = await sessions.closeRunning(user, { kind: 'game', endedAt: word, latest: latestOf(user), withheld: withheldOf(user) })
              if (r.ok) { tell(user, r.session.id); onChange(user) }
            }
          }
        }
        await expire(user)
      } catch (e) {
        log.warn?.(`[networth-sessions] sweep failed for ${user}: ${e?.message || e}`)
      }
    }
  }

  return { start, end, discard, toggle, onPoint, onPresence, sweep, expire, viewOptions: optsFor, feedSession }
}
