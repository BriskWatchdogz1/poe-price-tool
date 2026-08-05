import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createValuator } from './valuator.mjs'
import { VALUATION_ROUTES } from './kinds.mjs'

// Minimal faustus store stub (Task 3 shape): getPrice + league + isFresh (F1).
// fresh defaults to true so existing tests pass the freshness gate; one dedicated
// test sets fresh:false to exercise the stale gate.
function fakeFaustusStore (prices = {}, league = L, { fresh = true } = {}) {
  const m = prices instanceof Map ? prices : new Map(Object.entries(prices))
  return {
    getPrice: name => (m.has(name) ? m.get(name) : null),
    league: () => league,
    isFresh: () => fresh
  }
}

// Fake fetchers: they return the response shapes verified against the repo.
function fakeDeps () {
  const calls = []
  return {
    calls,
    // Default: empty currency-overview -> the fungible chain falls through to
    // fromExchangeMap. Individual tests override this on purpose.
    fetchCurrencyOverview: async (league, type) => {
      calls.push(['currency', league, type])
      return { byName: new Map() }
    },
    fetchExchangeOverview: async (league, type) => {
      calls.push(['exchange', league, type])
      if (type === 'Currency') {
        return {
          nameToId: new Map([['Divine Orb', 'divine']]),
          lineById: new Map([['divine', { id: 'divine', primaryValue: 215.4 }]])
        }
      }
      if (type === 'Essence') {
        return {
          nameToId: new Map([['Deafening Essence of Fear', 'deafening-essence-of-fear']]),
          lineById: new Map([['deafening-essence-of-fear', { id: 'deafening-essence-of-fear', primaryValue: 44.34 }]])
        }
      }
      if (type === 'Scarab') {
        return {
          nameToId: new Map([['Titanic Scarab', 'titanic-scarab']]),
          lineById: new Map([['titanic-scarab', { id: 'titanic-scarab', primaryValue: 2.5 }]])
        }
      }
      if (type === 'DivinationCard') {
        return {
          nameToId: new Map([['The Doctor', 'the-doctor']]),
          lineById: new Map([['the-doctor', { id: 'the-doctor', primaryValue: 900 }]])
        }
      }
      return { nameToId: new Map(), lineById: new Map() }
    },
    fetchItemOverview: async (league, type) => {
      calls.push(['item', league, type])
      if (type === 'UniqueArmour') {
        return [
          { name: 'Abyssus', baseType: 'Ezomyte Burgonet', chaosValue: 42.7, listingCount: 120, count: 60 },
          { name: 'Abyssus', baseType: 'Other Base', chaosValue: 999, listingCount: 55, count: 30 },
          // Phantom: healthy listingCount but a tiny sample (count) -> filtered.
          // This is the real Standard pattern (cf. Soulwrest 1.8M @ count 1).
          { name: 'Abyssus', baseType: 'Ezomyte Burgonet', chaosValue: 9999999, listingCount: 40, count: 2 }
        ]
      }
      // Shape as verified live: the baseType is "Map (Tier N)", NEVER the map
      // base name of the stash item -- so the tiebreak never applies here.
      if (type === 'UniqueMap') {
        return [
          { name: 'Maelström of Chaos', baseType: 'Map (Tier 8)', chaosValue: 1, listingCount: 30, count: 20 },
          { name: "Doryani's Machinarium", baseType: 'Map (Tier 14)', chaosValue: 252.8, listingCount: 40, count: 25 }
        ]
      }
      if (type === 'Beast') return [{ name: 'Black Mórrigan', chaosValue: 77, listingCount: 12, count: 8 }]
      if (type === 'Invitation') return [{ name: 'Screaming Invitation', chaosValue: 33, listingCount: 40, count: 20 }]
      if (type === 'SkillGem') {
        return [
          { name: 'Enlighten Support', gemLevel: 3, gemQuality: null, corrupted: null, variant: '3', chaosValue: 2394, listingCount: 686, count: 200 },
          { name: 'Enlighten Support', gemLevel: 4, gemQuality: null, corrupted: true, variant: '4c', chaosValue: 16758, listingCount: 270, count: 90 },
          { name: 'Enlighten Support', gemLevel: 1, gemQuality: null, corrupted: null, variant: '1', chaosValue: 1197, listingCount: 857, count: 300 },
          // Phantom of the EXACT 4c variant: healthy listingCount, tiny sample -> filtered.
          { name: 'Enlighten Support', gemLevel: 4, gemQuality: null, corrupted: true, variant: '4c', chaosValue: 9999999, listingCount: 30, count: 2 },
          // Real-world Bear Trap: the exact (lvl20,q0,uncorrupted) variant exists
          // ONLY as a low-count phantom (369k chaos, count 3) that poe.ninja hides
          // by default; a confident (20,20) sits beside it. Must never win a pick.
          { name: 'Bear Trap', gemLevel: 20, gemQuality: null, corrupted: null, variant: '20', chaosValue: 369553, listingCount: 21, count: 3 },
          { name: 'Bear Trap', gemLevel: 20, gemQuality: 20, corrupted: null, variant: '20/20', chaosValue: 16.7, listingCount: 37, count: 9 },
          { name: 'Bear Trap', gemLevel: 1, gemQuality: null, corrupted: null, variant: '1', chaosValue: 1, listingCount: 140, count: 36 }
        ]
      }
      return []
    },
  }
}

const L = 'Standard'

test('stackable via exchange map (name fallback): stack multiplies', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  const r = await v.value({ kind: 'stackable', name: 'Divine Orb', tradeTag: 'divine', stack: 3 })
  assert.deepEqual(r, { chaosEach: 215.4, chaosTotal: 646.2, source: 'exchange' })
})

