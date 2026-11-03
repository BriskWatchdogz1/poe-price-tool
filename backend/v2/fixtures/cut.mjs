#!/usr/bin/env node
// Cuts the tracked market fixtures out of a raw recording.
//
//   node backend/v2/fixtures/cut.mjs 2026-11-03
//
// reads backend/v2/fixtures/raw/<date>/ (gitignored, recorded with the command
// in <date>/README.md) and writes backend/v2/fixtures/<date>/: the same file
// names, each holding only the entries the tests in
// networth/recorded-thresholds.test.mjs read. Every entry is copied whole, as
// recorded; only the lists are shortened. No network: it reads files only.
//
// What is kept, and why, is listed below and explained in <date>/README.md.
// A new recording needs its own lists: the examples are chosen because they
// sit next to a threshold in THIS recording.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBaseNames } from '../networth/base-names.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LEAGUE = 'Allflame'
const CHAOS = 'Metadata/Items/Currency/CurrencyRerollRare'
const DIVINE = 'Metadata/Items/Currency/CurrencyModValues'

// Faustus: every hour's market of each name against Chaos or Divine, plus the
// Divine<->Chaos market itself (it sets the Chaos:Divine rate of the window).
// Keeping every hour of a pair keeps the union walk, the envelope and the
// deepest hour exactly as they were over the whole digest.
const FAUSTUS_NAMES = [
  // Quote-side floor (50 chaos, 10 divine), read per market entry.
  'Memory of Reverence', 'Deafening Essence of Torment', 'Cosmic Fragment',
  // Cross-hour check (10 units, 3x deeper, 2x apart).
  'Memory of Loneliness', 'Shuddering Fossil', 'Matryoshka', 'Prime Chaotic Resonator',
  'Timeless Templar Emblem', 'Deafening Essence of Wrath', 'Tattoo of the Ramako Fleetfoot',
  'Fragment of the Phoenix',
  // Divine bridge (3x the units, 5000 chaos of turnover).
  'Devouring Fragment', 'Fine Delirium Orb', 'Exalted Orb', "Zorath's Eye of the Endless"
]

// poe.ninja exchange overviews: type -> names. `core` stays as recorded.
const EXCHANGE_NAMES = {
  DivinationCard: ['Divine Beauty', 'Damnation', 'Mawr Blaidd', 'The Slumbering Beast', 'Lost Worlds'],
  Essence: ['Essence of Delirium', 'Essence of Hysteria'],
  Currency: ['Orb of Dominance', 'Veiled Exalted Orb']
}

// poe.ninja item overviews: type -> names; every line of a name is kept.
const ITEM_NAMES = {
  SkillGem: ['Vaal Clarity', 'Heavy Strike'],
  UniqueMap: ['Replica Pillars of Arun', "Replica Poorjoy's Asylum"]
}

// One entry per line, so a diff shows which entry changed.
const lines = arr => arr.length ? '[\n' + arr.map(e => JSON.stringify(e)).join(',\n') + '\n]' : '[]'
const objectWith = (head, listKey, list) => {
  const parts = Object.entries(head).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
  parts.push(`${JSON.stringify(listKey)}: ${lines(list)}`)
  return '{\n' + parts.join(',\n') + '\n}\n'
}
const readJson = async f => JSON.parse(await readFile(f, 'utf8'))

async function main () {
  const date = process.argv[2]
  if (!date) { console.error('usage: node backend/v2/fixtures/cut.mjs <date>'); process.exit(2) }
  const rawDir = path.join(HERE, 'raw', date)
  const outDir = path.join(HERE, date)
  await mkdir(outDir, { recursive: true })

  const { byId } = await loadBaseNames()
  const wanted = new Set(FAUSTUS_NAMES)
  const ids = new Set([...byId].filter(([, n]) => wanted.has(n)).map(([id]) => id))
  const missingNames = FAUSTUS_NAMES.filter(n => ![...byId.values()].includes(n))
  if (missingNames.length) throw new Error(`no metadata id for: ${missingNames.join(', ')}`)
  const keep = m => {
    if (m.league !== LEAGUE || !Array.isArray(m.market_pair) || m.market_pair.length !== 2) return false
    const [a, b] = m.market_pair
    if ((a === DIVINE && b === CHAOS) || (a === CHAOS && b === DIVINE)) return true
    return (ids.has(a) && (b === CHAOS || b === DIVINE)) || (ids.has(b) && (a === CHAOS || a === DIVINE))
  }
  for (const f of (await readdir(rawDir)).filter(f => /^faustus-\d+\.json$/.test(f)).sort()) {
    const j = await readJson(path.join(rawDir, f))
    const markets = j.markets.filter(keep)
    await writeFile(path.join(outDir, f), objectWith({ next_change_id: j.next_change_id }, 'markets', markets))
    console.log(`${f}: ${markets.length} of ${j.markets.length} markets`)
  }

  for (const [type, names] of Object.entries(EXCHANGE_NAMES)) {
    const f = `exchange-${type}.json`
    const j = await readJson(path.join(rawDir, f))
    const items = j.items.filter(it => names.includes(it.name))
    const idSet = new Set(items.map(it => it.id))
    const found = items.map(it => it.name)
    const absent = names.filter(n => !found.includes(n))
    if (absent.length) throw new Error(`${f}: not recorded: ${absent.join(', ')}`)
    const out = '{\n' + `"core": ${JSON.stringify(j.core)},\n"lines": ${lines(j.lines.filter(l => idSet.has(l.id)))},\n"items": ${lines(items)}\n}\n`
    await writeFile(path.join(outDir, f), out)
    console.log(`${f}: ${idSet.size} of ${j.lines.length} lines`)
  }

  for (const [type, names] of Object.entries(ITEM_NAMES)) {
    const f = `item-${type}.json`
    const j = await readJson(path.join(rawDir, f))
    const kept = j.lines.filter(l => names.includes(l.name))
    const absent = names.filter(n => !kept.some(l => l.name === n))
    if (absent.length) throw new Error(`${f}: not recorded: ${absent.join(', ')}`)
    await writeFile(path.join(outDir, f), objectWith({}, 'lines', kept))
    console.log(`${f}: ${kept.length} of ${j.lines.length} lines`)
  }
}

main().catch(e => { console.error(e?.stack || e); process.exit(1) })
