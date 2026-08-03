#!/usr/bin/env node
// Base-names generator: RePoE base_items.json -> backend/v2/networth/base-names.json
// (metadata id -> name). That map is the bridge Faustus needs to turn the
// Currency Exchange's metadata ids into the names the valuator prices by; every
// id missing from it is an item the exchange prices and we cannot name.
//
// CLI, NOT imported by the server at runtime — but the data refresher
// (backend/v2/data-refresher.mjs) imports buildBaseNames and URLS so its
// conditional requests run against exactly these sources.
//
// Usage: node backend/v2/base-names-gen.mjs
// No arguments — the run always rewrites base-names.json and then reports
// Faustus coverage (which priced exchange ids still have no name) on stdout.

import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE_NAMES_OUT_PATH = path.join(HERE, 'networth/base-names.json')

// Exported: the data refresher drives its conditional requests against exactly
// these URLs — one source of truth.
export const URLS = {
  // base_items: NOT the lvlvllvlvl RePoE mirror. That file's last commit is
  // 2024-09-25 (~2 years stale), which was the root cause of a Faustus coverage
  // gap: every id GGG added since then (the whole Metadata/Items/Deepwater/
  // segment = Ducats, the Settlers/Mercenaries/new Anarchy scarabs, the
  // Necropolis Allflame Embers, the Runegrafts, the Atlas Astrolabes and ~120
  // divination cards) simply is not in it, so the metadata-id -> name bridge came
  // up empty and the valuator fell through to the trade-site ask (grotesquely
  // wrong: nobody lists below 1 Divine).
  // repoe-fork.github.io is the same RePoE export, same schema, regenerated
  // against the current client (pushed daily). Verified against the live Faustus
  // digest: strict SUPERSET of the stale mirror — 0 ids lost, 405 added, and it
  // closes 123/123 of the priced-but-unnamed ids. Same project family, so this is
  // a fresher mirror of an existing dependency, not a new one.
  baseItems: 'https://repoe-fork.github.io/base_items.json',
  // Kept as an explicit fallback ONLY: if the fork's pages host is down we still
  // generate, but with a loud warning, because the stale data reopens the gap.
  baseItemsFallback: 'https://raw.githubusercontent.com/lvlvllvlvllvlvl/RePoE/master/RePoE/data/base_items.json',
}

// Item categories that never sit in a tradeable stash tab, so their names would
// only bloat the map.
const BASE_NAMES_DROP_PREFIXES = [
  'MicrotransactionCurrency',
  'QuestItems',
  'Classic',
  'Hideout',
  'Masters',
  'TradeProxy',
  'NecropolisPacks',
]

async function fetchJson (url, headers) {
  const res = await fetch(url, headers ? { headers } : undefined)
  if (!res.ok) throw new Error(`Fetch failed (${res.status} ${res.statusText}): ${url}`)
  return res.json()
}

// Metadata id ("Metadata/Items/...") -> top-level segment right after "Items/"
// (e.g. "Metadata/Items/Currency/CurrencyRerollRare" -> "Currency").
function baseNamesTopSegment (metadataId) {
  const m = /^Metadata\/Items\/([^/]+)\//.exec(metadataId)
  return m ? m[1] : null
}

/**
 * Builds the net-worth base-names map: RePoE base_items.json (metadata id ->
 * { name, release_state, ... }), filtered to release_state === 'released'
 * and with the MTX/quest/legacy/hideout/masters/trade-proxy/necropolis-pack
 * prefixes dropped (see BASE_NAMES_DROP_PREFIXES). Sorted by key.
 * Returns a plain object { "<metadataId>": "<name>" }.
 */
export async function generateBaseNames () {
  console.log(`Fetching base_items.json (${URLS.baseItems})...`)
  let baseItems
  try {
    baseItems = await fetchJson(URLS.baseItems)
  } catch (err) {
    console.warn('WARNING: %s', err.message)
    console.warn('WARNING: falling back to the STALE RePoE mirror — expect Faustus coverage gaps.')
    baseItems = await fetchJson(URLS.baseItemsFallback)
  }
  return buildBaseNames(baseItems)
}