test('regression: the exchange beats the stash currency-overview (cheap currency)', async () => {
  // Real case Armourer's Scrap: poe.ninja's STASH overview reports
  // chaosEquivalent=1.0 for currency without a `pay` side -- 20 scraps were
  // counted as 20c while the Currency Exchange said 0.096c (in-game window
  // 1:10). The exchange source must therefore win BEFORE the stash overview.
  const deps = fakeDeps()
  deps.fetchCurrencyOverview = async () => ({ byName: new Map([["Armourer's Scrap", 1.0]]) })
  const inner = deps.fetchExchangeOverview
  deps.fetchExchangeOverview = async (league, type) => {
    if (type === 'Currency') {
      return {
        nameToId: new Map([["Armourer's Scrap", 'armourers-scrap']]),
        lineById: new Map([['armourers-scrap', { id: 'armourers-scrap', primaryValue: 0.096 }]])
      }
    }
    return inner(league, type)
  }
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'stackable', name: "Armourer's Scrap", tradeTag: 'armourers-scrap', stack: 20 })
  assert.equal(r.source, 'exchange', 'stash overview took precedence again -> 1c mispricing')
  assert.ok(r.chaosEach < 0.2, `chaosEach should be ~0.1, was ${r.chaosEach}`)
  assert.ok(r.chaosTotal < 4, `20 scraps should be ~2c, were ${r.chaosTotal}`)
})

test('Faustus still beats ALL ninja sources', async () => {
  const deps = fakeDeps()
  deps.fetchCurrencyOverview = async () => ({ byName: new Map([["Armourer's Scrap", 1.0]]) })
  deps.faustusStore = fakeFaustusStore({ "Armourer's Scrap": 0.1333 })
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'stackable', name: "Armourer's Scrap", tradeTag: 'armourers-scrap', stack: 20 })
  assert.equal(r.source, 'faustus')
  assert.equal(r.chaosEach, 0.1)
})

test('stackable via exchange map by tradeTag (Essence)', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  const r = await v.value({ kind: 'stackable', name: 'Deafening Essence of Fear', tradeTag: 'deafening-essence-of-fear', stack: 5 })
  assert.equal(r.source, 'exchange')
  assert.equal(r.chaosEach, 44.3)
  assert.equal(r.chaosTotal, 221.7)
})

test('stackable: scarabs live on the exchange endpoint, no longer item/overview', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  const r = await v.value({ kind: 'stackable', name: 'Titanic Scarab', tradeTag: 'titanic-scarab', stack: 9 })
  assert.equal(r.source, 'exchange')
  assert.equal(r.chaosTotal, 22.5)
})

test('Chaos Orb: special case chaosEach=1 (it has no exchange line of its own)', async () => {
  const deps = fakeDeps()
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'stackable', name: 'Chaos Orb', tradeTag: 'chaos', stack: 273 })
  assert.deepEqual(r, { chaosEach: 1, chaosTotal: 273, source: 'chaos' })
  assert.equal(deps.calls.length, 0) // no fetch needed
})

test('exchange map is built only ONCE per valuator (14 requests, then cached)', async () => {
  const deps = fakeDeps()
  const v = createValuator({ league: L, deps })
  await v.value({ kind: 'stackable', name: 'Divine Orb', tradeTag: 'divine', stack: 1 })
  await v.value({ kind: 'stackable', name: 'Titanic Scarab', tradeTag: 'titanic-scarab', stack: 1 })
  const exchangeCalls = deps.calls.filter(c => c[0] === 'exchange').length
  assert.equal(exchangeCalls, 14) // the 14 stackable exchange types, exactly once
})

test('divcard via Exchange DivinationCard', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  const r = await v.value({ kind: 'divcard', name: 'The Doctor', stack: 2 })
  assert.deepEqual(r, { chaosEach: 900, chaosTotal: 1800, source: 'exchange:DivinationCard' })
})

test('divcard missing from the (loaded) exchange -> null (Task 4: forced 0 is gone)', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  // No faustus store, the DivinationCard overview loads (it contains The Doctor),
  // Rain of Chaos is missing from it -> honestly unpriced (null), no forced 0.
  assert.equal(await v.value({ kind: 'divcard', name: 'Rain of Chaos', stack: 68 }), null)
})

test('divcard: the Faustus value wins over the card exchange', async () => {
  const deps = fakeDeps()
  deps.faustusStore = fakeFaustusStore({ 'The Doctor': 1234 })
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'divcard', name: 'The Doctor', stack: 2 })
  assert.deepEqual(r, { chaosEach: 1234, chaosTotal: 2468, source: 'faustus' })
})

// F1: a stale faustus store (isFresh=false) must NOT serve frozen prices any
// more -> fromFaustus returns null and the fungible chain falls through to the
// next source. Here the card exchange carries The Doctor (900), so THAT source
// wins instead of the frozen Faustus value (1234).
test('F1: a stale faustus store (isFresh=false) is ignored -> falls through to the exchange', async () => {
  const deps = fakeDeps()
  deps.faustusStore = fakeFaustusStore({ 'The Doctor': 1234 }, L, { fresh: false })
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'divcard', name: 'The Doctor', stack: 2 })
  assert.notEqual(r, null, 'the fallthrough produced a price')
  assert.equal(r.source, 'exchange:DivinationCard', 'stale Faustus was bypassed -> exchange source')
  assert.notEqual(r.chaosEach, 1234, 'the frozen Faustus value must NOT bleed through any more')
})

// F1: a stale faustus store with NO fallback source -> honestly unpriced (null)
// instead of handing on the zombie price.
test('F1: stale Faustus with no fallback price -> null (no zombie price)', async () => {
  const deps = fakeDeps()
  // The card exchange does not know THIS card -> no fallback source.
  const inner = deps.fetchExchangeOverview
  deps.fetchExchangeOverview = async (league, type) =>
    type === 'DivinationCard' ? { nameToId: new Map(), lineById: new Map() } : inner(league, type)
  deps.faustusStore = fakeFaustusStore({ 'The Doctor': 1234 }, L, { fresh: false })
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'divcard', name: 'The Doctor', stack: 2 })
  assert.equal(r, null, 'stale Faustus + no fallback source -> honestly unpriced')
})

