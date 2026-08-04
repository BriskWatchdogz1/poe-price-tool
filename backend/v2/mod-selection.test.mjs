// The mod selection a card was searched with has to survive a reconnect.
//
// Bug: `rec.addedMsg` is built once, at POST time, and carries the DEFAULT mod
// ticks. Every reconnect replayed exactly that message together with the LAST
// price — so after a reload the picker showed the defaults ("Match mods 4")
// while the price block still showed the result of the user's own 3-mod search.
// The number stood next to a selection that never produced it.
//
// Fix: a manual search stores its (normalized) payload on the record, and every
// re-send of a card carries it as `item-added.selection` (see PROTOCOL.md).
//
// Boots the REAL server (pattern: server.test.mjs). NOTHING here may reach the
// trade API: the one job that runs is stubbed to throw before its first request.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'

process.env.PORT = '0'
process.env.POE_FAUSTUS_DISABLED = '1'
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_DATA_REFRESH_DISABLED = '1'
process.env.POE_REFERENCE_DISABLED = '1'
process.env.POE_NETWORTH_AUTOSYNC = '0'
// Dedicated rooms so these tests don't share state with any other suite.
process.env.POE_USERS = 'seluser,replayuser'

let mod
let base

before(async () => {
  mod = await import('./server.mjs')
  base = `127.0.0.1:${mod.server.address().port}`
})

after(async () => {
  await new Promise((resolve) => mod.server.close(resolve))
})

// A card as the frontend gets it: three mods, TWO of them ticked by default.
const defaultMods = () => ([
  { text: 'Energy Shield: #', kind: 'explicit', selected: true, value: 313, valueRange: [313, 345] },
  { text: '+#% total Elemental Resistance', kind: 'explicit', selected: true, value: 122, valueRange: [122, 133] },
  { text: 'Linked sockets', kind: 'links', selected: true, value: 4, valueRange: [1, 4] }
])

const addedMsg = (id) => ({
  type: 'item-added', id, name: 'Hypnotic Track', itemClass: 'Boots',
  rarity: 'rare', baseType: 'Warlock Boots', corrupted: false,
  priceStatus: 'queued', mods: defaultMods()
})

// A renderable price (hasValidPrice: done + listings + priceLow > 0).
const lastPrice = (id) => ({
  type: 'price-result', id, display: 'single', currency: 'divine',
  priceLow: 8, priceHigh: 125, priceMedian: 52.5, count: 65,
  listings: [{ price: 8, currency: 'divine', seller: '@Someone', ageMinutes: 3 }]
})

// Collects every message of one connection until `ms` has passed.
async function collect (user, ms, onOpen) {
  const ws = new WebSocket(`ws://${base}/events`, { headers: { cookie: `ppt_user=${user}` } })
  const msgs = []
  ws.on('message', d => { try { msgs.push(JSON.parse(d.toString())) } catch {} })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  if (onOpen) await onOpen(ws)
  await new Promise(r => setTimeout(r, ms))
  ws.close()
  return msgs
}

test('selectionOf: normalizes a search payload down to ticks, roll bounds and the corruption filter', () => {
  const sel = mod.selectionOf({
    corrupted: 'no',
    selectedMods: [
      { text: 'Energy Shield: #', min: 320 },
      { text: 'Linked sockets', min: 4, max: 4 },
      { text: 'no bounds at all' },
      null                                    // junk from a broken client is dropped
    ]
  })
  assert.deepEqual(sel, {
    corrupted: 'no',
    mods: [
      { text: 'Energy Shield: #', min: 320 },
      { text: 'Linked sockets', min: 4, max: 4 },
      { text: 'no bounds at all' }            // required, roll unconstrained
    ]
  })
  // An omitted bound must STAY omitted — it is what "handle at its stop" means.
  assert.ok(!('max' in sel.mods[0]), 'an open-ended upper bound is not invented')
  // Anything but yes/no is the unconstrained default.
  assert.equal(mod.selectionOf({}).corrupted, 'any')
  assert.equal(mod.selectionOf({ corrupted: 'garbage' }).corrupted, 'any')
  assert.deepEqual(mod.selectionOf({}).mods, [])
})

