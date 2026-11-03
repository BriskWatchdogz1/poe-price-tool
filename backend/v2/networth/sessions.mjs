// Farm and game sessions — "is what I am doing right now worth it?" A player
// starts a session, plays, ends it, and gets one balance for that stretch: what
// the activity brought in, and what was only the market moving underneath it.
// No request of its own: everything is computed from points and breakdowns the
// history records anyway.
//
// TWO KINDS, ONE BALANCE. A `farm` session is started and ended by the player
// (the History page's buttons, the hotkey daemon's session key). A `game`
// session is a game evening: started when the player's daemon reports the game
// running, ended when it has reported it not running for a while
// (session-control.mjs). A farm session started during a game session of the
// same user belongs to it (`parent`). At most one running session of each kind
// per user. States:
//   starting     started; the baseline is not read yet, so there is no figure
//   running      the baseline is set; the figures run against the newest point
//   preliminary  ended; waiting for every tab to be read once after the end
//   final        struck against the first point after that round
//   unfinished   closed without that round, with the figures it had
//
// WHY THE START WAITS. The stash is read one tab per tick, so at the start most
// tabs show an older state. The baseline is the first history point recorded
// after every live tab was read (or tried) once after the start
// (refresher.roundSince(), the rule that also makes an end final). The history
// keeps the full item breakdown of its NEWEST point only, so that point's
// breakdown is copied here and kept until the session is closed. A copy of the
// newest point at the start (`press`) is kept until the session has ended: when
// no read baseline comes within finalizeMaxMs, or the session ends first, the
// session starts from that copy and `baseline: 'at-press'` says so. A read from
// after the end carries the session's own loot and is never the baseline: a
// game session's end is dated back to when the game stopped
// (session-control.mjs), so a read baseline that arrived in the gap is dropped
// at the end and the copy taken (without one the session closes without
// figures). A farm session needs a fresh copy (baselineMaxAgeMs) to start at
// all: an older newest point means the sync is not running for this user.
//
// WHY THE END WAITS. The balance is PRELIMINARY until every live tab was read
// (or tried) once after the end, then struck against the first history point
// after that and marked final. Not there within finalizeMaxMs, it closes as
// "unfinished": at the next history point, or — when none comes (sync off, an
// expired POESESSID) — at the next look (expire()). Without a point from after
// the end, or without a baseline, the balance is null rather than a figure that
// stops before the end. Closing keeps the numbers and drops the breakdown, so a
// summary is a few hundred bytes and outlives the history's 15-day retention.
// Up to `keep` per user.
//
// WHAT EACH FIELD IS FOR (a figure nobody decides anything with is not kept):
//   total        did my net worth go up over the session?
//   loot         the stock change valued at the prices at the START, so a price
//                move cannot pass as loot
//   market       the part of the total that was only prices and the C:D rate
//   lootPerHour  to compare one activity with another
//   gains/losses one lucky drop or a steady income; does a sale carry it?
//   state        may I trust the figure yet?
//   baseline     'read' (the first full read after the start) or 'at-press'
//                (the copy at the start): is the start itself to be trusted?
//   kind, parent which farm session belongs to which game evening
//   stashChanged is the figure a farming result at all? A tab that appeared,
//                vanished or was read for the first time, or a league switch,
//                counts its whole content as a change
//   withheld, unpricedIn  which loot is missing from the figure, so "not worth
//                it" is not concluded from loot the tool could not count

import { writeFile, rename, unlink } from 'node:fs/promises'
import { loadVersionedJson } from '../store-file.mjs'

export const SESSIONS_SCHEMA_VERSION = 2
export const SESSION_KINDS = Object.freeze(['farm', 'game'])
export const SESSION_BASELINE_MAX_AGE_MS_DEFAULT = 10 * 60 * 1000
export const SESSION_RATE_MIN_MS_DEFAULT = 10 * 60 * 1000
export const SESSION_TOP_N_DEFAULT = 5
export const SESSION_LIST_MAX_DEFAULT = 20
export const SESSIONS_KEEP_DEFAULT = 200
export const SESSION_FINALIZE_MAX_MS_DEFAULT = 24 * 60 * 60 * 1000

