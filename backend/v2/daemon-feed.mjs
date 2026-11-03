// The way back from the server to the hotkey daemon on a player's game machine
// (frontend/PROTOCOL.md, `GET /daemon/events`).
//
// WHY NOT THE WEBSOCKET. A connect on /events replays the room, re-queues up to
// POE_MAX_REQUEUE_ON_RECONNECT priceless cards as trade searches and warms the
// league on poe.ninja. A daemon whose network flaps would reconnect again and
// again, and every reconnect would be trade-API load, the one load this project
// must never raise. Reading this feed has no side effect: it never queues,
// fetches or prices anything.
//
// WHY LONG-POLL. Every request ends by itself within its hold time, so a
// half-open connection (Wi-Fi drop, suspend, a proxy that forgot the stream)
// costs at most one hold and needs no keep-alive watchdog. `boot` + `since`
// make a lost answer recoverable, or the answer says plainly that something
// was missed (`gap`) or that the server restarted (`reset`).
//
// WHAT GOES IN. Only cards a daemon posted itself (track(), called by POST /item
// when the request carries X-PPT-Daemon), followed until maxAgeMs after their
// final state, buyer-whisper verdicts (pushWhisper), and every change of the
// user's farm and game sessions (pushSession, session-control.mjs). Every item event
// carries the card's WHOLE current state, so the daemon replaces and never
// merges. After its FIRST final state a card takes only its poe.ninja
// reference: a search started later in the browser, or a re-queue after a page
// reconnect, never reaches the game, until the daemon posts the item again
// (track() from the dedupe branch reopens it, see track()).
//
// Memory only, bounded per user (`keep` events and `keep` followed cards).
export const FEED_VERSION = 1

function blankState (id, stack = null) {
  return {
    id, name: null, base: null, rarity: null, stack, status: 'queued',
    ahead: null, retryAfterSec: null, price: null, ref: null, cd: null, final: false
  }
}

// Pure merge of one room message into a followed card's state; null for a
// message type the daemon has no use for. `ahead` is the card's queue position
// (only kept while it is queued), `cd` the Chaos:Divine rate of its league.
export function itemStateFrom (prev, msg, { ahead = null, cd = null } = {}) {
  const s = prev ? { ...prev } : blankState(msg.id)
  if (msg.type === 'item-added') {
    s.name = msg.name ?? s.name
    s.base = msg.baseType || s.base
    s.rarity = msg.rarity ?? s.rarity
    s.status = msg.priceStatus || 'queued'
    s.retryAfterSec = msg.retryAfterSec ?? null
    s.ahead = s.status === 'queued' ? ahead : null
  } else if (msg.type === 'price-result') {
    s.status = 'done'
    s.ahead = null
    s.retryAfterSec = null
    const r = msg.exchangeRange
    s.price = {
      source: msg.priceSource || (msg.display === 'ninja' ? 'ninja' : 'trade'),
      currency: msg.currency || 'chaos',
      median: msg.priceMedian ?? msg.priceLow ?? null,
      low: r ? r.low : (msg.priceLow ?? null),
      high: r ? r.high : (msg.priceHigh ?? null),
      count: msg.count ?? null,
      ageHours: msg.exchangeAgeHours ?? null,
      conflict: !!msg.askConflict,
      early: false
    }
  } else if (msg.type === 'ninja-ref') {
    s.ref = { chaos: msg.chaos ?? null, divine: msg.divine ?? null }
  } else {
    return null
  }
  s.cd = cd
  s.final = s.status === 'done' || s.status === 'error'
  return s
}

/**
 * createDaemonFeed({ users, keep, waitersMax, maxAgeMs, now, bootId,
 *                    positionOf(user, id), cdFor(league) })
 *
 * positionOf: jobs ahead of a card in the shared queue (the running one
 * included), or null when its job is not queued. cdFor: the Chaos:Divine rate
 * of a league, or null. Both read memory only.
 */