test('a manual search records the selection it ran with, and re-sends it on the card', async () => {
  const id = 'sel-card'
  const room = mod.users.get('seluser')
  room.items.clear()
  room.items.set(id, {
    id,
    item: {},
    // The price job must never leave this machine: reading preset.stats (what
    // applySelection does right after the selection is recorded) throws, so the
    // job dies before it can build a trade request.
    preset: { filters: {}, get stats () { throw new Error('stubbed preset — no trade request in tests') } },
    addedMsg: addedMsg(id),
    alive: true, status: 'done', lastPrice: lastPrice(id), selection: null
  })

  const msgs = await collect('seluser', 600, async ws => {
    ws.send(JSON.stringify({
      type: 'search', id, corrupted: 'no',
      selectedMods: [{ text: 'Energy Shield: #', min: 320 }, { text: '+#% total Elemental Resistance' }]
    }))
  })

  const rec = room.items.get(id)
  assert.deepEqual(rec.selection, {
    corrupted: 'no',
    mods: [{ text: 'Energy Shield: #', min: 320 }, { text: '+#% total Elemental Resistance' }]
  }, 'the record remembers what the user searched with')

  // Every card message after the search carries it (searching, and the error the
  // stubbed preset produces) — the picker must never be re-rendered without it.
  const cards = msgs.filter(m => m.type === 'item-added' && m.id === id)
  const after = cards.slice(1) // [0] is the replay from before the search
  assert.ok(after.length, 'the card was re-sent for the search')
  for (const c of after) assert.deepEqual(c.selection, rec.selection, `${c.priceStatus} card carries the selection`)
  assert.deepEqual(after[after.length - 1].mods, defaultMods(),
    'the item DEFAULTS still ride along untouched — selection is applied on top of them')

  room.items.clear()
})

test('reconnect replay: the card comes back with the selection its price came from, not the defaults', async () => {
  const id = 'replay-card'
  const room = mod.users.get('replayuser')
  room.items.clear()
  const selection = { corrupted: 'no', mods: [{ text: 'Energy Shield: #', min: 320 }] }
  room.items.set(id, {
    id, item: {}, preset: { filters: {}, stats: [] },
    addedMsg: addedMsg(id),
    alive: true, status: 'done', lastPrice: lastPrice(id), selection
  })

  const msgs = await collect('replayuser', 400)
  const card = msgs.find(m => m.type === 'item-added' && m.id === id)
  const price = msgs.find(m => m.type === 'price-result' && m.id === id)

  assert.ok(card, 'the card is replayed')
  assert.equal(card.priceStatus, 'done')
  assert.ok(price, 'and its last price follows')
  assert.equal(price.count, 65)
  // The regression: without the selection the client re-renders three ticked
  // mods next to a price that was searched with ONE.
  assert.deepEqual(card.selection, selection,
    'the replayed card carries the selection the replayed price was searched with')
  assert.equal(card.selection.mods.length, 1)
  assert.deepEqual(card.mods, defaultMods(), 'the defaults are still there for "↺ Reset" to fall back on')

  // A card that was never manually searched claims no selection at all (its
  // price IS the default selection the mods already describe).
  const fresh = 'replay-untouched'
  room.items.set(fresh, {
    id: fresh, item: {}, preset: { filters: {}, stats: [] },
    addedMsg: addedMsg(fresh), alive: true, status: 'done', lastPrice: lastPrice(fresh), selection: null
  })
  const again = await collect('replayuser', 400)
  const freshCard = again.find(m => m.type === 'item-added' && m.id === fresh)
  assert.ok(freshCard, 'the untouched card is replayed too')
  assert.ok(!('selection' in freshCard), 'no manual search -> no selection field')

  room.items.clear()
})
