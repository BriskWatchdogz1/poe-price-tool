// Filter rows the ENGINE invents — the labels no data set can ever translate.
//
// On an otherwise fully German card two rows read `Energy Shield: 350` and
// `Base Percentile: 82%`, in the chip strip and in the mod picker, between
// correctly translated mods. They are not item names (that is the display
// bridge, item-name-map.test.mjs) and not stats from the data set: the vendored
// engine builds them in renderer/src/web/price-check/filters/ out of string
// literals and hands them over as a filter row's `text`. `Base Percentile`
// appears ZERO times in data/en/stats.ndjson — there is nothing for a generator
// to translate, so the frontend string table is the only place left.
//
// Two guards, and the first is the one that matters in a year:
//
//   (a) the INVENTORY is complete. The scanner below reads the filter sources
//       and demands a `flt.` entry for every literal label it finds, so the
//       next upstream bump that adds one turns this file red instead of
//       producing the next bug report. Patching renderer/src instead was the
//       alternative and was rejected: a patch for a display string would have
//       to be carried forever, and the point of vendoring is that upstream
//       stays upstream.
//   (b) the mapping behaves like fact(): a known label is replaced, the value
//       is untouched, an unknown text passes through.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

// i18n.js is a classic browser script; a bare `window` in a vm context is
// enough to read the tables (same as i18n-coverage.test.mjs, inlined so
// importing it does not re-run that file's tests).
async function loadI18n () {
  const src = await readFile(new URL('i18n.js', import.meta.url), 'utf8')
  const ctx = vm.createContext({ window: {}, localStorage: undefined })
  vm.runInContext(src, ctx, { filename: 'i18n.js' })
  return ctx.window.I18n
}

const FILTERS_DIR = fileURLToPath(new URL('../../../renderer/src/web/price-check/filters/', import.meta.url))
const EN_STATS = new URL('../../../renderer/public/data/en/stats.ndjson', import.meta.url)
const BUNDLE = new URL('../engine.bundle.mjs', import.meta.url)

async function tsFiles (dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...await tsFiles(full))
    else if (e.name.endsWith('.ts')) out.push(full)
  }
  return out.sort()
}