// F1: a store fresh within the TTL stays valid (counter-check to the stale test).
test('F1: a fresh faustus store (isFresh=true) wins as usual', async () => {
  const deps = fakeDeps()
  deps.faustusStore = fakeFaustusStore({ 'The Doctor': 1234 }, L, { fresh: true })
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'divcard', name: 'The Doctor', stack: 2 })
  assert.deepEqual(r, { chaosEach: 1234, chaosTotal: 2468, source: 'faustus' })
})

test('divcard when the exchange is down -> null (never 0, so a real card is not zeroed)', async () => {
  const deps = fakeDeps()
  // Simulate an outage/404 for DivinationCard ONLY: empty overview.
  const inner = deps.fetchExchangeOverview
  deps.fetchExchangeOverview = async (league, type) =>
    type === 'DivinationCard' ? { nameToId: new Map(), lineById: new Map() } : inner(league, type)
  const v = createValuator({ league: L, deps })
  assert.equal(await v.value({ kind: 'divcard', name: 'The Doctor', stack: 1 }), null)
})

test('unique: baseType tiebreak + junk filter (fake single-listing line discarded)', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  const r = await v.value({ kind: 'unique', name: 'Abyssus', baseType: 'Ezomyte Burgonet', category: 'Helmet', stack: 1 })
  assert.deepEqual(r, { chaosEach: 42.7, chaosTotal: 42.7, source: 'item:UniqueArmour' })
})

test('unique without a category (base not in items.ndjson) -> null', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  assert.equal(await v.value({ kind: 'unique', name: 'X', baseType: 'Y', category: null, stack: 1 }), null)
})

test('unique map: category Map -> UniqueMap overview, the baseType tiebreak does no harm', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  const r = await v.value({ kind: 'unique', name: 'Maelström of Chaos', baseType: 'Torture Chamber Map', category: 'Map', links: 0, stack: 1 })
  assert.deepEqual(r, { chaosEach: 1, chaosTotal: 1, source: 'item:UniqueMap' })
})

test('unidentified unique: no poe.ninja call, result null (never 0)', async () => {
  const deps = fakeDeps()
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'unique', name: 'Unidentified Ezomyte Burgonet', baseType: 'Ezomyte Burgonet', category: 'Helmet', unidentified: true, links: 0, stack: 1 })
  assert.equal(r, null)
  assert.deepEqual(deps.calls.filter(c => c[0] === 'item'), []) // no lookup triggered
})

test('gem: exact variant (level/quality/corrupted) + junk filter', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  const r = await v.value({ kind: 'gem', name: 'Enlighten Support', level: 4, quality: 0, corrupted: true, stack: 1 })
  assert.deepEqual(r, { chaosEach: 16758, chaosTotal: 16758, source: 'item:SkillGem' })
})

test('gem: no exact variant -> next best, same corrupted status preferred', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  // Level 5, uncorrupted: no exact hit. Level 4c is closer in level but is
  // penalised heavily for the corrupted mismatch -> level 3 uncorrupted (2394) wins.
  const r = await v.value({ kind: 'gem', name: 'Enlighten Support', level: 5, quality: 0, corrupted: false, stack: 1 })
  assert.equal(r.chaosEach, 2394)
})

test('gem: the exact variant exists only as a low-count phantom -> dropped, not 369k (Bear Trap case)', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  // A plain level-20/q0/uncorrupted Bear Trap. The exactly matching line is the
  // 369553 phantom line (count 3) -> must be thrown out. No other exact hit ->
  // the next best confident line (20/20, 16.7) wins. Never 369553.
  const r = await v.value({ kind: 'gem', name: 'Bear Trap', level: 20, quality: 0, corrupted: false, stack: 1 })
  assert.equal(r.chaosEach, 16.7)
})

test('gem: unknown name -> null (unpriced)', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  assert.equal(await v.value({ kind: 'gem', name: 'Nonexistent Gem', level: 20, quality: 20, corrupted: false, stack: 1 }), null)
})


test('cluster without a theme match -> null (unpriced, not 0)', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  assert.equal(await v.value({ kind: 'cluster', name: 'Large Cluster Jewel', stack: 1, cluster: { themeId: null, count: 8, bracket: '84' } }), null)
})

test('beast via item Beast', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  const r = await v.value({ kind: 'beast', name: 'Black Mórrigan', stack: 1 })
  assert.deepEqual(r, { chaosEach: 77, chaosTotal: 77, source: 'item:Beast' })
})

test('skip -> null', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  assert.equal(await v.value({ kind: 'skip', reason: 'rare-gear', name: 'x', stack: 1 }), null)
})

test('corpse -> null without a corpse store (no store = honestly unpriced)', async () => {
  // Without corpseStore in deps a (non-Imperfect) corpse is honestly unpriced.
  const v = createValuator({ league: L, deps: fakeDeps() })
  assert.equal(await v.value({ kind: 'corpse', name: 'Forest Tiger', tradeTag: null, stack: 2 }), null)
  assert.equal(await v.value({ kind: 'corpse', name: 'Unknown Corpse', tradeTag: null, stack: 1 }), null)
})

test('corpse: Imperfect -> 0 (no store access, no fetch)', async () => {
  // Imperfect is the ONE documented 0 exception. No store needed.
  let touched = false
  const deps = fakeDeps()
  deps.corpseStore = { getPrice: () => { touched = true; return 999 }, league: () => L }
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'corpse', name: 'Imperfect Forest Tiger', tradeTag: null, stack: 3 })
  assert.deepEqual(r, { chaosEach: 0, chaosTotal: 0, source: 'corpse:imperfect' })
  assert.equal(touched, false)
})