const round1 = n => Math.round(n * 10) / 10
const round2 = n => Math.round(n * 100) / 100
const rateOf = cd => (Number(cd) > 0 ? Number(cd) : 0)

/**
 * The balance between two history moments.
 * start/end: { at, c, cd, items: Map(name -> [qty, chaos]) } (history.latest()).
 *
 * loot   = Σ (quantity change × unit price at the start); an item without a
 *          start price at its end price, one with a price at neither end 0
 *          (and counted in unpricedIn when it came in — unless it is in
 *          `withheld`: an arrival the price brake holds at no value has a price
 *          and is named as withheld instead). A pure price move is never loot.
 * market = total − loot.
 * In divine: loot at the start's rate (it is in start prices), the total with
 * each end's own rate, market the difference. null where a rate is missing.
 */
export function balance (start, end, { topN = SESSION_TOP_N_DEFAULT, withheld = [] } = {}) {
  const s = start.items
  const e = end.items
  const held = new Set(withheld)
  let loot = 0
  let unpricedIn = 0
  const rows = []
  for (const name of new Set([...s.keys(), ...e.keys()])) {
    const [q0, v0] = s.get(name) || [0, 0]
    const [q1, v1] = e.get(name) || [0, 0]
    const dq = q1 - q0
    if (dq === 0) continue // a pure price move is market, never loot
    const p0 = q0 > 0 && v0 > 0 ? v0 / q0 : 0
    const p1 = q1 > 0 && v1 > 0 ? v1 / q1 : 0
    const pRef = p0 > 0 ? p0 : p1 // start price; an item without one at its end price
    if (pRef === 0) { if (dq > 0 && !held.has(name)) unpricedIn++; continue }
    const chaos = dq * pRef
    loot += chaos
    rows.push([name, round1(dq), round1(chaos)])
  }
  const total = round1(end.c - start.c)
  const lootR = round1(loot)
  const cd0 = rateOf(start.cd)
  const cd1 = rateOf(end.cd)
  const totalDiv = cd0 && cd1 ? round2(end.c / cd1 - start.c / cd0) : null
  const lootDiv = cd0 ? round2(loot / cd0) : null
  const n = Math.max(0, Math.floor(Number(topN) || 0))
  return {
    startAt: start.at,
    endAt: end.at,
    c0: start.c,
    c1: end.c,
    cd0,
    cd1,
    total,
    loot: lootR,
    market: round1(total - lootR),
    totalDiv,
    lootDiv,
    marketDiv: totalDiv != null && lootDiv != null ? round2(totalDiv - lootDiv) : null,
    gains: rows.filter(r => r[2] > 0).sort((a, b) => b[2] - a[2]).slice(0, n),
    losses: rows.filter(r => r[2] < 0).sort((a, b) => a[2] - b[2]).slice(0, n),
    unpricedIn
  }
}

/** Loot per hour — only from rateMinMs on, and never across a changed stash. */
export function hourly (bal, durationMs, { rateMinMs = SESSION_RATE_MIN_MS_DEFAULT, stashChanged = false } = {}) {
  if (!bal || stashChanged || !(durationMs > 0) || durationMs < rateMinMs) {
    return { lootPerHour: null, lootPerHourDiv: null }
  }
  const h = durationMs / 3_600_000
  return {
    lootPerHour: round1(bal.loot / h),
    lootPerHourDiv: bal.lootDiv == null ? null : round2(bal.lootDiv / h)
  }
}

