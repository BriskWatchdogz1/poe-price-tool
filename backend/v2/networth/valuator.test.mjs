import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createValuator } from './valuator.mjs'
import { VALUATION_ROUTES } from './kinds.mjs'
import { loadItemsIndex, normalizeItem } from './normalize.mjs'

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
      // Shape as verified live: the baseType is "Map (Tier N)" — which is ALSO
      // how GGG spells a unique map's base line on the item (production: the
      // unpriced list read "Unidentified Map (Tier 16)"). So for a unique map
      // the tiebreak is not a no-op: it is the map tier.
      if (type === 'UniqueMap') {
        return [
          { name: 'Maelström of Chaos', baseType: 'Map (Tier 8)', chaosValue: 1, listingCount: 30, count: 20 },
          { name: "Doryani's Machinarium", baseType: 'Map (Tier 14)', chaosValue: 252.8, listingCount: 40, count: 25 },
          // The same unique map at two tiers. The CHEAPER line is deliberately
          // the LESS liquid one: without the tier the liquidest-line tiebreak
          // would answer "Tier 16" for a Tier 15 item, i.e. 10x too much.
          { name: 'Cortex', baseType: 'Map (Tier 15)', chaosValue: 30, listingCount: 25, count: 10 },
          { name: 'Cortex', baseType: 'Map (Tier 16)', chaosValue: 300, listingCount: 60, count: 40 }
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
  assert.deepEqual(r, { chaosEach: 215.4, chaosTotal: 646.2, each: 215.4, source: 'exchange', uncertain: 'thin-market' })
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
  assert.deepEqual(r, { chaosEach: 1, chaosTotal: 273, each: 1, source: 'chaos', uncertain: null })
  assert.equal(deps.calls.length, 0) // no fetch needed
})

test('exchange map is built once per TTL (14 requests, then cached until exchangeMapTtlMs)', async () => {
  const deps = fakeDeps()
  let t = 1_000_000
  deps.now = () => t
  deps.exchangeMapTtlMs = 3600000
  const v = createValuator({ league: L, deps })
  const exchangeCalls = () => deps.calls.filter(c => c[0] === 'exchange').length
  await v.value({ kind: 'stackable', name: 'Divine Orb', tradeTag: 'divine', stack: 1 })
  await v.value({ kind: 'stackable', name: 'Titanic Scarab', tradeTag: 'titanic-scarab', stack: 1 })
  assert.equal(exchangeCalls(), 14) // the 14 stackable exchange types, exactly once
  t += 3600001
  await v.value({ kind: 'stackable', name: 'Divine Orb', tradeTag: 'divine', stack: 1 })
  assert.equal(exchangeCalls(), 28, 'past the TTL the map is read again (B29: it used to live as long as the process)')
})

test('an empty exchange map is not kept: the next valuation builds it again', async () => {
  const deps = fakeDeps()
  const inner = deps.fetchExchangeOverview
  let open = false
  // A league that has no trade yet: every type answers empty until it opens.
  deps.fetchExchangeOverview = async (league, type) =>
    (open ? inner(league, type) : { nameToId: new Map(), lineById: new Map() })
  const v = createValuator({ league: L, deps })
  assert.equal(await v.value({ kind: 'stackable', name: 'Divine Orb', tradeTag: 'divine', stack: 1 }), null)
  open = true
  const r = await v.value({ kind: 'stackable', name: 'Divine Orb', tradeTag: 'divine', stack: 1 })
  assert.equal(r.chaosEach, 215.4)
})

test('a map with a type that did not load (null) is rebuilt on the next call', async () => {
  const deps = fakeDeps()
  const inner = deps.fetchExchangeOverview
  let scarabFailed = false
  deps.fetchExchangeOverview = async (league, type) => {
    if (type === 'Scarab' && !scarabFailed) { scarabFailed = true; deps.calls.push(['exchange', league, type]); return null }
    return inner(league, type)
  }
  const v = createValuator({ league: L, deps })
  assert.equal(await v.value({ kind: 'stackable', name: 'Titanic Scarab', tradeTag: 'titanic-scarab', stack: 1 }), null)
  const r = await v.value({ kind: 'stackable', name: 'Titanic Scarab', tradeTag: 'titanic-scarab', stack: 1 })
  assert.ok(deps.calls.filter(c => c[0] === 'exchange').length > 14)
  assert.equal(r.chaosEach, 2.5)
})

test('concurrent valuations share one build', async () => {
  const deps = fakeDeps()
  const v = createValuator({ league: L, deps })
  await Promise.all(Array.from({ length: 5 }, () =>
    v.value({ kind: 'stackable', name: 'Divine Orb', tradeTag: 'divine', stack: 1 })))
  assert.equal(deps.calls.filter(c => c[0] === 'exchange').length, 14)
})

