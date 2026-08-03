// GGG stash item JSON (legacy get-stash-items) -> priceable descriptor.
// Bridge: renderer/public/data/en/items.ndjson (refName/namespace/tradeTag/
// exchangeable/craftable.category/unique.base). Verified facts:
//  - NO "CURRENCY" namespace: Currency/Scarabs/Essences = ITEM + tradeTag +
//    exchangeable; DivCards = DIVINATION_CARD (exchangeable, NO tradeTag);
//    Vials/Incubators = ITEM WITHOUT tradeTag; Beasts = CAPTURED_BEAST;
//    Corpses = ITEM WITHOUT tradeTag, detected via the icon (…Corpse.png).
//  - Unique category via join: typeLine (base) -> ITEM entry -> craftable.category.
//  - Legacy names carry <<set:...>> markup -> strip it.
// The actual classification (which kind) lives declaratively in kinds.mjs —
// add a category there in ONE place, this file just builds the context.
import { readFile } from 'node:fs/promises'
import { classify } from './kinds.mjs'

const ITEMS_NDJSON = new URL('../../../renderer/public/data/en/items.ndjson', import.meta.url)

const stripMarkup = s => String(s || '').replace(/<<[^>]*>>/g, '').trim()

export async function loadItemsIndex (path = ITEMS_NDJSON) {
  const raw = await readFile(path, 'utf8')
  const byName = new Map() // refName -> first non-UNIQUE entry (ITEM/GEM/DIVINATION_CARD/CAPTURED_BEAST)
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const e = JSON.parse(line)
    if (e.namespace === 'UNIQUE') continue
    if (!byName.has(e.refName)) byName.set(e.refName, e)
  }
  return {
    byName,
    categoryOfBase (baseName) { return byName.get(baseName)?.craftable?.category ?? null }
  }
}

// Build the classification context from a raw GGG stash item and delegate to
// the declarative rule set in kinds.mjs. Behaviour (which kind an item becomes)
// is defined THERE — this only decodes the fields every rule shares.
export function normalizeItem (ggg, index) {
  const name = stripMarkup(ggg.name)
  const typeLine = stripMarkup(ggg.typeLine)
  const stack = typeof ggg.stackSize === 'number' && ggg.stackSize > 0 ? ggg.stackSize : 1
  const frame = ggg.frameType
  const entry = index.byName.get(typeLine)
  return classify({ ggg, name, typeLine, stack, frame, entry, index })
}
