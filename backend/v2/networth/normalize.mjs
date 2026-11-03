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
  // tradeTag -> refName ('alch' -> 'Orb of Alchemy'). A single trade whisper
  // names its price by the trade tag ('listed for 10 alch'), and byName only
  // knows reference names.
  const byTag = new Map()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const e = JSON.parse(line)
    if (e.namespace === 'UNIQUE') continue
    if (!byName.has(e.refName)) byName.set(e.refName, e)
    if (typeof e.tradeTag === 'string' && e.tradeTag && !byTag.has(e.tradeTag)) byTag.set(e.tradeTag, e.refName)
  }
  return {
    byName,
    byTag,
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

// A descriptor from a REFERENCE NAME alone, for callers that never saw a stash
// item (buyer whispers, whisper-price.mjs). The frame comes from the catalogue
// entry, with GGG's frameType values as kinds.mjs reads them (5 currency,
// 6 divination card, 0 normal for everything the entry-based rules decide:
// beasts, incubators, vials, invitations, corpses). A 'skip' or 'unknown'
// result is null: nothing a whisper names may be priced by a guessed route.
const FRAME_NORMAL = 0
const FRAME_CURRENCY = 5
const FRAME_DIVINATION = 6
export function descriptorForName (refName, index, { stack = 1 } = {}) {
  const entry = index.byName.get(refName)
  if (!entry) return null
  const frame = entry.namespace === 'DIVINATION_CARD' ? FRAME_DIVINATION : entry.exchangeable ? FRAME_CURRENCY : FRAME_NORMAL
  const desc = classify({ ggg: { typeLine: refName, frameType: frame, stackSize: stack }, name: '', typeLine: refName, stack, frame, entry, index })
  return desc && desc.kind !== 'skip' && desc.kind !== 'unknown' ? desc : null
}