test('divcard via Exchange DivinationCard', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  const r = await v.value({ kind: 'divcard', name: 'The Doctor', stack: 2 })
  assert.deepEqual(r, { chaosEach: 900, chaosTotal: 1800, each: 900, source: 'exchange:DivinationCard', uncertain: 'thin-market' })
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
  assert.deepEqual(r, { chaosEach: 1234, chaosTotal: 2468, each: 1234, source: 'faustus', uncertain: null })
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
  assert.deepEqual(r, { chaosEach: 1234, chaosTotal: 2468, each: 1234, source: 'faustus', uncertain: null })
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
  assert.deepEqual(r, { chaosEach: 42.7, chaosTotal: 42.7, each: 42.7, source: 'item:UniqueArmour', uncertain: null })
})

test('unique without a category (base not in items.ndjson) -> null', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  assert.equal(await v.value({ kind: 'unique', name: 'X', baseType: 'Y', category: null, stack: 1 }), null)
})

test('unique map: category Map -> UniqueMap overview, the baseType tiebreak does no harm', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  const r = await v.value({ kind: 'unique', name: 'Maelström of Chaos', baseType: 'Torture Chamber Map', category: 'Map', links: 0, stack: 1 })
  assert.deepEqual(r, { chaosEach: 1, chaosTotal: 1, each: 1, source: 'item:UniqueMap', uncertain: null })
})

test('unique map: the map tier in the base line picks the tier\'s line, not the liquidest', async () => {
  // docs/pricing-logic.md claims unique maps are priced "with the map tier
  // taken into account". This is that claim, as a test.
  const v = createValuator({ league: L, deps: fakeDeps() })
  const t15 = await v.value({ kind: 'unique', name: 'Cortex', baseType: 'Map (Tier 15)', category: 'Map', links: 0, mods: [], stack: 1 })
  assert.deepEqual(t15, { chaosEach: 30, chaosTotal: 30, each: 30, source: 'item:UniqueMap', uncertain: null })
  const t16 = await v.value({ kind: 'unique', name: 'Cortex', baseType: 'Map (Tier 16)', category: 'Map', links: 0, mods: [], stack: 1 })
  assert.deepEqual(t16, { chaosEach: 300, chaosTotal: 300, each: 300, source: 'item:UniqueMap', uncertain: null })
})

// docs/pricing-logic.md ("Deliberately not marked") says what happens when the
// map tier (or base) matches NO line: with one line left the price stays
// unmarked, with several the variant rule marks it. Both halves, as a test.
test('unique map: a tier without a line of its own is a guess when several lines remain, unmarked when one does', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  // Cortex has T15 and T16 lines, no T14: nothing on the item decides.
  for (const mods of [[], null]) {
    const t14 = await v.value({ kind: 'unique', name: 'Cortex', baseType: 'Map (Tier 14)', category: 'Map', links: 0, mods, stack: 1 })
    assert.equal(t14.uncertain, 'variant-guessed', `mods ${JSON.stringify(mods)}: two tiers, neither is the item's`)
  }
  // Maelström of Chaos has a single (T8) line: it is taken, unmarked.
  const one = await v.value({ kind: 'unique', name: 'Maelström of Chaos', baseType: 'Map (Tier 3)', category: 'Map', links: 0, mods: [], stack: 1 })
  assert.deepEqual(one, { chaosEach: 1, chaosTotal: 1, each: 1, source: 'item:UniqueMap', uncertain: null })
})

test('map stash end to end: raw GGG item -> normalize -> priced (not unpriced)', async () => {
  // The gap the green unit tests above could NOT see: they hand the valuator a
  // descriptor that already says `category: 'Map'`. This one starts where
  // production starts — at the stash JSON — and uses the REAL items.ndjson
  // index, so it fails if classification never reaches the UniqueMap route.
  const index = await loadItemsIndex()
  const ggg = {
    frameType: 3,
    name: '<<set:MS>><<set:M>><<set:S>>Cortex',
    typeLine: 'Map (Tier 15)',
    ilvl: 83,
    explicitMods: ['Area is inhabited by the Synthesis Boss']
  }
  const desc = normalizeItem(ggg, index)
  assert.equal(desc.kind, 'unique')
  assert.equal(desc.category, 'Map')
  const v = createValuator({ league: L, deps: fakeDeps() })
  const r = await v.value(desc)
  assert.deepEqual(r, { chaosEach: 30, chaosTotal: 30, each: 30, source: 'item:UniqueMap', uncertain: null })
})