// Every string literal that ends up as a filter row's visible text.
//
// Two shapes, because the sources use two. Directly:
//   propToFilter({ ref: 'Energy Shield: #', … })   /   text: '…', statRef: '…'
// and indirectly, where the ref is a variable the file assigns a literal to
// (heist.ts routes nine job ids through one `internalId`). A `stat('…')` call
// is deliberately NOT matched: that ref comes out of the data set and is
// therefore already localized — those are the rows that render correctly today.
async function engineLabels () {
  const found = new Map() // label -> Set(file)
  for (const file of await tsFiles(FILTERS_DIR)) {
    const src = await readFile(file, 'utf8')
    const base = path.relative(FILTERS_DIR, file)
    const add = s => found.set(s, (found.get(s) || new Set()).add(base))
    const idents = new Set()
    for (const m of src.matchAll(/\b(?:ref|text|statRef)\s*:\s*(?:(["'])((?:\\.|(?!\1).)*)\1|([A-Za-z_$][\w$]*))\s*[,}\n]/g)) {
      if (m[2] != null) add(m[2])
      else if (m[3]) idents.add(m[3])
    }
    for (const id of idents) {
      for (const m of src.matchAll(new RegExp('\\b' + id + '\\s*=\\s*(["\'])((?:\\\\.|(?!\\1).)*)\\1', 'g'))) add(m[2])
    }
  }
  return found
}

// Negative control: a scanner that finds nothing looks exactly like a scanner
// that is broken.
test('the scanner really reads the filter sources', async () => {
  const labels = await engineLabels()
  assert.ok(labels.size >= 20, `only ${labels.size} labels found — the scanner has stopped biting`)
  assert.ok(labels.has('Energy Shield: #'), 'the reported row is among them')
  assert.ok(labels.has('Base Percentile: #%'), 'and so is the second one')
  assert.ok(!labels.has('+#% to Fire Resistance'),
    'a stat() ref must NOT be collected — it comes from the data set and is already translated')
})

// The premise of the whole file. If one of these ever DID appear in the data
// set, translating it here would fight the generator instead of completing it.
test('none of these labels is a game string the data set could ever carry', async () => {
  const labels = await engineLabels()
  const stats = await readFile(EN_STATS, 'utf8')
  const inData = [...labels.keys()].filter(l => stats.includes(l))
  assert.deepEqual(inData, [], 'these are in data/en/stats.ndjson after all:\n' + inData.join('\n'))
})

test('and every one of them really reaches the runtime', async () => {
  const labels = await engineLabels()
  const bundle = await readFile(BUNDLE, 'utf8')
  const absent = [...labels.keys()].filter(l => !bundle.includes(l))
  assert.deepEqual(absent, [], 'scanned from the sources but not in the built bundle:\n' + absent.join('\n'))
})

// (a) — the inventory guard.
test('every engine filter label has an entry in every language', async () => {
  const labels = await engineLabels()
  const I18n = await loadI18n()
  const missing = []
  for (const lang of Array.from(I18n.languages())) {
    for (const [label, files] of labels) {
      if (!Object.hasOwn(I18n.STRINGS[lang], 'flt.' + label)) {
        missing.push(`${lang}: ${JSON.stringify(label)}  (${[...files].join(', ')})`)
      }
    }
  }
  assert.deepEqual(missing, [],
    'these engine labels stay English in every language — add a flt.* entry:\n' + missing.join('\n'))
})

test('no flt.* entry describes a label the engine no longer produces', async () => {
  const labels = await engineLabels()
  const I18n = await loadI18n()
  // Base Percentile is the one label the SERVER also produces on its own
  // (server.mjs BASE_PCT_MOD_TEXT, for the rares the engine skips) — same
  // string, so the scanner already covers it.
  const stale = Object.keys(I18n.STRINGS.en)
    .filter(k => k.startsWith('flt.'))
    .map(k => k.slice(4))
    .filter(l => !labels.has(l))
  assert.deepEqual(stale, [], 'dead entries — the engine does not emit these:\n' + stale.join('\n'))
})

test('a translation keeps the roll placeholder', async () => {
  const I18n = await loadI18n()
  for (const lang of Array.from(I18n.languages())) {
    for (const [k, v] of Object.entries(I18n.STRINGS[lang])) {
      if (!k.startsWith('flt.')) continue
      const en = I18n.STRINGS.en[k]
      assert.equal((v.match(/#/g) || []).length, (en.match(/#/g) || []).length,
        `${lang}.${k} does not carry the same # placeholder as "${en}" — the roll would be dropped`)
    }
  }
})

// (b) — the mapping itself.
test('filterLabel: the label is translated, an unknown text is left alone', async () => {
  const I18n = await loadI18n()
  I18n.setLang('de')
  assert.equal(I18n.filterLabel('Energy Shield: #'), 'Energieschild: #')
  assert.equal(I18n.filterLabel('Base Percentile: #%'), 'Basis-Perzentil: #%')
  assert.equal(I18n.filterLabel('Total DPS: #'), 'Gesamt-DPS: #')
  // The Heist rows are the group whose engine text is not even English.
  assert.equal(I18n.filterLabel('item.heist_job_lockpicking'), 'Schlossknacken: #')
  // A real, already localized mod line must pass through untouched — that is
  // what keeps this out of the data set's way.
  assert.equal(I18n.filterLabel('Kreaturen verursachen 20% erhöhten Schaden'),
    'Kreaturen verursachen 20% erhöhten Schaden')
  assert.equal(I18n.filterLabel('brand new engine row'), 'brand new engine row')
  assert.equal(I18n.filterLabel(''), '')
  assert.equal(I18n.filterLabel(null), null)
  I18n.setLang('en')
  assert.equal(I18n.filterLabel('Energy Shield: #'), 'Energy Shield: #')
  // English is not an identity for the Heist ids: there the engine text is an
  // internal id, so English gets a label too — and with it the `#` that makes
  // the required job level show up at all.
  assert.equal(I18n.filterLabel('item.heist_job_lockpicking'), 'Lockpicking: #')
})

test('the German labels follow the game client, not a free rendering', async () => {
  const I18n = await loadI18n()
  const strings = await readFile(new URL('../../../renderer/public/data/de/client_strings.js', import.meta.url), 'utf8')
    .catch(() => null)
  if (strings == null) return // no generated German set here — see lang-dataset.test.mjs
  for (const [key, want] of [
    ['flt.Armour: #', 'ARMOUR'],
    ['flt.Evasion Rating: #', 'EVASION'],
    ['flt.Energy Shield: #', 'ENERGY_SHIELD'],
    ['flt.Ward: #', 'TAG_WARD'],
    ['flt.Memory Strands: #', 'MEMORY_STRANDS'],
    ['flt.Critical Strike Chance: #%', 'CRIT_CHANCE'],
    ['flt.Attacks per Second: #', 'ATTACK_SPEED'],
    ['flt.Item Quantity: +#%', 'MAP_ITEM_QUANTITY'],
    ['flt.Item Rarity: +#%', 'MAP_ITEM_RARITY'],
    ['flt.Monster Pack Size: +#%', 'MAP_MONSTER_PACK_SIZE']
  ]) {
    const m = new RegExp(`\\b${want}:\\s*'((?:\\\\.|[^'])*)'`).exec(strings)
    assert.ok(m, `${want} is not in the German client strings`)
    const clientWord = m[1].replace(/:\s*$/, '')
    assert.ok(I18n.STRINGS.de[key].startsWith(clientWord + ':'),
      `${key} is "${I18n.STRINGS.de[key]}" but the German client says "${clientWord}"`)
  }
})