// Arrivals the price brake holds at no value, narrowed to this session: in the
// end stash, and not in the start one (an item that was already there is not
// loot this session would be missing).
function withheldFor (open, latest, withheld) {
  if (!Array.isArray(withheld) || !withheld.length || !latest) return []
  return withheld.filter(name => (latest.items.get(name)?.[0] || 0) > 0 && !((open.start.items.get(name)?.[0] || 0) > 0))
}

// ---- file form --------------------------------------------------------------
//   { schema_version: 2, users: { <user>: { running: Open[], pending: Open[], done: Done[] } } }
//   Open = { id, kind, parent, startedAt, endedAt?, stashChanged, baseline,
//            start: Snap|null, press: Snap|null, pressChanged? }
//          running holds at most one Open of each kind; press is kept until
//          the end decides the baseline, pressChanged (only with press) is
//          whether a tab change was noted since the press
//   Snap = { at, c, cd, i: [[name, qty, chaos]] }
//   Done = { id, kind, parent, baseline, state, startedAt, endedAt, closedAt, balance }   (no breakdown)
//          balance is null only for an "unfinished" session that had no point
//          from after its end, or no baseline; such a record carries
//          stashChanged itself.
// Schema 1 (farm sessions only, `running` a single Open or null, no kind,
// parent, baseline or press) is read as farm sessions without a parent whose
// start is the copy at the press: that is what a schema-1 start was.

const KINDS = new Set(SESSION_KINDS)
const isNum = v => typeof v === 'number' && Number.isFinite(v)

const snapToFile = sn => (sn ? { at: sn.at, c: sn.c, cd: sn.cd, i: [...sn.items].map(([n, v]) => [n, v[0], v[1]]) } : null)

function snapFromFile (st) {
  if (!st || typeof st !== 'object' || !isNum(st.at) || !isNum(st.c) || !Array.isArray(st.i)) return null
  const items = new Map()
  for (const row of st.i) {
    if (!Array.isArray(row) || typeof row[0] !== 'string') continue
    const q = Number(row[1]); const v = Number(row[2])
    items.set(row[0], [Number.isFinite(q) ? q : 0, Number.isFinite(v) ? v : 0])
  }
  return { at: st.at, c: st.c, cd: rateOf(st.cd), items }
}

// A history.latest() copied, so a later change to the history's map cannot
// move it.
function copySnap (latest) {
  return {
    at: latest.at,
    c: latest.c,
    cd: rateOf(latest.cd),
    items: new Map([...latest.items].map(([k, v]) => [k, [v[0], v[1]]]))
  }
}

function openToFile (o) {
  const out = {
    id: o.id,
    kind: o.kind,
    parent: o.parent ?? null,
    startedAt: o.startedAt,
    stashChanged: !!o.stashChanged,
    baseline: o.baseline ?? null,
    start: snapToFile(o.start),
    press: snapToFile(o.press)
  }
  if (o.press && o.pressChanged) out.pressChanged = true
  if (o.endedAt != null) out.endedAt = o.endedAt
  return out
}

function openFromFile (o, { ended }) {
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !isNum(o.startedAt) || !KINDS.has(o.kind)) return null
  if (ended && !isNum(o.endedAt)) return null
  const start = o.start == null ? null : snapFromFile(o.start)
  if (o.start != null && !start) return null
  const press = o.press == null ? null : snapFromFile(o.press)
  const baseline = start ? (o.baseline === 'read' ? 'read' : 'at-press') : null
  const out = {
    id: o.id,
    kind: o.kind,
    parent: o.kind === 'farm' && typeof o.parent === 'string' ? o.parent : null,
    startedAt: o.startedAt,
    stashChanged: o.stashChanged === true,
    baseline,
    start,
    press
  }
  if (press && o.pressChanged === true) out.pressChanged = true
  if (ended) out.endedAt = o.endedAt
  return out
}

