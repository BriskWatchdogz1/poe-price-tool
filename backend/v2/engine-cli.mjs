#!/usr/bin/env node
// Debug CLI: node backend/v2/engine-cli.mjs <item.txt> [--league Standard] [--parse-only]
// Prints the recognized item + (by default) real trade prices.

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = path.join(here, 'engine.bundle.mjs')
if (!existsSync(bundle)) {
  console.error('engine.bundle.mjs is missing — build it first:  node backend/v2/build.mjs')
  process.exit(1)
}

const args = process.argv.slice(2)
const itemFile = args.find(a => !a.startsWith('--'))
const leagueIdx = args.indexOf('--league')
const league = leagueIdx !== -1 ? args[leagueIdx + 1] : 'Standard'
const parseOnly = args.includes('--parse-only')

if (!itemFile) {
  console.error('Usage: node backend/v2/engine-cli.mjs <item.txt> [--league <name>] [--parse-only]')
  process.exit(1)
}

const clipboard = await readFile(itemFile, 'utf8')
const engine = await import(bundle)

function modLines (stats) {
  return stats
    .filter(s => !s.hidden)
    .map(s => {
      const r = s.roll
      const val = r ? ` [${r.value}${r.min != null || r.max != null ? ` -> min ${r.min ?? '-'} / max ${r.max ?? '-'}` : ''}]` : ''
      return `    - ${s.text.replace(/\n/g, ' / ')}${val}${s.disabled ? '  (disabled)' : ''}`
    })
}

if (parseOnly) {
  const { item, presets } = await engine.parseItem(clipboard, { league })
  printItem(item)
  const preset = presets.presets.find(p => p.id === presets.active) ?? presets.presets[0]
  console.log(`\n  Filter-Preset: ${preset.id}`)
  console.log('  Stat-Filter:')
  console.log(modLines(preset.stats).join('\n') || '    (none)')
  process.exit(0)
}

const { item, price } = await engine.priceCheck(clipboard, { league, maxListings: 8 })
printItem(item)
console.log('\n  Stat filter (search):')
console.log(modLines(price.stats).join('\n') || '    (none)')

console.log(`\n=== Trade (${league}) ===`)
console.log(`  Total hits: ${price.total}${price.inexact ? ' (inexact)' : ''}`)
console.log(`  Query: https://www.pathofexile.com/trade/search/${league}/${price.queryId}`)
console.log('  Listings:')
for (const l of price.listings) {
  console.log(`    - ${l.priceAmount} ${l.priceCurrency}  | ${l.accountName} (${l.accountStatus})  | ${l.relativeDate}`)
}
if (!price.listings.length) console.log('    (none)')

// APT's RateLimiter keeps open setTimeout handles (rate limit window) in the
// event loop -> otherwise the process would only end once the window expires.
process.exit(0)

function printItem (item) {
  console.log('=== Item ===')
  console.log(`  Name:   ${item.info?.name ?? item.name ?? '?'}`)
  console.log(`  Base:   ${item.info?.refName ?? '?'}`)
  console.log(`  Class:  ${item.category ?? '?'}`)
  console.log(`  Rarity: ${item.rarity ?? '?'}`)
  if (item.itemLevel != null) console.log(`  iLvl:   ${item.itemLevel}`)
}