// Pure transform half of generateBaseNames (no network): base_items.json
// content -> { "<metadataId>": "<name>" }. Exported separately so the data
// refresher can run it on a body it fetched itself (conditional request).
export function buildBaseNames (baseItems) {
  const ids = Object.keys(baseItems)
    // 'legacy' alongside 'released': removed from the drop pool but still in
    // stashes and still traded — the Currency Exchange prices Eternal Orb right
    // now, and dropping it was the last remaining coverage gap. ('unreleased'
    // and 'unique_only' stay out: not stashable as such, and unreleased names
    // can still change.)
    .filter(id => ['released', 'legacy'].includes(baseItems[id].release_state))
    .filter(id => !BASE_NAMES_DROP_PREFIXES.includes(baseNamesTopSegment(id)))
    // Drop empty-name bases (~420 RandomFossilOutcome* placeholders and the
    // like): a "" name can never match a stash typeLine and only bloats the map.
    .filter(id => typeof baseItems[id].name === 'string' && baseItems[id].name.trim() !== '')
    .sort()

  const names = {}
  for (const id of ids) names[id] = baseItems[id].name
  return names
}

/**
 * Coverage self-check: pulls the PUBLIC Faustus digest (no credentials, same
 * endpoint as backend/v2/networth/faustus.mjs) and reports which ids the
 * Currency Exchange actually prices but the freshly built map cannot name.
 * This is the check that would have caught the stale-source gap immediately, so
 * run it on every regeneration instead of waiting for a wrong price in-game.
 * Returns { total, missing: [ids] }.
 */
export async function checkFaustusCoverage (names, { hours = 8, now = Date.now() } = {}) {
  const ids = new Set()
  let id = Math.floor(now / 1000 / 3600) * 3600 - 3600
  for (let collected = 0, guard = 0; collected < hours && guard < hours + 24; guard++) {
    let digest = null
    try {
      const r = await fetch(`https://web.poecdn.com/api/currency-exchange/${id}`, {
        headers: { 'User-Agent': 'poe-price-tool/0.1', Accept: 'application/json' }
      })
      if (r.ok) digest = await r.json()
    } catch { /* treat as not-ready -> step back an hour */ }
    if (!digest || !Array.isArray(digest.markets) || digest.markets.length === 0 ||
        digest.next_change_id === id) { id -= 3600; continue }
    for (const m of digest.markets) {
      if (Array.isArray(m.market_pair) && m.market_pair.length === 2) {
        ids.add(m.market_pair[0]); ids.add(m.market_pair[1])
      }
    }
    collected++
    id -= 3600
  }
  return { total: ids.size, missing: [...ids].filter(i => !(i in names)).sort() }
}

async function main () {
  const baseNames = await generateBaseNames()
  await writeFile(BASE_NAMES_OUT_PATH, JSON.stringify(baseNames, null, 0))
  console.log(`base-names.json: ${Object.keys(baseNames).length} entries written: ${BASE_NAMES_OUT_PATH}`)

  const cov = await checkFaustusCoverage(baseNames)
  if (cov.missing.length === 0) {
    console.log(`Faustus coverage: all ${cov.total} priced ids resolve to a name.`)
  } else {
    const byPrefix = {}
    for (const id of cov.missing) {
      const p = id.split('/').slice(0, 3).join('/') + '/'
      byPrefix[p] = (byPrefix[p] || 0) + 1
    }
    console.warn(`Faustus coverage GAP: ${cov.missing.length}/${cov.total} priced ids have no name.`)
    for (const [p, n] of Object.entries(byPrefix).sort()) console.warn(`  ${p} ${n}`)
    console.warn('  ' + cov.missing.join('\n  '))
  }
}

// Only run when invoked directly as a CLI (not on import, e.g. in tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('ERROR:', err.message)
    process.exit(1)
  })
}