test('corpse: a fresh store hit wins (each = getPrice, * stack)', async () => {
  const deps = fakeDeps()
  deps.corpseStore = { getPrice: name => (name === 'Forest Tiger' ? 12 : null), league: () => L }
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'corpse', name: 'Forest Tiger', tradeTag: null, stack: 4 })
  assert.deepEqual(r, { chaosEach: 12, chaosTotal: 48, source: 'corpse:trade' })
})

test('corpse: store for a DIFFERENT league -> null (no cross-league price)', async () => {
  const deps = fakeDeps()
  deps.corpseStore = { getPrice: () => 12, league: () => 'Hardcore' }
  const v = createValuator({ league: L, deps })
  assert.equal(await v.value({ kind: 'corpse', name: 'Forest Tiger', tradeTag: null, stack: 1 }), null)
})

// ---------------------------------------------------------------------------
// Fungible fallback chain (Task 4): Faustus -> ninja currency-overview
// (Currency/Fragment) -> ninja exchange-overview. First non-null wins.
// ---------------------------------------------------------------------------
test('fungible: a Faustus hit beats currency-overview and exchange', async () => {
  // Do NOT check this with 'Divine Orb': that is the display unit and
  // deliberately bypasses the Faustus precedence (own test further down).
  const deps = fakeDeps()
  deps.faustusStore = fakeFaustusStore({ 'Orb of Fusing': 200 })
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'stackable', name: 'Orb of Fusing', tradeTag: 'fusing', stack: 2 })
  assert.deepEqual(r, { chaosEach: 200, chaosTotal: 400, source: 'faustus' })
})

test('fungible: Faustus AND exchange both miss -> ninja currency-overview (Currency) wins', async () => {
  const deps = fakeDeps()
  // No faustus store, and the name is missing from the exchange overview (which
  // only carries 'Divine Orb') -> only then does the stash currency-overview
  // apply. This stage used to sit BEFORE the exchange and ruined cheap currency
  // (see the Armourer's Scrap regression above).
  deps.fetchCurrencyOverview = async (league, type) =>
    type === 'Currency' ? { byName: new Map([['Exalted Orb', 205]]) } : { byName: new Map() }
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'stackable', name: 'Exalted Orb', tradeTag: 'exalted', stack: 1 })
  assert.deepEqual(r, { chaosEach: 205, chaosTotal: 205, source: 'ninja:currency' })
})

test('fungible: miss in Currency -> the Fragment currency-overview wins', async () => {
  const deps = fakeDeps()
  deps.fetchCurrencyOverview = async (league, type) =>
    type === 'Fragment' ? { byName: new Map([['Sacrifice at Dusk', 7]]) } : { byName: new Map() }
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'stackable', name: 'Sacrifice at Dusk', tradeTag: null, stack: 3 })
  assert.deepEqual(r, { chaosEach: 7, chaosTotal: 21, source: 'ninja:fragment' })
})

test('fungible: all currency-overviews empty -> the exchange map (Essence) wins', async () => {
  // Essences are NOT in the currency-overview -> falls through to fromExchangeMap.
  const deps = fakeDeps()
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'stackable', name: 'Deafening Essence of Fear', tradeTag: 'deafening-essence-of-fear', stack: 1 })
  assert.deepEqual(r, { chaosEach: 44.3, chaosTotal: 44.3, source: 'exchange' })
})

test('fungible: no hit at any stage -> null (honestly unpriced, never 0)', async () => {
  const deps = fakeDeps()
  const v = createValuator({ league: L, deps })
  assert.equal(await v.value({ kind: 'stackable', name: 'Nonexistent Currency', tradeTag: null, stack: 5 }), null)
})

test('fungible: a faustus store from another league is NOT read (cross-league guard)', async () => {
  const deps = fakeDeps()
  // The store holds Hardcore prices; the valuator runs Standard -> Faustus is
  // skipped and it falls through to the exchange map (Divine 215.4).
  deps.faustusStore = fakeFaustusStore({ 'Divine Orb': 999 }, 'Hardcore')
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'stackable', name: 'Divine Orb', tradeTag: 'divine', stack: 1 })
  assert.deepEqual(r, { chaosEach: 215.4, chaosTotal: 215.4, source: 'exchange' })
})

test('invitation via item Invitation (coverage audit)', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  const r = await v.value({ kind: 'invitation', name: 'Screaming Invitation', stack: 1 })
  assert.deepEqual(r, { chaosEach: 33, chaosTotal: 33, source: 'item:Invitation' })
})

test('extensible kind system: a new valuation route via ONE entry', async () => {
  // Demonstration: a category is added in ONE place (VALUATION_ROUTES).
  VALUATION_ROUTES.sample = async (d, api) => ({ each: 5, source: 'sample' })
  try {
    const v = createValuator({ league: L, deps: fakeDeps() })
    const r = await v.value({ kind: 'sample', name: 'Widget', stack: 4 })
    assert.deepEqual(r, { chaosEach: 5, chaosTotal: 20, source: 'sample' })
  } finally {
    delete VALUATION_ROUTES.sample
  }
})

// --- Link variants on uniques ---------------------------------------------
// poe.ninja carries the same unique as a separate line per link count (base
// without `links`, plus -5l and -6l). Real case Nuro's Harp in Allflame:
//   6L 103.6c (count 7) | 5L 1.6c (count 7) | base 1c (count 399, 1025 listings)
// The first line used to win -- i.e. the 6L price for an unlinked item.
const LINKED = [
  { name: "Nuro's Harp", baseType: 'Harbinger Bow', chaosValue: 103.6, count: 7, links: 6 },
  { name: "Nuro's Harp", baseType: 'Harbinger Bow', chaosValue: 1.6, count: 7, links: 5 },
  { name: "Nuro's Harp", baseType: 'Harbinger Bow', chaosValue: 1, count: 399 }
]
const linkValuator = () => createValuator({
  league: 'L',
  deps: {
    fetchItemOverview: async () => LINKED,
    fetchCurrencyExchange: async () => ({ lines: [] }),
    fetchExchangeOverview: async () => null,
    fetchCurrencyOverview: async () => null
  }
})