test('map stash end to end: an UNIDENTIFIED unique map stays unpriced (never guessed)', async () => {
  // 41 of the 48 items in the report were unidentified. Which unique a map is
  // cannot be known before identification, so it must stay honestly unpriced —
  // the category fix must not turn these into a price.
  const index = await loadItemsIndex()
  const deps = fakeDeps()
  const desc = normalizeItem({ frameType: 3, name: '', typeLine: 'Map (Tier 16)', ilvl: 84 }, index)
  assert.equal(desc.unidentified, true)
  assert.equal(desc.category, 'Map')
  assert.equal(await createValuator({ league: L, deps }).value(desc), null)
  assert.deepEqual(deps.calls.filter(c => c[0] === 'item'), []) // and no lookup fired
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
  assert.deepEqual(r, { chaosEach: 16758, chaosTotal: 16758, each: 16758, source: 'item:SkillGem', uncertain: null })
})

test('gem: no exact variant -> next best, same corrupted status preferred', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  // Level 5, uncorrupted: no exact hit. Level 4c is closer in level but is
  // penalised heavily for the corrupted mismatch -> level 3 uncorrupted (2394) wins.
  const r = await v.value({ kind: 'gem', name: 'Enlighten Support', level: 5, quality: 0, corrupted: false, stack: 1 })
  assert.equal(r.chaosEach, 2394)
  assert.equal(r.uncertain, 'gem-guessed', 'a level 3 price for a level 5 gem is a guess and says so')
})

test('gem: the exact variant exists only as a low-count phantom -> dropped, not 369k (Bear Trap case)', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  // A plain level-20/q0/uncorrupted Bear Trap. The exactly matching line is the
  // 369553 phantom line (count 3) -> must be thrown out. No other exact hit ->
  // the next best confident line (20/20, 16.7) wins. Never 369553.
  const r = await v.value({ kind: 'gem', name: 'Bear Trap', level: 20, quality: 0, corrupted: false, stack: 1 })
  assert.equal(r.chaosEach, 16.7)
  assert.equal(r.uncertain, 'gem-guessed')
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
  assert.deepEqual(r, { chaosEach: 77, chaosTotal: 77, each: 77, source: 'item:Beast', uncertain: null })
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
  assert.deepEqual(r, { chaosEach: 0, chaosTotal: 0, each: 0, source: 'corpse:imperfect', uncertain: null })
  assert.equal(touched, false)
})

test('corpse: a fresh store hit wins (each = getPrice, * stack)', async () => {
  const deps = fakeDeps()
  deps.corpseStore = { getPrice: name => (name === 'Forest Tiger' ? 12 : null), league: () => L }
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'corpse', name: 'Forest Tiger', tradeTag: null, stack: 4 })
  assert.deepEqual(r, { chaosEach: 12, chaosTotal: 48, each: 12, source: 'corpse:trade', uncertain: null })
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
  assert.deepEqual(r, { chaosEach: 200, chaosTotal: 400, each: 200, source: 'faustus', uncertain: null })
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
  assert.deepEqual(r, { chaosEach: 205, chaosTotal: 205, each: 205, source: 'ninja:currency', uncertain: null })
})

test('fungible: miss in Currency -> the Fragment currency-overview wins', async () => {
  const deps = fakeDeps()
  deps.fetchCurrencyOverview = async (league, type) =>
    type === 'Fragment' ? { byName: new Map([['Sacrifice at Dusk', 7]]) } : { byName: new Map() }
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'stackable', name: 'Sacrifice at Dusk', tradeTag: null, stack: 3 })
  assert.deepEqual(r, { chaosEach: 7, chaosTotal: 21, each: 7, source: 'ninja:fragment', uncertain: null })
})

test('fungible: all currency-overviews empty -> the exchange map (Essence) wins', async () => {
  // Essences are NOT in the currency-overview -> falls through to fromExchangeMap.
  const deps = fakeDeps()
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'stackable', name: 'Deafening Essence of Fear', tradeTag: 'deafening-essence-of-fear', stack: 1 })
  assert.deepEqual(r, { chaosEach: 44.3, chaosTotal: 44.3, each: 44.34, source: 'exchange', uncertain: 'thin-market' })
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
  assert.deepEqual(r, { chaosEach: 215.4, chaosTotal: 215.4, each: 215.4, source: 'exchange', uncertain: 'thin-market' })
})

test('invitation via item Invitation (coverage audit)', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  const r = await v.value({ kind: 'invitation', name: 'Screaming Invitation', stack: 1 })
  assert.deepEqual(r, { chaosEach: 33, chaosTotal: 33, each: 33, source: 'item:Invitation', uncertain: null })
})