function doneFromFile (d) {
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !KINDS.has(d.kind)) return null
  if (d.state !== 'final' && d.state !== 'unfinished') return null
  if (!isNum(d.startedAt) || !isNum(d.endedAt) || !isNum(d.closedAt)) return null
  if (d.balance === null) return d.state === 'unfinished' ? d : null
  if (!d.balance || typeof d.balance !== 'object' || !isNum(d.balance.loot)) return null
  return d
}

// Schema 1 -> 2 (see the file form above). Anything that is not an entry is
// passed on as it is, so the load drops and counts it like any other.
function migrateSessions (doc) {
  if (doc.schema_version !== 1) return null
  const src = doc.users
  if (!src || typeof src !== 'object' || Array.isArray(src)) return { schema_version: SESSIONS_SCHEMA_VERSION, users: src }
  const asOpen = o => (o && typeof o === 'object' && !Array.isArray(o)
    ? { ...o, kind: 'farm', parent: null, baseline: o.start ? 'at-press' : null, press: null }
    : o)
  const asDone = d => (d && typeof d === 'object' && !Array.isArray(d) ? { ...d, kind: 'farm', parent: null, baseline: 'at-press' } : d)
  const users = {}
  for (const [user, rec] of Object.entries(src)) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { users[user] = rec; continue }
    users[user] = {
      running: rec.running == null ? [] : [asOpen(rec.running)],
      pending: Array.isArray(rec.pending) ? rec.pending.map(asOpen) : rec.pending,
      done: Array.isArray(rec.done) ? rec.done.map(asDone) : rec.done
    }
  }
  return { schema_version: SESSIONS_SCHEMA_VERSION, users }
}

let tmpCounter = 0