test('unique: an unlinked item gets the base price, not the 6L price', async () => {
  const v = linkValuator()
  const r = await v.value({ kind: 'unique', name: "Nuro's Harp", baseType: 'Harbinger Bow', category: 'Bow', links: 0, stack: 1 })
  assert.equal(r.chaosEach, 1)
})

test('unique: a 6L gets the 6L price, a 5L the 5L price', async () => {
  const v = linkValuator()
  const six = await v.value({ kind: 'unique', name: "Nuro's Harp", baseType: 'Harbinger Bow', category: 'Bow', links: 6, stack: 1 })
  assert.equal(six.chaosEach, 103.6)
  const five = await v.value({ kind: 'unique', name: "Nuro's Harp", baseType: 'Harbinger Bow', category: 'Bow', links: 5, stack: 1 })
  assert.equal(five.chaosEach, 1.6)
})

test('unique: 4L counts as unlinked (ninja only splits out 5L and 6L)', async () => {
  const v = linkValuator()
  const r = await v.value({ kind: 'unique', name: "Nuro's Harp", baseType: 'Harbinger Bow', category: 'Bow', links: 4, stack: 1 })
  assert.equal(r.chaosEach, 1)
})

// Without mod texts (Beast/Incubator/Vial/Invitation, and every call without
// `mods`) the old tiebreak stays unchanged: the most liquid line, not the first.
test('without mods: several lines remain -> the most liquid one wins, not the first', async () => {
  const v = createValuator({
    league: 'L',
    deps: {
      fetchItemOverview: async () => [
        { name: 'X', baseType: 'B', chaosValue: 500, count: 6 },
        { name: 'X', baseType: 'B', chaosValue: 12, count: 250 }
      ],
      fetchCurrencyExchange: async () => ({ lines: [] }),
      fetchExchangeOverview: async () => null,
      fetchCurrencyOverview: async () => null
    }
  })
  const r = await v.value({ kind: 'unique', name: 'X', baseType: 'B', category: 'Bow', links: 0, stack: 1 })
  assert.equal(r.chaosEach, 12)
})

// Divine Orb is the display unit: its price MUST come from the same source as
// the C:D rate shown in the UI (poe.ninja Currency Exchange). Otherwise it read
// "1 Divine Orb = 1.2 div" -- the unit contradicted itself because Faustus (the
// in-game rate, 124.5c) won the chain.
test('Divine Orb takes the ninja exchange rate, not Faustus', async () => {
  const v = createValuator({
    league: 'L',
    deps: {
      faustusStore: { get: () => ({ updatedAt: Date.now(), prices: { 'Divine Orb': 124.5 } }) },
      fetchCurrencyExchange: async () => ({
        lines: [{ id: 'divine', primaryValue: 106 }, { id: 'chaos', primaryValue: 1 }]
      }),
      fetchExchangeOverview: async () => ({
        nameToId: new Map([['Divine Orb', 'divine'], ['Chaos Orb', 'chaos']]),
        lineById: new Map([['divine', { primaryValue: 106 }], ['chaos', { primaryValue: 1 }]])
      }),
      fetchCurrencyOverview: async () => null,
      fetchItemOverview: async () => []
    }
  })
  const r = await v.value({ kind: 'stackable', name: 'Divine Orb', tradeTag: 'divine', stack: 1 })
  assert.equal(r.chaosEach, 106, 'display unit and displayed rate must share one source')
})

// ---------------------------------------------------------------------------
// Volume floor on the poe.ninja exchange lines (MIN_EXCHANGE_UNITS = 10 OR
// MIN_EXCHANGE_TURNOVER_C = 2000, see the calibration comment above the
// constants in valuator.mjs). volumePrimaryValue/primaryValue = units traded
// (1/6 == 1 unit); volumePrimaryValue alone = chaos turnover.
// ---------------------------------------------------------------------------

function exchangeOnlyValuator (byType) {
  return createValuator({
    league: 'L',
    deps: {
      fetchCurrencyOverview: async () => ({ byName: new Map() }),
      fetchExchangeOverview: async (league, type) => byType[type] || { nameToId: new Map(), lineById: new Map() },
      fetchItemOverview: async () => [],
      fetchCurrencyExchange: async () => ({ lines: [] })
    }
  })
}

// Measured live (Allflame): 2016c at volumePrimaryValue 336 -> 0.17 -> 1 card.
// Exactly the same single trade the Faustus path already rejects.
test('single-trade outlier (The Carrion Crow) is rejected -> null instead of 0', async () => {
  const v = exchangeOnlyValuator({
    DivinationCard: {
      nameToId: new Map([['The Carrion Crow', 'the-carrion-crow']]),
      lineById: new Map([['the-carrion-crow', { id: 'the-carrion-crow', primaryValue: 2016, volumePrimaryValue: 336 }]])
    }
  })
  const r = await v.value({ kind: 'divcard', name: 'The Carrion Crow', stack: 4 })
  assert.equal(r, null, 'unpriced, neither 0 nor 2016c')
})

// The measured headline case (see valuator.mjs comment above
// MIN_EXCHANGE_UNITS): live Allflame, 2026-08-05. 1359c off volumePrimaryValue
// 906 -> 0.67 units — two thirds of a single card, and only 906 chaos of
// turnover behind the whole price, under the 2000c turnover floor too. This
// is the one CONFIRMED-bad line the turnover floor's own margin (2000) is
// measured against, so it must fail BOTH floors, not just the unit one.
test('The Trial (1359c off 0.67 units / 906 turnover) is rejected under both floors', async () => {
  const v = exchangeOnlyValuator({
    DivinationCard: {
      nameToId: new Map([['The Trial', 'the-trial']]),
      lineById: new Map([['the-trial', { id: 'the-trial', primaryValue: 1359, volumePrimaryValue: 906 }]])
    }
  })
  const r = await v.value({ kind: 'divcard', name: 'The Trial', stack: 1 })
  assert.equal(r, null, 'less than one trade, and under the turnover floor too, must never enter net worth')
})