test('extensible kind system: a new valuation route via ONE entry', async () => {
  // Demonstration: a category is added in ONE place (VALUATION_ROUTES).
  VALUATION_ROUTES.sample = async (d, api) => ({ each: 5, source: 'sample' })
  try {
    const v = createValuator({ league: L, deps: fakeDeps() })
    const r = await v.value({ kind: 'sample', name: 'Widget', stack: 4 })
    assert.deepEqual(r, { chaosEach: 5, chaosTotal: 20, each: 5, source: 'sample', uncertain: null })
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
  assert.equal(r.uncertain, null, 'the base line IS the line for an unlinked item')
})

test('unique: a 6L gets the 6L price, a 5L the 5L price', async () => {
  const v = linkValuator()
  const six = await v.value({ kind: 'unique', name: "Nuro's Harp", baseType: 'Harbinger Bow', category: 'Bow', links: 6, stack: 1 })
  assert.equal(six.chaosEach, 103.6)
  assert.equal(six.uncertain, null)
  const five = await v.value({ kind: 'unique', name: "Nuro's Harp", baseType: 'Harbinger Bow', category: 'Bow', links: 5, stack: 1 })
  assert.equal(five.chaosEach, 1.6)
  assert.equal(five.uncertain, null)
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
  assert.equal(r.uncertain, 'variant-guessed', 'two lines and nothing to choose by: the most traded one is still a guess')
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

// B36: the unit count is a division, and 200.1 / 20.01 is 9.999999999999998
// in floating point, although those numbers state exactly 10 units. A count
// that misses the floor only by that arithmetic error reaches it. A count the
// numbers themselves put under the floor (9.99 units: 199.9 / 20.01) stays
// under it: no tolerance for the rounding of poe.ninja's numbers.
test('exactly 10 units by the stated numbers are a price, though the division gives 9.999999999999998', async () => {
  assert.ok(200.1 / 20.01 < 10) // the arithmetic error this test is about
  const v = exchangeOnlyValuator({
    Fossil: {
      nameToId: new Map([['Ten Fossil', 'ten-fossil'], ['Under Fossil', 'under-fossil']]),
      lineById: new Map([
        ['ten-fossil', { id: 'ten-fossil', primaryValue: 20.01, volumePrimaryValue: 200.1 }],
        ['under-fossil', { id: 'under-fossil', primaryValue: 20.01, volumePrimaryValue: 199.9 }]
      ])
    }
  })
  const stack = name => v.value({ kind: 'stackable', name, tradeTag: null, stack: 1 })
  assert.equal((await stack('Ten Fossil'))?.each, 20.01) // chaosEach is rounded to 20
  assert.equal(await stack('Under Fossil'), null, '9.99 units and 199.9c of turnover clear neither floor')
})

// The slack absorbs arithmetic error and nothing larger. A count a
// hundred-millionth of the floor short by the stated numbers (99.999999 / 10
// = 9.9999999 units, 1e-8 of the floor) is a real miss, not a division
// artefact, and stays rejected. This pins FLOAT_SLACK in sell-side.mjs under
// 1e-8: any slack at or above it lets the line through. The turnover (about
// 100c) is far below the rescue, so only the unit floor decides.
test('a count a hundred-millionth of the floor short by the stated numbers stays rejected', async () => {
  assert.ok(10 - 99.999999 / 10 > 9e-8) // the miss is real, many orders above float error
  const v = exchangeOnlyValuator({
    Fossil: {
      nameToId: new Map([['Near Fossil', 'near-fossil']]),
      lineById: new Map([['near-fossil', { id: 'near-fossil', primaryValue: 10, volumePrimaryValue: 99.999999 }]])
    }
  })
  assert.equal(await v.value({ kind: 'stackable', name: 'Near Fossil', tradeTag: null, stack: 1 }), null)
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
    // Fail-open stays, but it is named: nothing vouches for this line.
    assert.equal(r?.uncertain, 'thin-market', `volumePrimaryValue=${String(vol)}`)
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
  assert.equal(r.uncertain, null, 'the mods decided the line: no guess')
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
  assert.equal(withoutMods.uncertain, null)
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
  assert.equal(r.uncertain, 'variant-guessed', 'the cheapest line is a floor, not a match')
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
  assert.equal(r.uncertain, 'variant-guessed')
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

// ---------------------------------------------------------------------------
// The PER-ITEM age gate — a different question from the map-wide TTL above.
//
// The TTL asks "is the refresher still running". This asks "is THIS number
// still describing the market". A tick five minutes old can hand out an
// eight-hour-old observation for a quiet market, and that is what put 206.6c on
// a card the in-game exchange was selling at 147c (networth/faustus-age.mjs).
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000
/** A store whose one price was observed in the hour that CLOSED `h` hours ago. */
function agedFaustusStore (name, chaos, hoursOld, now) {
  const at = Math.floor((now - (hoursOld + 1) * HOUR_MS) / 1000)
  return { ...fakeFaustusStore({ [name]: chaos }), getHour: n => (n === name ? at : null) }
}

test('an observation older than the gate is not served -> the chain falls through to poe.ninja', async () => {
  const now = 1_760_000_000_000
  const deps = fakeDeps()
  deps.now = () => now
  deps.faustusMaxAgeMs = 6 * HOUR_MS
  deps.faustusStore = agedFaustusStore('The Doctor', 1234, 7, now)
  const r = await createValuator({ league: L, deps }).value({ kind: 'divcard', name: 'The Doctor', stack: 2 })
  assert.equal(r.source, 'exchange:DivinationCard', 'the aged Faustus price must not win')
  assert.equal(r.chaosEach, 900, 'the poe.ninja card line takes over — the fallback the chain already had')
})

test('an observation inside the gate wins exactly as before', async () => {
  const now = 1_760_000_000_000
  const deps = fakeDeps()
  deps.now = () => now
  deps.faustusMaxAgeMs = 6 * HOUR_MS
  deps.faustusStore = agedFaustusStore('The Doctor', 1234, 5, now)
  const r = await createValuator({ league: L, deps }).value({ kind: 'divcard', name: 'The Doctor', stack: 2 })
  assert.deepEqual(r, { chaosEach: 1234, chaosTotal: 2468, each: 1234, source: 'faustus', uncertain: null })
})

test('an UNKNOWN observation hour is not "old" — an older store keeps working after a deploy', async () => {
  // Stores written before `hours` existed hold none. Reading that as stale
  // would blank every Faustus price on the deploy that shipped the gate, which
  // is a far bigger change than the gate itself; they age in on the next tick.
  const now = 1_760_000_000_000
  const deps = fakeDeps()
  deps.now = () => now
  deps.faustusMaxAgeMs = 6 * HOUR_MS
  deps.faustusStore = fakeFaustusStore({ 'The Doctor': 1234 }) // no getHour at all
  const r = await createValuator({ league: L, deps }).value({ kind: 'divcard', name: 'The Doctor', stack: 2 })
  assert.deepEqual(r, { chaosEach: 1234, chaosTotal: 2468, each: 1234, source: 'faustus', uncertain: null })

  const withHours = { ...fakeFaustusStore({ 'The Doctor': 1234 }), getHour: () => null }
  deps.faustusStore = withHours
  const r2 = await createValuator({ league: L, deps }).value({ kind: 'divcard', name: 'The Doctor', stack: 2 })
  assert.deepEqual(r2, { chaosEach: 1234, chaosTotal: 2468, each: 1234, source: 'faustus', uncertain: null })
})

test('the gate applies to stackables too — it is not a divination-card rule', async () => {
  // Same source, same semantics, same estimator: currency, fragments, essences,
  // scarabs and the rest all come out of the identical Faustus map, so an aged
  // observation is aged for every one of them.
  const now = 1_760_000_000_000
  const deps = fakeDeps()
  deps.now = () => now
  deps.faustusMaxAgeMs = 6 * HOUR_MS
  deps.faustusStore = agedFaustusStore('Deafening Essence of Fear', 999, 9, now)
  const r = await createValuator({ league: L, deps })
    .value({ kind: 'stackable', name: 'Deafening Essence of Fear', tradeTag: 'deafening-essence-of-fear', stack: 1 })
  assert.equal(r.source, 'exchange')
  assert.equal(r.chaosEach, 44.3, 'the poe.ninja exchange line, not the aged 999')
})

test('an aged observation with NO fallback is honestly unpriced, never the aged number', async () => {
  const now = 1_760_000_000_000
  const deps = fakeDeps()
  deps.now = () => now
  deps.faustusMaxAgeMs = 6 * HOUR_MS
  const inner = deps.fetchExchangeOverview
  deps.fetchExchangeOverview = async (league, type) =>
    type === 'DivinationCard' ? { nameToId: new Map(), lineById: new Map() } : inner(league, type)
  deps.faustusStore = agedFaustusStore('The Doctor', 1234, 9, now)
  const r = await createValuator({ league: L, deps }).value({ kind: 'divcard', name: 'The Doctor', stack: 2 })
  assert.equal(r, null)
})

// ---------------------------------------------------------------------------
// B20 — the SECOND path the four measurements of 2026-08-13 could have come
// out of. Imperial Legacy (tool ~4.6c, in-game 14 cards per chaos) and The
// Fathomless Depths (tool 15c, in-game 2 cards per chaos) are divination
// cards, so their price is either Faustus (see faustus.test.mjs, same marker)
// or this fallback — and the measurement does not say which, because the
// Net-Worth page did not name the source at the time it was taken.
//
// What these two pin is that the fallback's floors do not separate the cases
// either: a piece count is trivially cleared by a CHEAP item, which is the
// same blind spot the unit count has in faustus.mjs, seen from the other side
// of the chain. Both are RECONSTRUCTIONS at the floor, not observed lines.
// ---------------------------------------------------------------------------
test('B20: a cheap card clears the poe.ninja unit floor on 55 chaos of turnover', async () => {
  // 4.6c at volumePrimaryValue 55 -> 11.96 units, over MIN_EXCHANGE_UNITS.
  // 55 chaos is a quarter of a divine, and it prices a card whose in-game sell
  // side is 1 chaos for fourteen.
  const v = exchangeOnlyValuator({
    DivinationCard: {
      nameToId: new Map([['Imperial Legacy', 'imperial-legacy']]),
      lineById: new Map([['imperial-legacy', { id: 'imperial-legacy', primaryValue: 4.6, volumePrimaryValue: 55 }]])
    }
  })
  const r = await v.value({ kind: 'divcard', name: 'Imperial Legacy', stack: 14 })
  assert.equal(r?.chaosEach, 4.6, 'the piece floor cannot see how little a cheap item is worth')
  assert.equal(r?.chaosTotal, 64.4, 'the 14 pieces the report showed as 64c')
  assert.equal(r?.uncertain, 'thin-market', 'the price stays, and the table says how little stands behind it')
})

test('B20: 150 chaos of turnover is enough for a 15c line, and says nothing about a bid', async () => {
  const v = exchangeOnlyValuator({
    DivinationCard: {
      nameToId: new Map([['The Fathomless Depths', 'the-fathomless-depths']]),
      lineById: new Map([['the-fathomless-depths', { id: 'the-fathomless-depths', primaryValue: 15, volumePrimaryValue: 150 }]])
    }
  })
  const r = await v.value({ kind: 'divcard', name: 'The Fathomless Depths', stack: 2 })
  assert.equal(r?.chaosEach, 15)
  assert.equal(r?.chaosTotal, 30, 'the 2 pieces the report showed as 30c')
  assert.equal(r?.uncertain, 'thin-market')
})

// ---------------------------------------------------------------------------
// The uncertainty marker (docs/pricing-logic.md, "Uncertain prices"). Every
// priced row says whether the valuation KNOWS its number to be a guess or
// thinly evidenced. It never changes a price: each test pins the number too.
// ---------------------------------------------------------------------------
function turnoverFaustusStore (prices, turnover) {
  const s = fakeFaustusStore(prices)
  s.getTurnover = name => (name in turnover ? turnover[name] : null)
  return s
}

test('B20 marker: a Faustus price whose hour moved less than the thin-market bar is uncertain', async () => {
  const deps = fakeDeps()
  deps.faustusStore = turnoverFaustusStore({ 'Imperial Legacy': 4.6 }, { 'Imperial Legacy': 55 })
  const r = await createValuator({ league: L, deps }).value({ kind: 'divcard', name: 'Imperial Legacy', stack: 14 })
  assert.deepEqual(r, { chaosEach: 4.6, chaosTotal: 64.4, each: 4.6, source: 'faustus', uncertain: 'thin-market' })
})

test('a Faustus price backed by enough turnover carries no doubt', async () => {
  const deps = fakeDeps()
  deps.faustusStore = turnoverFaustusStore({ 'Imperial Legacy': 4.6 }, { 'Imperial Legacy': 12000 })
  const r = await createValuator({ league: L, deps }).value({ kind: 'divcard', name: 'Imperial Legacy', stack: 14 })
  assert.equal(r.uncertain, null)
  assert.equal(r.chaosEach, 4.6)
})

test('the thin-market bar is the sell-side bar: 4999 chaos is thin, 5000 is not', async () => {
  for (const [turnover, want] of [[4999, 'thin-market'], [5000, null]]) {
    const deps = fakeDeps()
    deps.faustusStore = turnoverFaustusStore({ 'Orb of Fusing': 0.5 }, { 'Orb of Fusing': turnover })
    const r = await createValuator({ league: L, deps }).value({ kind: 'stackable', name: 'Orb of Fusing', tradeTag: 'fusing', stack: 1 })
    assert.equal(r.uncertain, want, `turnover ${turnover}`)
  }
})

test('a Faustus store written before turnover existed marks nothing', async () => {
  // No getTurnover at all (older store / stub) ...
  const a = fakeDeps()
  a.faustusStore = fakeFaustusStore({ 'Imperial Legacy': 4.6 })
  const ra = await createValuator({ league: L, deps: a }).value({ kind: 'divcard', name: 'Imperial Legacy', stack: 1 })
  assert.equal(ra.uncertain, null)
  // ... and a store that has it but knows nothing for this name.
  const b = fakeDeps()
  b.faustusStore = turnoverFaustusStore({ 'Imperial Legacy': 4.6 }, {})
  const rb = await createValuator({ league: L, deps: b }).value({ kind: 'divcard', name: 'Imperial Legacy', stack: 1 })
  assert.equal(rb.uncertain, null, 'unknown is not thin on the Faustus path')
  assert.equal(rb.chaosEach, 4.6)
})

test('a poe.ninja exchange line without a volume field is priced and marked thin-market', async () => {
  const deps = fakeDeps()
  const r = await createValuator({ league: L, deps }).value({ kind: 'stackable', name: 'Deafening Essence of Fear', tradeTag: 'deafening-essence-of-fear', stack: 1 })
  assert.equal(r.chaosEach, 44.3)
  assert.equal(r.uncertain, 'thin-market')
})

test('a poe.ninja exchange line with enough turnover carries no doubt, in the merged map and on the card path', async () => {
  const v = exchangeOnlyValuator({
    Essence: {
      nameToId: new Map([['Deafening Essence of Fear', 'deafening-essence-of-fear']]),
      lineById: new Map([['deafening-essence-of-fear', { id: 'deafening-essence-of-fear', primaryValue: 44.34, volumePrimaryValue: 9000 }]])
    },
    DivinationCard: {
      nameToId: new Map([['The Doctor', 'the-doctor']]),
      lineById: new Map([['the-doctor', { id: 'the-doctor', primaryValue: 900, volumePrimaryValue: 90000 }]])
    }
  })
  const e = await v.value({ kind: 'stackable', name: 'Deafening Essence of Fear', tradeTag: 'deafening-essence-of-fear', stack: 1 })
  assert.equal(e.uncertain, null)
  const c = await v.value({ kind: 'divcard', name: 'The Doctor', stack: 1 })
  assert.equal(c.uncertain, null)
})

test('a thin-market bar of 0 marks nothing', async () => {
  const deps = fakeDeps()
  deps.thinTurnoverC = 0
  deps.faustusStore = turnoverFaustusStore({ 'Imperial Legacy': 4.6 }, { 'Imperial Legacy': 55 })
  const v = createValuator({ league: L, deps })
  const r = await v.value({ kind: 'divcard', name: 'Imperial Legacy', stack: 14 })
  assert.deepEqual(r, { chaosEach: 4.6, chaosTotal: 64.4, each: 4.6, source: 'faustus', uncertain: null })
  // Not even a poe.ninja line without a volume field.
  const e = await v.value({ kind: 'stackable', name: 'Deafening Essence of Fear', tradeTag: 'deafening-essence-of-fear', stack: 1 })
  assert.equal(e.uncertain, null)
})

test('a higher thin-market bar marks more, at the same price', async () => {
  const deps = fakeDeps()
  deps.thinTurnoverC = 20000
  deps.faustusStore = turnoverFaustusStore({ 'Imperial Legacy': 4.6 }, { 'Imperial Legacy': 12000 })
  const r = await createValuator({ league: L, deps }).value({ kind: 'divcard', name: 'Imperial Legacy', stack: 1 })
  assert.equal(r.uncertain, 'thin-market')
  assert.equal(r.chaosEach, 4.6)
})

test('gem: no level on the item -> the cheapest line, marked gem-guessed', async () => {
  const v = createValuator({ league: L, deps: fakeDeps() })
  const r = await v.value({ kind: 'gem', name: 'Enlighten Support', level: null, quality: 0, corrupted: false, stack: 1 })
  assert.equal(r.chaosEach, 1197)
  assert.equal(r.uncertain, 'gem-guessed')
})

test('unique: a 6L with no 6L line is marked links-guessed, and so is an unlinked item that only has linked lines', async () => {
  const only = lines => createValuator({
    league: 'L',
    deps: {
      fetchItemOverview: async () => lines,
      fetchExchangeOverview: async () => null,
      fetchCurrencyOverview: async () => null
    }
  })
  // Only the base line: a 6L gets the base price (too low) and says so.
  const six = await only([LINKED[2]]).value({ kind: 'unique', name: "Nuro's Harp", baseType: 'Harbinger Bow', category: 'Bow', links: 6, stack: 1 })
  assert.equal(six.chaosEach, 1)
  assert.equal(six.uncertain, 'links-guessed')
  // Only linked lines: an unlinked bow gets a linked price (too high) and says so.
  const zero = await only([LINKED[0], LINKED[1]]).value({ kind: 'unique', name: "Nuro's Harp", baseType: 'Harbinger Bow', category: 'Bow', links: 0, stack: 1 })
  assert.equal(zero.uncertain, 'links-guessed')
})

test('corpse: a price from one listing is marked few-listings; enough listings, an old entry and Imperfect are not', async () => {
  const run = async (listings, extra = {}) => {
    const deps = fakeDeps()
    deps.corpseStore = { getPrice: () => 120, getListings: () => listings, league: () => L }
    Object.assign(deps, extra)
    return createValuator({ league: L, deps }).value({ kind: 'corpse', name: 'Forest Tiger', tradeTag: null, stack: 1 })
  }
  assert.deepEqual(await run(1), { chaosEach: 120, chaosTotal: 120, each: 120, source: 'corpse:trade', uncertain: 'few-listings' })
  assert.equal((await run(5)).uncertain, null)
  assert.equal((await run(2)).uncertain, null, 'the default bar of 2 marks exactly a single offer')
  assert.equal((await run(null)).uncertain, null, 'an entry written before the count existed is not marked')
  assert.equal((await run(1, { corpseMinListings: 0 })).uncertain, null, 'a bar of 0 never marks')
  assert.equal((await run(4, { corpseMinListings: 5 })).uncertain, 'few-listings')
  // A store without getListings at all (older stub).
  const deps = fakeDeps()
  deps.corpseStore = { getPrice: () => 120, league: () => L }
  assert.equal((await createValuator({ league: L, deps }).value({ kind: 'corpse', name: 'Forest Tiger', tradeTag: null, stack: 1 })).uncertain, null)
  // Imperfect: a stated 0, never a guess — even next to a one-offer store.
  const deps2 = fakeDeps()
  deps2.corpseStore = { getPrice: () => 120, getListings: () => 1, league: () => L }
  const r = await createValuator({ league: L, deps: deps2 }).value({ kind: 'corpse', name: 'Imperfect Forest Tiger', tradeTag: null, stack: 1 })
  assert.deepEqual(r, { chaosEach: 0, chaosTotal: 0, each: 0, source: 'corpse:imperfect', uncertain: null })
})

test('the stash currency overview, the last resort of the chain, is deliberately not marked', async () => {
  const deps = fakeDeps()
  deps.fetchCurrencyOverview = async (league, type) =>
    type === 'Currency' ? { byName: new Map([['Exalted Orb', 205]]) } : { byName: new Map() }
  const r = await createValuator({ league: L, deps }).value({ kind: 'stackable', name: 'Exalted Orb', tradeTag: 'exalted', stack: 1 })
  assert.equal(r.source, 'ninja:currency')
  assert.equal(r.uncertain, null)
})

// Buyer whispers (whisper-price.mjs) name a unique and its base, never its
// links or mods. uniqueCandidates hands back every line that name on that base
// can mean, after the same confidence gate, and chooses nothing: one line is a
// price, more is 'several variants'.
test('uniqueCandidates applies the confidence gate and the base, and chooses nothing', async () => {
  const calls = []
  const v = createValuator({
    league: L,
    deps: {
      fetchItemOverview: async (league, type) => {
        calls.push([league, type])
        if (type !== 'UniqueArmour') return []
        return [
          { name: 'Abyssus', baseType: 'Ezomyte Burgonet', chaosValue: 42.7, count: 60 },
          { name: 'Abyssus', baseType: 'Ezomyte Burgonet', chaosValue: 400, links: 6, count: 12 },
          { name: 'Abyssus', baseType: 'Other Base', chaosValue: 999, count: 30 },
          { name: 'Abyssus', baseType: 'Ezomyte Burgonet', chaosValue: 9999999, count: 2 }, // phantom
          { name: 'Abyssus', baseType: 'Ezomyte Burgonet', chaosValue: null, count: 50 }, // no price
          { name: 'Other', baseType: 'Ezomyte Burgonet', chaosValue: 5, count: 50 }
        ]
      }
    }
  })
  const both = await v.uniqueCandidates({ name: 'Abyssus', baseType: 'Ezomyte Burgonet', category: 'Helmet' })
  assert.deepEqual(both.map(l => l.chaosValue).sort((a, b) => a - b), [42.7, 400], 'base line and 6L line, phantom and other base gone')
  assert.deepEqual(calls, [[L, 'UniqueArmour']])
  const anyBase = await v.uniqueCandidates({ name: 'Abyssus', baseType: null, category: 'Helmet' })
  assert.equal(anyBase.length, 3, 'without a base every confident line of that name')
  assert.deepEqual(await v.uniqueCandidates({ name: 'Abyssus', baseType: 'Ezomyte Burgonet', category: null }), [], 'no category, no overview, no line')
  assert.deepEqual(await v.uniqueCandidates({ name: 'Nobody', baseType: 'Ezomyte Burgonet', category: 'Helmet' }), [])
})