export function createSessions (filePath, {
  baselineMaxAgeMs = SESSION_BASELINE_MAX_AGE_MS_DEFAULT,
  rateMinMs = SESSION_RATE_MIN_MS_DEFAULT,
  topN = SESSION_TOP_N_DEFAULT,
  keep = SESSIONS_KEEP_DEFAULT,
  finalizeMaxMs = SESSION_FINALIZE_MAX_MS_DEFAULT,
  now = Date.now,
  log = console
} = {}) {
  // user -> { running: { farm: Open|null, game: Open|null }, pending: Open[], done: Done[] }
  const users = new Map()
  let saveWarned = false
  let chain = Promise.resolve()

  const blank = () => ({ running: { farm: null, game: null }, pending: [], done: [] })
  function slot (user) {
    let u = users.get(user)
    if (!u) { u = blank(); users.set(user, u) }
    return u
  }
  const runningList = u => SESSION_KINDS.map(k => u.running[k]).filter(Boolean)

  async function writeOnce () {
    if (!api.writable) return false
    const doc = { schema_version: SESSIONS_SCHEMA_VERSION, users: {} }
    for (const [user, u] of users) {
      doc.users[user] = {
        running: runningList(u).map(openToFile),
        pending: u.pending.map(openToFile),
        done: u.done
      }
    }
    const tmpPath = `${filePath}.${process.pid}.${++tmpCounter}.tmp`
    try {
      await writeFile(tmpPath, JSON.stringify(doc), 'utf8')
      await rename(tmpPath, filePath)
      saveWarned = false
      return true
    } catch (e) {
      await unlink(tmpPath).catch(() => {})
      if (!saveWarned) {
        saveWarned = true
        log.warn?.(`[networth-sessions] could not save ${filePath} (${e?.code || e?.message || e}) — sessions are kept in memory`)
      }
      return false
    }
  }

  // One write at a time, each serialising the state as it is when it runs: two
  // overlapping writes could otherwise land in the wrong order and leave the
  // older state on disk.
  function save () {
    const p = chain.then(writeOnce)
    chain = p.catch(() => false)
    return p
  }

  const stateOf = o => (o.endedAt != null ? 'preliminary' : o.start ? 'running' : 'starting')

  // The baseline arrives: from the first full read after the start ('read'),
  // or from the copy at the start ('at-press'). A tab change noted while the
  // session was starting happened before a read baseline was taken, so it is
  // no change for the session; for the copy it is (pressChanged keeps it, in
  // case the end falls back to the copy). The copy stays with a read baseline
  // until the end (settleAtEnd).
  function setBaseline (o, snap, how) {
    o.start = snap
    o.baseline = how
    if (how === 'read') {
      o.pressChanged = !!o.stashChanged
      o.stashChanged = false
    } else {
      o.press = null
      delete o.pressChanged
    }
  }

  // The end decides the baseline for good. A read baseline from after the end
  // (a game session's end dated back to the stop, see the head of this file)
  // is dropped for the copy at the start, with the tab changes noted since the
  // press; without a copy the session has no baseline and closes without
  // figures. A session still starting takes the copy. The copy goes then.
  function settleAtEnd (o) {
    if (o.start && o.start.at > o.endedAt) {
      if (o.press) {
        const changed = !!o.pressChanged || !!o.stashChanged
        setBaseline(o, o.press, 'at-press')
        o.stashChanged = changed
      } else {
        o.start = null
        o.baseline = null
      }
    } else if (!o.start && o.press) {
      setBaseline(o, o.press, 'at-press')
    }
    o.press = null
    delete o.pressChanged
  }

  // A starting session's baseline, if it can be set now. `latest` is a point
  // the history just recorded (or the newest one, for expire()).
  function tryBaseline (o, latest, roundSince) {
    if (o.start) return false
    if (latest && latest.at >= o.startedAt && roundSince?.(o.startedAt)?.complete === true) {
      setBaseline(o, copySnap(latest), 'read')
      return true
    }
    if (o.press && now() - o.startedAt >= finalizeMaxMs) {
      setBaseline(o, o.press, 'at-press')
      return true
    }
    return false
  }

  // `latest` older than the end (or none), or a session without a baseline,
  // only reaches here for "unfinished": no point to strike the balance
  // against, so it is null, not a figure that stops before the end.
  function close (u, p, latest, state, { withheld }) {
    const rec = {
      id: p.id, kind: p.kind, parent: p.parent ?? null, baseline: p.baseline ?? null,
      state, startedAt: p.startedAt, endedAt: p.endedAt, closedAt: now()
    }
    if (p.start && latest && latest.at >= p.endedAt) {
      const held = withheldFor(p, latest, withheld)
      const bal = balance(p.start, latest, { topN, withheld: held })
      rec.balance = { ...bal, stashChanged: !!p.stashChanged, withheld: held }
    } else {
      rec.balance = null
      rec.stashChanged = !!p.stashChanged
    }
    u.done.push(rec)
    if (u.done.length > keep) u.done.splice(0, u.done.length - keep)
    return rec
  }

  // Ended sessions past their confirmation window, closed as "unfinished".
  function closeExpired (u, p, latest, withheld) {
    if (now() - p.endedAt < finalizeMaxMs) return false
    close(u, p, latest, 'unfinished', { withheld })
    return true
  }

  function liveOf (o, latest, { roundSince, aboutOf, withheld } = {}) {
    const state = stateOf(o)
    const endedAt = o.endedAt ?? null
    const durationMs = (endedAt ?? now()) - o.startedAt
    // The moment the session waits for a round from: its start while it is
    // starting, its end once it has ended.
    const since = state === 'starting' ? o.startedAt : state === 'preliminary' ? endedAt : null
    let round = null
    let about = null
    if (since != null && typeof roundSince === 'function') {
      const r = roundSince(since)
      if (r && isNum(r.done) && isNum(r.total)) round = { done: r.done, total: r.total }
    }
    if (since != null && typeof aboutOf === 'function') {
      const a = aboutOf(since)
      if (isNum(a)) about = a
    }
    let bal = null
    if (o.start && latest && latest.at >= o.start.at) {
      const held = withheldFor(o, latest, withheld)
      const b = balance(o.start, latest, { topN, withheld: held })
      bal = {
        ...b,
        withheld: held,
        stashChanged: !!o.stashChanged,
        ...hourly(b, durationMs, { rateMinMs, stashChanged: !!o.stashChanged })
      }
    }
    return {
      id: o.id,
      kind: o.kind,
      parent: o.parent ?? null,
      state,
      baseline: o.baseline ?? null,
      startedAt: o.startedAt,
      endedAt,
      durationMs,
      asOf: bal ? latest.at : null,
      round,
      about,
      stashChanged: !!o.stashChanged,
      balance: bal
    }
  }

  function doneView (d) {
    const durationMs = d.endedAt - d.startedAt
    const stashChanged = d.balance ? d.balance.stashChanged === true : d.stashChanged === true
    return {
      id: d.id,
      kind: d.kind,
      parent: d.parent ?? null,
      state: d.state,
      baseline: d.baseline ?? null,
      startedAt: d.startedAt,
      endedAt: d.endedAt,
      closedAt: d.closedAt,
      durationMs,
      stashChanged,
      balance: d.balance ? { ...d.balance, ...hourly(d.balance, durationMs, { rateMinMs, stashChanged }) } : null
    }
  }

  // For the status line: the running session's figures without lists.
  function liveShort (o, latest) {
    const bal = o.start && latest && latest.at >= o.start.at ? balance(o.start, latest, { topN: 0 }) : null
    return {
      id: o.id,
      kind: o.kind,
      parent: o.parent ?? null,
      state: stateOf(o),
      baseline: o.baseline ?? null,
      startedAt: o.startedAt,
      loot: bal ? bal.loot : null,
      lootDiv: bal ? bal.lootDiv : null,
      asOf: bal ? latest.at : null,
      stashChanged: !!o.stashChanged
    }
  }

  const kindOf = k => (k === undefined ? 'farm' : k)

  const api = {
    // server.mjs sets this to false when /config cannot be written; the load
    // only ever lowers it (store-file.mjs).
    writable: true,

    async load () {
      users.clear()
      const r = await loadVersionedJson(filePath, {
        tag: 'networth-sessions',
        schemaVersion: SESSIONS_SCHEMA_VERSION,
        migrate: migrateSessions,
        shapeProblem: d => (d.users && typeof d.users === 'object' && !Array.isArray(d.users)) ? null : 'users is missing or not an object',
        emptyMeans: 'starting without sessions (running ones are lost; finished ones are in the moved file)',
        log
      })
      if (!r.writable) api.writable = false
      const doc = r.data
      if (!doc) return
      for (const [user, rec] of Object.entries(doc.users)) {
        if (!user || !rec || typeof rec !== 'object') continue
        let dropped = 0
        const u = blank()
        for (const o of Array.isArray(rec.running) ? rec.running : []) {
          const x = openFromFile(o, { ended: false })
          if (x && !u.running[x.kind]) u.running[x.kind] = x; else dropped++
        }
        for (const p of Array.isArray(rec.pending) ? rec.pending : []) {
          const o = openFromFile(p, { ended: true })
          if (o) u.pending.push(o); else dropped++
        }
        for (const d of Array.isArray(rec.done) ? rec.done : []) {
          const o = doneFromFile(d)
          if (o) u.done.push(o); else dropped++
        }
        if (dropped) log.warn?.(`[networth-sessions] dropped ${dropped} unreadable session entr${dropped === 1 ? 'y' : 'ies'} for ${user}`)
        users.set(user, u)
      }
    },

    isOpen (user) {
      const u = users.get(user)
      return !!u && (runningList(u).length > 0 || u.pending.length > 0)
    },

    // { id, kind, startedAt, state } of the running session of a kind, or null.
    runningOf (user, kind = 'farm') {
      const o = users.get(user)?.running[kind]
      return o ? { id: o.id, kind: o.kind, parent: o.parent ?? null, startedAt: o.startedAt, state: stateOf(o) } : null
    },

    // Check and mutation happen before the first await, so two clicks at the
    // same moment cannot both start a session. `latest` is the newest point:
    // kept as the copy at the start when it is fresh (see the head of this
    // file); a farm session is refused without a fresh one.
    async start (user, latest, { kind } = {}) {
      const k = kindOf(kind)
      if (!KINDS.has(k)) return { ok: false, error: 'bad-kind' }
      const fresh = !!latest && latest.items instanceof Map && isNum(latest.at) && now() - latest.at <= baselineMaxAgeMs
      if (k === 'farm' && !fresh) return { ok: false, error: 'no-baseline' }
      const u = slot(user)
      if (u.running[k]) return { ok: false, error: 'already-running' }
      const t = now()
      const o = {
        id: `${k === 'game' ? 'g' : 's'}-${t}`,
        kind: k,
        parent: k === 'farm' ? (u.running.game?.id ?? null) : null,
        startedAt: t,
        stashChanged: false,
        baseline: null,
        start: null,
        press: fresh ? copySnap(latest) : null
      }
      u.running[k] = o
      const session = liveOf(o, latest)
      await save()
      return { ok: true, session }
    },

    // `at` (optional) is when it ended, for a game session that ended a while
    // before it was noticed (session-control.mjs); never before the start and
    // never in the future. The baseline is decided here (settleAtEnd): a
    // session still starting, or one whose read baseline lies after `at`,
    // takes the copy at its start, because a read from after the end would
    // carry the session's own loot.
    async end (user, { kind, at } = {}) {
      const k = kindOf(kind)
      const u = users.get(user)
      const o = u?.running[k]
      if (!o) return { ok: false, error: 'not-running' }
      o.endedAt = isNum(at) ? Math.min(now(), Math.max(o.startedAt, at)) : now()
      settleAtEnd(o)
      u.running[k] = null
      u.pending.push(o)
      const session = liveOf(o, null)
      await save()
      return { ok: true, session }
    },

    // Ends the running session of a kind and closes it as "unfinished" at once:
    // a game session whose game state nobody could tell for finalizeMaxMs
    // (session-control.mjs). `endedAt` as in end().
    async closeRunning (user, { kind, endedAt, latest = null, withheld = [] } = {}) {
      const k = kindOf(kind)
      const u = users.get(user)
      const o = u?.running[k]
      if (!o) return { ok: false, error: 'not-running' }
      o.endedAt = isNum(endedAt) ? Math.min(now(), Math.max(o.startedAt, endedAt)) : now()
      settleAtEnd(o)
      u.running[k] = null
      const rec = close(u, o, latest, 'unfinished', { withheld })
      await save()
      return { ok: true, session: doneView(rec) }
    },

    // Throws a running session away, leaving no line in the list: a start by
    // mistake, or a session that was not what it was meant to measure. The
    // farm sessions of a discarded game session keep their lines, without a
    // parent.
    async discard (user, { kind } = {}) {
      const k = kindOf(kind)
      const u = users.get(user)
      const o = u?.running[k]
      if (!o) return { ok: false, error: 'not-running' }
      u.running[k] = null
      if (k === 'game') {
        for (const x of [u.running.farm, ...u.pending, ...u.done]) if (x && x.parent === o.id) x.parent = null
      }
      await save()
      return { ok: true, session: { id: o.id, kind: k } }
    },

    async noteStashChanged (user) {
      const u = users.get(user)
      if (!u) return false
      let marked = false
      for (const o of [...runningList(u), ...u.pending]) {
        if (o && !o.stashChanged) { o.stashChanged = true; marked = true }
        // A read baseline may still give way to the copy at the end (settleAtEnd).
        if (o && o.press && o.start && !o.pressChanged) { o.pressChanged = true; marked = true }
      }
      if (marked) await save()
      return marked
    },

    // Called after every recorded history point while a session is open.
    // `changes` lists every session whose state changed, in the order it
    // happened: { id, kind, state } with state 'running' (baseline set),
    // 'final' or 'unfinished'. `finalized` lists the ids that were closed.
    async observe (user, latest, { roundSince, withheld = [] } = {}) {
      const u = users.get(user)
      const finalized = []
      const changes = []
      if (!u || !latest) return { finalized, changes }
      for (const o of runningList(u)) {
        if (tryBaseline(o, latest, roundSince)) changes.push({ id: o.id, kind: o.kind, state: 'running' })
      }
      const keepOpen = []
      for (const p of u.pending) {
        let rec = null
        if (latest.at >= p.endedAt && roundSince?.(p.endedAt)?.complete === true) {
          rec = close(u, p, latest, p.start ? 'final' : 'unfinished', { withheld })
        } else if (now() - p.endedAt >= finalizeMaxMs) {
          rec = close(u, p, latest, 'unfinished', { withheld })
        }
        if (rec) { finalized.push(p.id); changes.push({ id: p.id, kind: p.kind, state: rec.state }) } else keepOpen.push(p)
      }
      u.pending = keepOpen
      if (changes.length) await save()
      return { finalized, changes }
    },

    // The same windows, without a new point: observe() only runs after one,
    // and a session whose user stopped syncing would otherwise stay starting
    // or preliminary for good. A starting session past finalizeMaxMs takes
    // the copy at its start; an ended one is closed as "unfinished".
    async expire (user, latest, { withheld = [] } = {}) {
      const u = users.get(user)
      const finalized = []
      const changes = []
      if (!u) return { finalized, changes }
      for (const o of runningList(u)) {
        if (tryBaseline(o, null, null)) changes.push({ id: o.id, kind: o.kind, state: 'running' })
      }
      u.pending = u.pending.filter(p => {
        if (!closeExpired(u, p, latest, withheld)) return true
        finalized.push(p.id)
        changes.push({ id: p.id, kind: p.kind, state: 'unfinished' })
        return false
      })
      if (changes.length) await save()
      return { finalized, changes }
    },

    // For the status line: the running sessions' figures, and how many ended
    // ones are still waiting for their confirming round. stashChanged says the
    // loot figure is no farming result (a tab came, went or was read for the
    // first time, or another league), so the line does not show it as one.
    live (user, latest) {
      const u = users.get(user)
      const pending = u ? u.pending.length : 0
      return {
        running: u?.running.farm ? liveShort(u.running.farm, latest) : null,
        game: u?.running.game ? liveShort(u.running.game, latest) : null,
        pending
      }
    },

    // One session as the History page shows it, wherever it is (running,
    // ended or closed), or null.
    get (user, id, latest, { roundSince, aboutOf, withheld = [] } = {}) {
      const u = users.get(user)
      if (!u) return null
      for (const o of [...runningList(u), ...u.pending]) if (o.id === id) return liveOf(o, latest, { roundSince, aboutOf, withheld })
      for (let i = u.done.length - 1; i >= 0; i--) if (u.done[i].id === id) return doneView(u.done[i])
      return null
    },

    // The History page's whole view: the running farm session (`running`), the
    // running game session (`game`), the ended ones waiting for their round,
    // and the newest closed ones.
    view (user, latest, { roundSince, aboutOf, withheld = [], listMax = SESSION_LIST_MAX_DEFAULT } = {}) {
      const u = users.get(user) || blank()
      const max = Math.max(0, Math.floor(Number(listMax) || 0))
      const opts = { roundSince, aboutOf, withheld }
      return {
        running: u.running.farm ? liveOf(u.running.farm, latest, opts) : null,
        game: u.running.game ? liveOf(u.running.game, latest, opts) : null,
        pending: u.pending.map(p => liveOf(p, latest, opts)),
        done: u.done.slice().reverse().slice(0, max).map(doneView)
      }
    }
  }
  return api
}