// Second confirmed-bad anchor, live Allflame 2026-08-05: 14c off
// volumePrimaryValue 4.67 -> 0.334 units and 4.67 chaos of turnover — fails
// both floors by a wide margin, unlike The Trial which at least clears
// several hundred chaos of turnover.
test('Man With Bear (14c off 0.334 units / 4.67 turnover) is rejected under both floors', async () => {
  const v = exchangeOnlyValuator({
    DivinationCard: {
      nameToId: new Map([['Man With Bear', 'man-with-bear']]),
      lineById: new Map([['man-with-bear', { id: 'man-with-bear', primaryValue: 14, volumePrimaryValue: 4.67 }]])
    }
  })
  const r = await v.value({ kind: 'divcard', name: 'Man With Bear', stack: 1 })
  assert.equal(r, null, 'trivial units and trivial turnover must never enter net worth')
})

// Counter-check: expensive AND genuinely traded (House of Mirrors, 9404c /
// 2152043 -> 228 units, clearly above the 10-unit floor) must get through.
test('an expensive but well-traded card stays priced', async () => {
  const v = exchangeOnlyValuator({
    DivinationCard: {
      nameToId: new Map([['House of Mirrors', 'house-of-mirrors']]),
      lineById: new Map([['house-of-mirrors', { id: 'house-of-mirrors', primaryValue: 9404, volumePrimaryValue: 2152043 }]])
    }
  })
  const r = await v.value({ kind: 'divcard', name: 'House of Mirrors', stack: 1 })
  assert.equal(r.chaosEach, 9404)
  assert.equal(r.source, 'exchange:DivinationCard')
})

// Father's Love, 3708c at volumePrimaryValue 4944 -> 1.33 units. A PREVIOUS
// version of this test asserted this line was rejected under a flat 10-unit
// floor — that assertion encoded the bug this fix corrects (see THE
// REGRESSION in the valuator.mjs comment above MIN_EXCHANGE_UNITS) and has
// been rewritten, not weakened: 1.33 units genuinely fails the unit floor,
// but 4944 chaos of turnover clears the 2000c turnover floor with more than
// double the margin, and this is the real, live, most-liquid-card-in-the-
// league case the turnover floor exists to keep priced. It must stay priced.
test("Father's Love (1.33 units but 4944 turnover) keeps its price on turnover grounds", async () => {
  const v = exchangeOnlyValuator({
    DivinationCard: {
      nameToId: new Map([["Father's Love", 'fathers-love']]),
      lineById: new Map([['fathers-love', { id: 'fathers-love', primaryValue: 3708, volumePrimaryValue: 4944 }]])
    }
  })
  const r = await v.value({ kind: 'divcard', name: "Father's Love", stack: 1 })
  assert.equal(r?.chaosEach, 3708, 'a thin unit count must not blank a line with real chaos turnover behind it')
})

// Boundary of the new floor: turnover just under 2000 must still fail (no
// rescue), turnover at/above 2000 must pass, both at a unit count that fails
// MIN_EXCHANGE_UNITS on its own — isolates MIN_EXCHANGE_TURNOVER_C from the
// unit floor it ORs with.
test('turnover floor is a hard cutoff at 2000c, independent of the unit floor', async () => {
  const below = exchangeOnlyValuator({
    DivinationCard: {
      nameToId: new Map([['Thin Card', 'thin-card']]),
      // 500c off 1999.99 turnover -> 4.0 units (fails both floors, turnover just short).
      lineById: new Map([['thin-card', { id: 'thin-card', primaryValue: 500, volumePrimaryValue: 1999.99 }]])
    }
  })
  assert.equal(await below.value({ kind: 'divcard', name: 'Thin Card', stack: 1 }), null)

  const at = exchangeOnlyValuator({
    DivinationCard: {
      nameToId: new Map([['Thin Card', 'thin-card']]),
      // Same 500c line, turnover exactly at the floor -> 4.0 units still fails
      // MIN_EXCHANGE_UNITS, turnover alone must carry it.
      lineById: new Map([['thin-card', { id: 'thin-card', primaryValue: 500, volumePrimaryValue: 2000 }]])
    }
  })
  const r = await at.value({ kind: 'divcard', name: 'Thin Card', stack: 1 })
  assert.equal(r?.chaosEach, 500, 'turnover >= 2000 must price even at 4 units')
})

// The turnover floor must never vouch for a line on its own: turnover is
// units x price, so an inflated price manufactures the turnover that backs it.
// A fraction of a single trade at a high enough price clears 2000c by itself —
// MIN_EXCHANGE_TURNOVER_UNITS is what stops it.
test('turnover cannot rescue a line that is not even one completed trade', async () => {
  const v = exchangeOnlyValuator({
    DivinationCard: {
      nameToId: new Map([['Inflated Card', 'inflated-card']]),
      // 3000c off 2010 turnover -> 0.67 units: the exact unit count that made
      // The Trial (1359c/906) a rejected fake, at a price high enough that the
      // same fraction of a trade clears the turnover floor.
      lineById: new Map([['inflated-card', { id: 'inflated-card', primaryValue: 3000, volumePrimaryValue: 2010 }]])
    }
  })
  assert.equal(await v.value({ kind: 'divcard', name: 'Inflated Card', stack: 1 }), null)

  // One completed trade at the same price does clear it — the floor is about
  // "a trade actually happened", not about being expensive.
  const ok = exchangeOnlyValuator({
    DivinationCard: {
      nameToId: new Map([['Real Card', 'real-card']]),
      lineById: new Map([['real-card', { id: 'real-card', primaryValue: 3000, volumePrimaryValue: 3000 }]])
    }
  })
  assert.equal((await ok.value({ kind: 'divcard', name: 'Real Card', stack: 1 }))?.chaosEach, 3000)
})