export function createDaemonFeed ({
  users, keep, waitersMax, maxAgeMs, now = () => Date.now(),
  bootId, positionOf = () => null, cdFor = () => null
} = {}) {
  const boot = bootId || `b${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  // user -> { seq, events: [], waiters: Map(instance -> w), tracked: Map(id -> { by, league, state, finalAt, closed, reassert }) }
  const rooms = new Map()
  for (const u of users) rooms.set(u, { seq: 0, events: [], waiters: new Map(), tracked: new Map() })

  function prune (r) {
    const t = now()
    while (r.events.length > keep || (r.events.length && t - r.events[0].at > maxAgeMs)) r.events.shift()
    for (const [id, x] of r.tracked) if (x.finalAt != null && t - x.finalAt > maxAgeMs) r.tracked.delete(id)
    while (r.tracked.size > keep) r.tracked.delete(r.tracked.keys().next().value)
  }

  function push (user, ev) {
    const r = rooms.get(user)
    if (!r) return null
    const e = { seq: ++r.seq, at: now(), ...ev }
    r.events.push(e)
    prune(r)
    for (const w of [...r.waiters.values()]) w.fire()
    return e
  }

  // The first final state closes the card (see the head of this file); a
  // reference after that is still an event, but does not restart its age. A
  // card that is not final has no age: a reopened card queued again stays
  // followed however long it waits.
  // extra: fields of this one event that are not part of the card's state
  // (reassert, below).
  function emitItem (user, x, extra = null) {
    if (x.state.final && !x.closed) { x.finalAt = now(); x.closed = true }
    if (!x.state.final) x.finalAt = null
    push(user, { kind: 'item', by: x.by, ...x.state, ...extra })
  }

  // POST /item made (or the dedupe re-asserted) this card for daemon instance
  // `by`. No event of its own: the card's broadcast right after it is one.
  //
  // reassert: the dedupe branch (server.mjs) calls track() and then sends the
  // card's current state as the browser gets it: its item-added, then its last
  // price-result when it has one, then its reference. That price-result is not
  // a new result: it brings the card's price, and the status stays the one the
  // item-added said. It is taken even when the item-added already closed the
  // card (a card that was `done` before), so the game gets the price the page
  // shows, not the one of the first final state. Only the message right after
  // the item-added counts as that replay. The event of that item-added
  // carries `reassert: true`: it answers a POST like the first event of a new
  // card does, though its id is known (the daemon binds POSTs to cards that
  // way, daemon/ppt_results.py).
  function track (user, id, { by, stack = null, league = null, reassert = false } = {}) {
    const r = rooms.get(user)
    if (!r) return
    const step = reassert ? 'added' : null
    const x = r.tracked.get(id)
    if (x) {
      // Re-asserted: open again, a fresh age, the new presser.
      x.by = by
      x.closed = false
      x.finalAt = x.state.final ? now() : null
      x.reassert = step
      if (league) x.league = league
      return
    }
    r.tracked.set(id, { by, league, finalAt: null, closed: false, reassert: step, state: blankState(id, stack) })
    prune(r)
  }

  // An exchange rate known at the POST from memory (server.mjs, the early
  // answer). The job's own result replaces it.
  function hint (user, id, price) {
    const r = rooms.get(user)
    const x = r?.tracked.get(id)
    if (!x || x.closed || x.state.final) return
    x.state = { ...x.state, price: { ...price, early: true } }
    emitItem(user, x)
  }

  // The queue position of a card that still waits. POST /item calls refresh()
  // right after enqueue() (the card's broadcast came before its job was in the
  // queue, so `ahead` was null there); broadcastQueue() calls refreshQueued().
  // An event only when `ahead` changed: a busy queue is not an event per pump.
  function refresh (user, id) {
    const r = rooms.get(user)
    const x = r?.tracked.get(id)
    if (!x || x.closed || x.state.status !== 'queued') return
    const ahead = positionOf(user, id)
    if (ahead === x.state.ahead) return
    x.state = { ...x.state, ahead }
    emitItem(user, x)
  }
  function refreshQueued () {
    for (const [user, r] of rooms) for (const id of [...r.tracked.keys()]) refresh(user, id)
  }

  // Called as the FIRST line of broadcast(user, obj) in server.mjs (through
  // guarded()), so no place that sends a card can be forgotten here.
  function noteBroadcast (user, msg) {
    const r = rooms.get(user)
    if (!r || !msg || typeof msg.id !== 'string') return
    prune(r)
    const x = r.tracked.get(msg.id)
    if (!x) return
    if (msg.type === 'item-removed') {
      r.tracked.delete(msg.id)
      push(user, { kind: 'item-removed', by: x.by, id: msg.id })
      return
    }
    const step = x.reassert // one message at a time (track(), reassert)
    x.reassert = null
    const replay = step === 'price' && msg.type === 'price-result'
    if (x.closed && msg.type !== 'ninja-ref' && !replay) return // after the first final state: the reference only
    const next = itemStateFrom(x.state, msg, { ahead: positionOf(user, msg.id), cd: cdFor(x.league) })
    if (!next) return
    next.stack = x.state.stack
    if (replay) {
      const { status, ahead, retryAfterSec, final } = x.state
      Object.assign(next, { status, ahead, retryAfterSec, final })
    }
    x.state = next
    const answersPost = step === 'added' && msg.type === 'item-added'
    emitItem(user, x, answersPost ? { reassert: true } : null)
    if (answersPost) x.reassert = 'price'
  }

  // Buyer-whisper verdicts; `by` is the instance that posted the whisper.
  function pushWhisper (user, entry, { by } = {}) {
    return push(user, { kind: 'whisper', by, wid: entry.wid, entry })
  }

  // A farm or game session changed (started, baseline set, ended, final or
  // unfinished); `session` is its whole state now (session-control.mjs
  // feedSession). `by` is the instance whose key press caused it, else null:
  // a session belongs to the user, not to one daemon.
  function pushSession (user, session, { by = null } = {}) {
    return push(user, { kind: 'session', by, session })
  }

  function read (user, { since, boot: askedBoot } = {}) {
    const r = rooms.get(user)
    const out = { v: FEED_VERSION, boot, seq: r ? r.seq : 0, now: now(), reset: false, gap: false, events: [] }
    if (!r) { out.reset = true; return out }
    prune(r)
    if (askedBoot !== boot || !Number.isInteger(since) || since < 0 || since > r.seq) { out.reset = true; return out }
    const oldest = r.events.length ? r.events[0].seq : r.seq + 1
    if (since + 1 < oldest) out.gap = true
    out.events = r.events.filter(e => e.seq > since)
    return out
  }

  // Hold a request until something arrives or holdMs passes. One waiter per
  // instance (a newer request of the same daemon answers the older one at
  // once, empty); at most waitersMax per user, else null (-> 429). Returns a
  // cancel function for a request whose connection closed first.
  function wait (user, { since, boot: askedBoot, instance, holdMs, onAnswer }) {
    const r = rooms.get(user)
    if (!r) return null
    r.waiters.get(instance)?.fire()
    if (r.waiters.size >= waitersMax) return null
    let done = false
    const w = { fire: () => finish() }
    const timer = setTimeout(() => finish(), holdMs)
    timer.unref?.()
    function finish () {
      if (done) return
      done = true
      clearTimeout(timer)
      if (r.waiters.get(instance) === w) r.waiters.delete(instance)
      onAnswer(read(user, { since, boot: askedBoot }))
    }
    r.waiters.set(instance, w)
    return () => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (r.waiters.get(instance) === w) r.waiters.delete(instance)
    }
  }

  return {
    boot, track, hint, refresh, refreshQueued, noteBroadcast, pushWhisper, pushSession, read, wait,
    waitersOf: u => rooms.get(u)?.waiters.size ?? 0,
    stats: () => Object.fromEntries([...rooms].map(([u, r]) => [u, { seq: r.seq, buffered: r.events.length, tracked: r.tracked.size, waiting: r.waiters.size }]))
  }
}

// The feed is an extra: a throw inside it must never stop a browser message or
// pump(). guarded(fn, warn) calls fn and, on a throw, writes
// '[daemon-feed] <message> — the browser still gets every message' through
// warn, once per message text, and returns normally. At most 20 texts are
// remembered; past that a new text stays quiet rather than turning a broken
// feed into a line per broadcast.
const GUARD_TEXTS_MAX = 20
export function guarded (fn, warn) {
  const said = new Set()
  return (...args) => {
    try {
      return fn(...args)
    } catch (e) {
      const text = String(e?.message || e)
      if (!said.has(text) && said.size < GUARD_TEXTS_MAX) {
        said.add(text)
        try { warn(`[daemon-feed] ${text} — the browser still gets every message`) } catch { /* the log itself failed */ }
      }
      return undefined
    }
  }
}
