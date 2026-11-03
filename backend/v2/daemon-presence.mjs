// What the hotkey daemons report about themselves (POST /daemon/heartbeat):
// version, which of their parts work, and whether the game runs.
//
// THREE ANSWERS, AND THE THIRD IS THE IMPORTANT ONE:
//   playing  a fresh heartbeat says the game runs,
//   idle     fresh heartbeats exist and every one of them says it does not,
//   unknown  no fresh heartbeat: an old daemon, no daemon, a daemon that
//            cannot tell, a network that is down, a server that just started.
// Everything that acts on presence must treat `unknown` exactly as the tool
// behaved before heartbeats existed. Three readers: the `daemon-status`
// message, the net-worth refresher (networth/refresher.mjs, "WHO GETS THE
// TICK"), which asks syncPresenceOf below, and the game sessions
// (networth/session-control.mjs), which hear every edge through onChange and
// ask presenceOf: `playing` starts one, `idle` ends one after a gap, `unknown`
// changes nothing.
//
// SERVER CLOCK ONLY. A heartbeat carries no time that is trusted: the game
// machine's clock is not this one, and a suspended laptop wakes with a jump.
// A beat is fresh for max(staleMs, 3 × the interval the daemon announced), so a
// daemon that reports 'absent' only every 300 s does not flicker to unknown.
//
// Several daemons of one user are kept apart by instance and merged: playing if
// any fresh beat says 'running'; idle only if EVERY fresh beat says 'absent';
// else unknown. A daemon that cannot tell (it does not look, or its probe
// failed) keeps its user at unknown, so a second daemon on a laptop cannot make
// a player idle.
//
// Memory only. At most INSTANCES_MAX daemons per user are remembered (the
// oldest beat goes first): the instance id is the caller's word, and a route
// without a login must not grow without bound.
export const GAME_STATES = new Set(['running', 'absent', 'unknown'])

const EVERY_S_MIN = 10
const EVERY_S_MAX = 600
const FEATURES_MAX = 8
const INSTANCES_MAX = 8
const WORD = /^[a-z-]{1,24}$/

// features: at most FEATURES_MAX keys, key and value each a short word of
// lower-case letters and dashes; everything else is dropped, not passed on.
function cleanFeatures (raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= FEATURES_MAX) break
    if (WORD.test(k) && typeof v === 'string' && WORD.test(v)) out[k] = v
  }
  return out
}

export function createDaemonPresence ({ staleMs, now = () => Date.now(), onChange = () => {} } = {}) {
  const byUser = new Map()       // user -> Map(instance -> { at, freshMs, game, version, features })
  const lastBeat = new Map()     // user -> the newest beat ever, kept after it went stale (statusOf)
  const lastGame = new Map()     // user -> last time (server clock) a beat said 'running'
  const stoppedAt = new Map()    // user -> time of the last playing -> not-playing edge
  const lastPresence = new Map() // user -> presence at the last edge
  const lastCount = new Map()    // user -> fresh daemons at the last beat or sweep

  // The fresh beats of a user; stale ones are dropped here.
  function fresh (user) {
    const m = byUser.get(user)
    if (!m) return []
    const t = now()
    for (const [inst, b] of m) if (t - b.at > b.freshMs) m.delete(inst)
    return [...m.values()]
  }

  function presenceOf (user) {
    const beats = fresh(user)
    if (!beats.length) return 'unknown'
    if (beats.some(b => b.game === 'running')) return 'playing'
    if (beats.every(b => b.game === 'absent')) return 'idle'
    return 'unknown'
  }

  // The answer the net-worth refresher gets. Like presenceOf, except that a
  // user whose game just stopped still counts as playing while
  // holdAfterGame(user, stoppedAt) says so: the loot of the last minutes
  // reaches the net worth at the playing pace, not at the idle one. Only an
  // idle user with a stop edge is held; unknown stays unknown.
  function syncPresenceOf (user, holdAfterGame = () => false) {
    const p = presenceOf(user)
    const t = stoppedAt.get(user)
    return p === 'idle' && t != null && holdAfterGame(user, t) ? 'playing' : p
  }

  // true when presence changed (and onChange was called).
  function edge (user) {
    const before = lastPresence.get(user) ?? 'unknown'
    const after = presenceOf(user)
    if (before === after) return false
    lastPresence.set(user, after)
    if (before === 'playing') stoppedAt.set(user, now())
    onChange(user, before, after)
    return true
  }

  function beat (user, instance, { game, version, features, everyS } = {}) {
    const g = GAME_STATES.has(game) ? game : 'unknown'
    const every = Number(everyS)
    const freshMs = Number.isFinite(every) && every > 0
      ? Math.max(staleMs, 3 * Math.min(EVERY_S_MAX, Math.max(EVERY_S_MIN, every)) * 1000)
      : staleMs
    const t = now()
    const rec = { at: t, freshMs, game: g, version: typeof version === 'string' ? version : 'unknown', features: cleanFeatures(features) }
    let m = byUser.get(user)
    if (!m) { m = new Map(); byUser.set(user, m) }
    m.delete(instance) // re-insert: the Map's order is the order of the last beat
    m.set(instance, rec)
    while (m.size > INSTANCES_MAX) m.delete(m.keys().next().value)
    lastBeat.set(user, rec)
    if (g === 'running') lastGame.set(user, t)
    edge(user)
    lastCount.set(user, fresh(user).length)
    return presenceOf(user)
  }

  // Staleness is an edge too, and nothing else would notice it. Returns the
  // users whose number of fresh daemons changed WITHOUT a presence edge (a
  // daemon that could not tell the game state went quiet): onChange did not
  // hear of them, and the page still shows them as reporting.
  function sweep (userList) {
    const changed = []
    for (const u of userList) {
      const edged = edge(u)
      const n = fresh(u).length
      const before = lastCount.get(u) ?? 0
      lastCount.set(u, n)
      if (!edged && n !== before) changed.push(u)
    }
    return changed
  }

  // null when nothing was ever heard from this user's daemons since the start.
  function statusOf (user) {
    const last = lastBeat.get(user)
    if (!last) return null
    return {
      presence: presenceOf(user),
      lastBeatAt: last.at,
      version: last.version,
      game: last.game,
      lastGameAt: lastGame.get(user) ?? null,
      features: { ...last.features },
      instances: fresh(user).length
    }
  }

  // For the heartbeat route: did version, features or the instance count
  // change (presence, lastBeatAt and lastGameAt are ignored — a presence change
  // goes out through onChange already)?
  function changedForPage (before, after) {
    if (!before || !after) return !!before !== !!after
    const feat = f => JSON.stringify(Object.entries(f || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    return before.version !== after.version ||
      before.instances !== after.instances ||
      feat(before.features) !== feat(after.features)
  }

  return {
    beat, presenceOf, syncPresenceOf, statusOf, sweep, changedForPage,
    lastGameAt: u => lastGame.get(u) ?? null,
    stoppedAt: u => stoppedAt.get(u) ?? null
  }
}

// The hold for syncPresenceOf: a player whose game just stopped keeps the
// playing pace until every tab of theirs was read once since the stop
// (roundSince, networth/refresher.mjs), at most maxMs (0: not at all). An
// answer of null (no refresher, no tab list yet) is not complete.
export function makeHoldAfterGame ({ maxMs, roundSince, now = () => Date.now() }) {
  return (user, stoppedAtMs) => maxMs > 0 && now() - stoppedAtMs < maxMs && !(roundSince(user, stoppedAtMs)?.complete)
}