// A line comfortably above the new floor (10 units) but nowhere near
// House of Mirrors' liquidity must still price — the floor is a hard cutoff,
// not a slope toward "more is better".
test('a line with clearly sufficient volume (well above 10 units) stays priced', async () => {
  const v = exchangeOnlyValuator({
    DivinationCard: {
      nameToId: new Map([['The Fiend', 'the-fiend']]),
      // 100c at volumePrimaryValue 2500 -> 25 units, comfortably above the floor.
      lineById: new Map([['the-fiend', { id: 'the-fiend', primaryValue: 100, volumePrimaryValue: 2500 }]])
    }
  })
  const r = await v.value({ kind: 'divcard', name: 'The Fiend', stack: 1 })
  assert.equal(r.chaosEach, 100)
})

test('missing volume field -> fail open, no crash, no 0', async () => {
  for (const vol of [undefined, null, 'lots', NaN]) {
    const v = exchangeOnlyValuator({
      DivinationCard: {
        nameToId: new Map([['The Doctor', 'the-doctor']]),
        lineById: new Map([['the-doctor', { id: 'the-doctor', primaryValue: 900, volumePrimaryValue: vol }]])
      }
    })
    const r = await v.value({ kind: 'divcard', name: 'The Doctor', stack: 1 })
    assert.equal(r?.chaosEach, 900, `volumePrimaryValue=${String(vol)}`)
  }
})

test('volume 0 -> unpriced, never 0 as a price', async () => {
  const v = exchangeOnlyValuator({
    DivinationCard: {
      nameToId: new Map([['The Doctor', 'the-doctor']]),
      lineById: new Map([['the-doctor', { id: 'the-doctor', primaryValue: 900, volumePrimaryValue: 0 }]])
    }
  })
  assert.equal(await v.value({ kind: 'divcard', name: 'The Doctor', stack: 1 }), null)
})

test('primaryValue 0 is not taken over as a price of 0', async () => {
  const v = exchangeOnlyValuator({
    DivinationCard: {
      nameToId: new Map([['The Doctor', 'the-doctor']]),
      lineById: new Map([['the-doctor', { id: 'the-doctor', primaryValue: 0, volumePrimaryValue: 500 }]])
    }
  })
  assert.equal(await v.value({ kind: 'divcard', name: 'The Doctor', stack: 1 }), null)
})

// The same source feeds the merged stackable map -> same check.
test('the volume floor applies in fromExchangeMap too', async () => {
  const thin = exchangeOnlyValuator({
    Essence: {
      nameToId: new Map([['Muttering Essence of Woe', 'muttering-essence-of-woe']]),
      lineById: new Map([['muttering-essence-of-woe', { id: 'muttering-essence-of-woe', primaryValue: 3, volumePrimaryValue: 0.5 }]])
    }
  })
  assert.equal(await thin.value({ kind: 'stackable', name: 'Muttering Essence of Woe', tradeTag: 'muttering-essence-of-woe', stack: 1 }), null)

  const liquid = exchangeOnlyValuator({
    Essence: {
      nameToId: new Map([['Deafening Essence of Doubt', 'deafening-essence-of-doubt']]),
      lineById: new Map([['deafening-essence-of-doubt', { id: 'deafening-essence-of-doubt', primaryValue: 1.3, volumePrimaryValue: 12810 }]])
    }
  })
  const r = await liquid.value({ kind: 'stackable', name: 'Deafening Essence of Doubt', tradeTag: 'deafening-essence-of-doubt', stack: 10 })
  assert.equal(r.chaosEach, 1.3)
})

// --- Unique VARIANTS -------------------------------------------------------
// Real case from Allflame: poe.ninja carries "Foulborn Soul Tether" in four
// lines, told apart only by `variant`. The user's belt has "Everlasting
// Sacrifice" (without "Instant Leech") and costs 2c on trade across 67 listings
// -- the old "most liquid wins" rule picked the 886.5c line (factor 443).
// Lines taken 1:1 from stash/current/item/overview?league=Allflame&type=UniqueAccessory.
const FOULBORN = [
  {
    name: 'Foulborn Soul Tether',
    baseType: 'Cloth Belt',
    variant: 'Instant Leech',
    implicitModifiers: [{ text: '(15-25)% increased Stun and Block Recovery', optional: false }],
    explicitModifiers: [
      { text: '+(20-43) to Intelligence', optional: false },
      { text: 'Immortal Ambition', optional: false }
    ],
    mutatedModifiers: [{ text: '(8-12)% of Leech is Instant', optional: false }],
    chaosValue: 886.5,
    divineValue: 5,
    count: 125,
    listingCount: 125
  },
  {
    name: 'Foulborn Soul Tether',
    baseType: 'Cloth Belt',
    variant: 'Instant Leech, Everlasting Sacrifice',
    implicitModifiers: [{ text: '(15-25)% increased Stun and Block Recovery', optional: false }],
    explicitModifiers: [{ text: '+(20-40) to Intelligence', optional: false }],
    mutatedModifiers: [
      { text: '(8-12)% of Leech is Instant', optional: false },
      { text: 'Everlasting Sacrifice', optional: false }
    ],
    chaosValue: 709.2,
    divineValue: 4,
    count: 19,
    listingCount: 19
  },
  {
    name: 'Foulborn Soul Tether',
    baseType: 'Cloth Belt',
    variant: 'Everlasting Sacrifice',
    implicitModifiers: [{ text: '(15-25)% increased Stun and Block Recovery', optional: false }],
    explicitModifiers: [
      { text: '+(20-40) to Intelligence', optional: false },
      { text: 'Gain (4-6)% of Maximum Life as Extra Maximum Energy Shield', optional: false }
    ],
    mutatedModifiers: [{ text: 'Everlasting Sacrifice', optional: false }],
    chaosValue: 2,
    divineValue: 0.01,
    count: 92,
    listingCount: 92
  },
  {
    name: 'Soul Tether',
    baseType: 'Cloth Belt',
    implicitModifiers: [{ text: '(15-25)% increased Stun and Block Recovery', optional: false }],
    explicitModifiers: [
      { text: '+(20-40) to Intelligence', optional: false },
      { text: 'Gain (4-6)% of Maximum Life as Extra Maximum Energy Shield', optional: false },
      { text: 'Immortal Ambition', optional: false }
    ],
    chaosValue: 1,
    divineValue: 0.01,
    count: 399,
    listingCount: 1119
  }
]

const overviewValuator = lines => createValuator({
  league: 'L',
  deps: {
    fetchItemOverview: async () => lines,
    fetchCurrencyExchange: async () => ({ lines: [] }),
    fetchExchangeOverview: async () => null,
    fetchCurrencyOverview: async () => null
  }
})

// The mods exactly as the GGG stash JSON delivers them (concrete rolls).
const FOULBORN_ITEM_MODS = [
  '16% increased Stun and Block Recovery',
  'Gain 5% of Maximum Life as Extra Maximum Energy Shield',
  '+26 to Intelligence',
  'Everlasting Sacrifice'
]

test('unique variant: Foulborn Soul Tether hits the 2c line, not the 886c line', async () => {
  const v = overviewValuator(FOULBORN)
  const r = await v.value({
    kind: 'unique',
    name: 'Foulborn Soul Tether',
    baseType: 'Cloth Belt',
    category: 'Belt',
    links: 0,
    stack: 1,
    mods: FOULBORN_ITEM_MODS
  })
  assert.equal(r.chaosEach, 2)
})

test('unique variant: the same base with "Instant Leech" hits the expensive line', async () => {
  const v = overviewValuator(FOULBORN)
  const r = await v.value({
    kind: 'unique',
    name: 'Foulborn Soul Tether',
    baseType: 'Cloth Belt',
    category: 'Belt',
    links: 0,
    stack: 1,
    mods: [
      '20% increased Stun and Block Recovery',
      '+31 to Intelligence',
      'Immortal Ambition',
      '10% of Leech is Instant'
    ]
  })
  assert.equal(r.chaosEach, 886.5)
})

test('unique without variants: valued unchanged, with or without mods', async () => {
  const SINGLE = [{
    name: 'Abyssus',
    baseType: 'Ezomyte Burgonet',
    chaosValue: 42.7,
    count: 60,
    listingCount: 120,
    explicitModifiers: [{ text: '+(50-80) to maximum Life', optional: false }]
  }]
  const desc = { kind: 'unique', name: 'Abyssus', baseType: 'Ezomyte Burgonet', category: 'Helmet', links: 0, stack: 1 }
  const withoutMods = await overviewValuator(SINGLE).value(desc)
  const withMods = await overviewValuator(SINGLE).value({ ...desc, mods: ['+64 to maximum Life'] })
  // Even mods that match NO line must not tip over the normal case.
  const withAlienMods = await overviewValuator(SINGLE).value({ ...desc, mods: ['Allocates Whatever'] })
  assert.equal(withoutMods.chaosEach, 42.7)
  assert.deepEqual(withMods, withoutMods)
  assert.deepEqual(withAlienMods, withoutMods)
})

test('unique variant: ambiguous -> cheapest candidate line, never the most expensive', async () => {
  // Real case Voices: poe.ninja carries four lines, NONE with mod text -- not
  // distinguishable from item data. The result must be the conservative floor.
  const VOICES = [
    { name: 'Voices', baseType: 'Large Cluster Jewel', chaosValue: 68103, count: 16, listingCount: 16 },
    { name: 'Voices', baseType: 'Large Cluster Jewel', variant: '3 passives', chaosValue: 12766, count: 37, listingCount: 37 },
    { name: 'Voices', baseType: 'Large Cluster Jewel', variant: '5 passives', chaosValue: 150, count: 299, listingCount: 299 },
    { name: 'Voices', baseType: 'Large Cluster Jewel', variant: '7 passives', chaosValue: 1, count: 383, listingCount: 383 }
  ]
  const v = overviewValuator(VOICES)
  const r = await v.value({
    kind: 'unique',
    name: 'Voices',
    baseType: 'Large Cluster Jewel',
    category: 'Jewel',
    links: 0,
    stack: 1,
    mods: ['Adds 5 Small Passive Skills which grant nothing']
  })
  assert.equal(r.chaosEach, 1)
})

test('unique variant: an empty mod list does not guess -> cheapest line, not the most expensive', async () => {
  const v = overviewValuator(FOULBORN)
  const r = await v.value({
    kind: 'unique',
    name: 'Foulborn Soul Tether',
    baseType: 'Cloth Belt',
    category: 'Belt',
    links: 0,
    stack: 1,
    mods: []
  })
  assert.equal(r.chaosEach, 2)
})

test('unique variant: missing variant/mod fields do not throw', async () => {
  const BROKEN = [
    { name: 'Y', baseType: 'B', chaosValue: 500, count: 20 },
    { name: 'Y', baseType: 'B', chaosValue: 900, count: 20, implicitModifiers: null, explicitModifiers: [{ text: null }, null] },
    { name: 'Y', baseType: 'B', chaosValue: 7, count: 20, explicitModifiers: [{ text: 'Adds (1-3) to (5-7) Physical Damage' }] }
  ]
  const v = overviewValuator(BROKEN)
  const r = await v.value({ kind: 'unique', name: 'Y', baseType: 'B', category: 'Bow', links: 0, stack: 1, mods: ['Adds 2 to 6 Physical Damage'] })
  assert.equal(r.chaosEach, 7, 'broken mod entries must neither throw nor win')
})
