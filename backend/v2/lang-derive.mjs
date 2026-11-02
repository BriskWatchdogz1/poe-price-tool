// Derivation of a localized APT data set from the English one plus GGG game
// data. Pure: everything here takes plain arrays/objects and returns plain
// arrays/objects — no fs, no network. lang-data-gen.mjs does the I/O.
//
// THE ONE IDEA: the generator does not build a data set, it REPLACES text in
// the English one. `ref`, `refName`, `trade.ids`, `better`, `dp`, `resolve`,
// `unique.base`, `tradeTag`, categories — all of that is language neutral and
// is copied through untouched. Only `name` (items) and `matchers[].string` /
// `matchers[].advanced` (stats) are translated.
//
// AND THE ONE RULE: flags are INHERITED, never derived. Every German matcher
// carries the `negate`, `value` and `dp` of the exact English matcher it came
// from. Deriving them was tried twice and failed at the data both times — from
// the wording (70 of 1510 `negate` matchers carry no direction word at all)
// and from the description line's own conditions/handlers (33 cases come out
// exactly INVERTED, the legacy `double`/`negate_and_double` family). A wrong
// `negate` flips the sign of the roll and with it the trade filter, and
// nothing fails while it does. So: inherit, and use the line metadata only as
// a plausibility probe.
//
// How a German matcher string is found for an English one, in this order:
//
//   line      the English matcher text IS a description line; take line i of
//             the German block (Gate 0-5). Covers ~75 %.
//   template  the description line has a NAME SLOT — a placeholder the game
//             fills from a name table, marked by the line's own handler
//             (`passive_hash`, `display_indexable_skill`, ...). APT expands
//             that into one matcher per name ("Allocates Acrimony"). Match the
//             template, translate the name through the handler's table, put it
//             back into the German template.
//   name      the whole matcher string is a name from a name table (Incursion
//             rooms, Expedition factions, veiled `Mods.Name`). Several German
//             values for one English name are legitimate here — that is the
//             declension split, and it is exactly what the Russian set shows.
//   frame     a ClientStrings entry with a single `{0}` wraps another,
//             resolvable text ("While a Pinnacle Atlas Boss is in your
//             Presence, {0}").
//   paren     "<name> (<something resolvable>)", the Lake reflections.
//
// Ambiguity is REJECTED, never guessed: if the same English line has two
// different German forms in different blocks, or two templates match with
// different results, no matcher is produced and the case is logged. Falsely
// priced is worse than unpriced.

import { render, matchKey, placeholders, grammarForms, grammarPlain } from './lang-statdesc.mjs'

// A control character no game text contains — marks a name slot while the
// text goes through render()/matchKey().
const SLOT = '\u0001'
const slotMark = i => SLOT + i + SLOT
const SLOT_SPLIT = /\u0001(\d+)\u0001/

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Description-line handler -> the game table it pulls a name from. The handler
 * names are GGG's own; this is a translation of their vocabulary, not a guess
 * per stat. `<handler> <n>` means: argument n (1 based) is the name.
 */
export const NAME_SOURCES = {
  passive_hash: { table: 'PassiveSkills', columns: ['Name'] },
  tree_expansion_jewel_passive: { table: 'PassiveSkills', columns: ['Name'] },
  display_indexable_skill: { table: 'IndexableSkillGems', columns: ['Name1', 'Name2'] },
  display_indexable_support: { table: 'IndexableSupportGems', columns: ['Name'] },
  display_indexable_non_active_support: { table: 'IndexableNonActiveSupportGems', columns: ['Name'] },
  affliction_reward_type: { table: 'AfflictionRewardTypeVisuals', columns: ['Name'] },
  mod_value_to_item_class: { table: 'ItemClasses', columns: ['Name'] },
  weapon_tree_unique_base_type_name: { table: 'BaseItemTypes', columns: ['Name'] }
}

/**
 * Tables whose plain name can BE a whole matcher string.
 *
 * THE GEM AND SKILL NAMES WERE MISSING HERE — docs/bugs.md B23. On 2026-08-17
 * the English upstream started shipping stats whose matcher is nothing but a
 * skill or gem name (`Arc`, `Anger`, `Bear Trap`, `Ball Lightning of Static`,
 * `Ailment Damage`), and 487 of them resolved to nothing. Not because the names
 * were unreachable: `ActiveSkills`, `IndexableSkillGems` and
 * `IndexableNonActiveSupportGems` are exported on every single run already —
 * they are in REQUIRED_TABLES through NAME_SOURCES and ITEM_NAME_SOURCES — they
 * were simply never offered to byName(). One table of the family,
 * `IndexableSupportGems`, was, and that is what makes this an omission rather
 * than a decision: `Added Fire Damage` resolved all along while
 * `Ailment Damage` two rows over did not.
 *
 * So this list costs NOTHING extra: no new file, no new request, no new
 * dependency. REQUIRED_TABLES does not change, and a test says so.
 *
 * AND IT CANNOT DISTURB WHAT ALREADY WORKED, which was measured rather than
 * hoped for: of the 10 414 matcher strings in the English set as it stood
 * before the upstream update, exactly ZERO are equal to one of the 823 gem
 * names — so no matcher that resolves today can be reached by these tables at
 * all. byName() is also only consulted after byLine() and byTemplate() have
 * failed, so a description line keeps winning over a name that reads like one.
 *
 * `BaseItemTypes` is deliberately NOT here although it carries gem base names
 * too. What it would add over `ActiveSkills` is the SUPPORT gem full names
 * ("… Support"), which is not what the observed matchers are — and it brings
 * ~14 000 ordinary item bases with it, into a lookup that is tried for every
 * matcher text that is not a description line. That is a real risk for no
 * measured gain, and falsely matched is worse than unmatched. A gem name that
 * turns out to live only there will appear in the next run's unresolved list,
 * where it can be argued about with the string in hand.
 */
export const WHOLE_NAME_TABLES = [
  { table: 'Mods', columns: ['Name'] },
  { table: 'IncursionRooms', columns: ['Name'] },
  { table: 'ExpeditionFactions', columns: ['Name'] },
  { table: 'LakeRooms', columns: ['Name'] },
  // The four gem/skill name tables. `ActiveSkills` is the widest of them and
  // the one carrying the transfigured variants ("… of Static", "… of Snaking"):
  // measured on the item side, it supplies the 215 gem names BaseItemTypes has
  // no row for (see ITEM_NAME_SOURCES.GEM).
  { table: 'ActiveSkills', columns: ['DisplayedName'] },
  { table: 'IndexableSkillGems', columns: ['Name1', 'Name2'] },
  { table: 'IndexableSupportGems', columns: ['Name'] },
  { table: 'IndexableNonActiveSupportGems', columns: ['Name'] }
]

/**
 * items.ndjson namespace -> where its display name lives. Measured against the
 * upstream Russian set, which translates 4888 of 4891 names:
 *   AREA 144/145, CAPTURED_BEAST 218/220, DIVINATION_CARD 455/455,
 *   GEM 824/824 (609 base types + 215 transfigured via ActiveSkills),
 *   ITEM 1985/1988, UNIQUE 1259/1259.
 * UNIQUE is the trap from the design doc: `Words.Text` stays English in every
 * language, the translated unique name sits in `Words.Text2`.
 */
export const ITEM_NAME_SOURCES = {
  AREA: [{ table: 'WorldAreas', enColumn: 'Name', tgColumn: 'Name' }],
  CAPTURED_BEAST: [{ table: 'MonsterVarieties', enColumn: 'Name', tgColumn: 'Name' }],
  DIVINATION_CARD: [{ table: 'BaseItemTypes', enColumn: 'Name', tgColumn: 'Name' }],
  GEM: [
    { table: 'BaseItemTypes', enColumn: 'Name', tgColumn: 'Name' },
    { table: 'ActiveSkills', enColumn: 'DisplayedName', tgColumn: 'DisplayedName' }
  ],
  ITEM: [{ table: 'BaseItemTypes', enColumn: 'Name', tgColumn: 'Name' }],
  UNIQUE: [{ table: 'Words', enColumn: 'Text2', tgColumn: 'Text2' }]
}

/** Every table this module can ask for — the export list of the generator. */
export const REQUIRED_TABLES = [...new Set([
  ...Object.values(NAME_SOURCES).map(s => s.table),
  ...WHOLE_NAME_TABLES.map(s => s.table),
  ...Object.values(ITEM_NAME_SOURCES).flat().map(s => s.table),
  'ClientStrings'
])].sort()

// ------------------------------------------------------------------ name maps

/**
 * English value -> Set of target values, paired by row index. The export gives
 * every table twice with identical row count and `_index` order, so the join
 * is the row number.
 */
export function nameMap (tables, table, columns, tgColumns = columns, { expand = true } = {}) {
  const t = tables[table]
  if (!t) throw new Error(`name table missing from the export: ${table}`)
  const map = new Map()
  const n = Math.min(t.en.length, t.tg.length)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < columns.length; c++) {
      const a = t.en[i][columns[c]]
      const b = t.tg[i][tgColumns[c] ?? columns[c]]
      if (!a || !b) continue
      let set = map.get(grammarPlain(a))
      if (!set) map.set(grammarPlain(a), set = new Set())
      // A mod name has one valid surface form per gender/number; a display
      // name has one citation form.
      if (expand) for (const f of grammarForms(b)) set.add(f)
      else set.add(grammarPlain(b))
    }
  }
  return map
}

/**
 * First and last entry of an indexable list, in both languages. APT writes
 * that pair into `advanced` as `name(first-last)` — one bracket per name slot,
 * and the same list the slot itself draws from. Taken column-wise from the
 * first column, which is what reproduces upstream's `Fireball-Mana-Infused
 * Staff` and `Greater Multiple Projectiles-Hallow`.
 */
export function listEnds (tables, table, columns) {
  const t = tables[table]
  if (!t) throw new Error(`name table missing from the export: ${table}`)
  const col = columns[0]
  const pick = rows => {
    const v = rows.map(r => grammarPlain(r[col])).filter(Boolean)
    return [v[0], v[v.length - 1]]
  }
  return { en: pick(t.en), tg: pick(t.tg) }
}

// -------------------------------------------------------------- line index

/** matchKey(English line) -> Set of rendered target lines. */
export function buildLineIndex (blocks, targetLang) {
  const idx = new Map()
  for (const b of blocks) {
    const en = b.langs.get('English')
    const tg = b.langs.get(targetLang)
    if (!en || !tg || en.length !== tg.length) continue
    for (let i = 0; i < en.length; i++) {
      if (en[i].text == null || tg[i].text == null) continue
      const k = matchKey(en[i].text)
      if (!k) continue
      let set = idx.get(k)
      if (!set) idx.set(k, set = new Set())
      set.add(render(tg[i].text))
    }
  }
  return idx
}

/**
 * de->en text pair table for the repair path (design section 5): EVERY target
 * line of every block, mapped back to its English form, not just the ones that
 * made it into the APT skeleton. An unknown German mod line is normalized,
 * looked up here and only THEN searched in GGG's English stat catalogue.
 * Target texts that map to more than one English text are kept with all their
 * candidates — the reader (mod-text-pairs.mjs) rejects ambiguity rather than
 * resolving it.
 */
export function buildTextPairs (blocks, targetLang) {
  const pairs = new Map()
  for (const b of blocks) {
    const en = b.langs.get('English')
    const tg = b.langs.get(targetLang)
    if (!en || !tg || en.length !== tg.length) continue
    for (let i = 0; i < en.length; i++) {
      if (en[i].text == null || tg[i].text == null) continue
      const k = matchKey(tg[i].text)
      const v = matchKey(en[i].text)
      if (!k || !v) continue
      let set = pairs.get(k)
      if (!set) pairs.set(k, set = new Set())
      set.add(v)
    }
  }
  return pairs
}

// --------------------------------------------------------------- templates

/** Replaces the placeholders in `slotIdx` by a slot marker, keeps the rest. */
function markSlots (text, slotIdx) {
  const ph = placeholders(text)
  let out = ''
  let pos = 0
  for (const p of ph) {
    out += text.slice(pos, p.start)
    out += slotIdx.includes(p.idx) ? slotMark(p.idx) : p.sign + '{' + p.idx + '}'
    pos = p.end
  }
  return out + text.slice(pos)
}

/**
 * Description lines with a name slot, turned into a matchable template.
 * Deduplicated: the six `mod_granted_passive_hash*` blocks all carry the very
 * same "Allocates {0}" line, and counting those as competing templates would
 * make every notable ambiguous.
 */
export function buildTemplates (blocks, targetLang, tables) {
  const seen = new Set()
  const out = []
  for (const b of blocks) {
    const en = b.langs.get('English')
    const tg = b.langs.get(targetLang)
    if (!en || !tg || en.length !== tg.length) continue
    for (let i = 0; i < en.length; i++) {
      const e = en[i]
      const t = tg[i]
      if (e.text == null || t.text == null) continue
      const slots = []
      const hre = /([a-z_]+)\s+(\d+)/g
      let hm
      while ((hm = hre.exec(e.handlers || ''))) {
        const src = NAME_SOURCES[hm[1]]
        if (src) slots.push({ idx: Number(hm[2]) - 1, src })
      }
      if (!slots.length) continue
      const idxs = slots.map(s => s.idx)
      const enPat = matchKey(markSlots(e.text, idxs))
      const tgPat = render(markSlots(t.text, idxs))
      if (!enPat || !tgPat) continue

      const segs = enPat.split(SLOT_SPLIT)
      // A template needs literal context on BOTH sides. `"{0}"` alone would
      // match every string in the data set; and a target that is nothing but
      // the slot is a degenerate translation (the block simply shows the bare
      // name), which would compete with the real phrasing for the same English
      // line and make every name of that class ambiguous. Russian has exactly
      // that for "Allocates {0}".
      const literal = segs.filter((_, j) => j % 2 === 0).join('')
      const tgLiteral = tgPat.split(SLOT_SPLIT).filter((_, j) => j % 2 === 0).join('')
      if (segs.length < 3 || literal.trim().length < 4) continue
      // The target side only has to be non-empty — a length threshold would be
      // Latin-centric. Korean writes "Allocates {0}" as "할당 {0}", two
      // characters of literal, and dropping that template would cost all 472
      // notables.
      if (!tgLiteral.trim().length) continue

      const order = []
      let src = '^'
      for (let j = 0; j < segs.length; j++) {
        if (j % 2 === 0) src += escRe(segs[j])
        else { src += '(.+?)'; order.push(Number(segs[j])) }
      }
      src += '$'

      const srcOf = {}
      for (const s of slots) srcOf[s.idx] = s.src
      const key = src + '\u0002' + tgPat + '\u0002' + JSON.stringify(srcOf)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ re: new RegExp(src, 's'), order, tgPat, srcOf })
    }
  }
  // Cache the per-slot name map and bracket pair once per template.
  for (const t of out) {
    t.maps = {}
    t.ends = {}
    for (const [idx, src] of Object.entries(t.srcOf)) {
      t.maps[idx] = nameMap(tables, src.table, src.columns)
      t.ends[idx] = listEnds(tables, src.table, src.columns)
    }
  }
  return out
}

/**
 * ClientStrings entries with exactly one `{0}` become wrapping frames. This is
 * how APT gets texts that are in no description file at all:
 * `InfluenceStatConditionPresenceCelestialBoss`, the cluster jewel's
 * `StatDescripotionTreeExpansionJewelGrantedSmallStat`, the imbued
 * `ItemDisplayBuiltInSupport`. Data driven — every suitable client string is a
 * candidate, none is named in code.
 */
export function buildFrames (tables) {
  const t = tables.ClientStrings
  if (!t) throw new Error('name table missing from the export: ClientStrings')
  const out = []
  const n = Math.min(t.en.length, t.tg.length)
  for (let i = 0; i < n; i++) {
    const a = grammarPlain(t.en[i].Text)
    const b = grammarPlain(t.tg[i].Text)
    if (!a || !b || a.includes('[DNT]')) continue
    const pa = placeholders(a)
    const pb = placeholders(b)
    if (pa.length !== 1 || pb.length !== 1) continue
    const before = a.slice(0, pa[0].start)
    const after = a.slice(pa[0].end)
    if (/[<>{}]/.test(before + after)) continue
    if (!(before + after).trim().length) continue
    out.push({
      id: t.en[i].Id,
      re: new RegExp('^' + escRe(before) + '(.+)' + escRe(after) + '$', 's'),
      enBefore: before,
      enAfter: after,
      tgBefore: b.slice(0, pb[0].start),
      tgAfter: b.slice(pb[0].end),
      // Short frames ("(Tier {0})") match far too much to be let loose on
      // arbitrary text, but they are safe where the captured part is a bare
      // value — that is the only place they get used.
      textual: (before + after).trim().length >= 8
    })
  }
  return out
}

// ---------------------------------------------------------------- resolver

/**
 * Builds the resolver. `resolve(text)` returns
 *   { how, forms }        one or more target forms (several = declension split)
 *   { how, forms: [], ambiguous: true }   found, but not unambiguously
 *   null                  nothing found
 */
export function createResolver ({ blocks, targetLang, tables }) {
  const lineIndex = buildLineIndex(blocks, targetLang)
  const templates = buildTemplates(blocks, targetLang, tables)
  const frames = buildFrames(tables)
  const whole = WHOLE_NAME_TABLES
    .filter(s => tables[s.table])
    .map(s => [s.table, nameMap(tables, s.table, s.columns)])

  function byLine (s) {
    const set = lineIndex.get(matchKey(s))
    if (!set) return null
    // Two different German forms for the same English line means two blocks
    // disagree — that is genuine ambiguity, not a declension split.
    if (set.size > 1) return { how: 'line', forms: [], ambiguous: true }
    return { how: 'line', forms: [...set] }
  }

  function byTemplate (s) {
    const key = matchKey(s)
    const hits = []
    for (const t of templates) {
      const m = t.re.exec(key)
      if (!m) continue
      const filled = []
      let ok = true
      for (let j = 0; j < t.order.length; j++) {
        const idx = t.order[j]
        let raw = m[j + 1]
        let bracket = ''
        // `advanced` carries the list's first/last pair right behind the name:
        // "Absolution(Fireball-Mana-Infused Staff)".
        const ends = t.ends[idx]
        const suffix = `(${ends.en[0]}-${ends.en[1]})`
        if (raw.endsWith(suffix)) {
          raw = raw.slice(0, -suffix.length)
          bracket = `(${ends.tg[0]}-${ends.tg[1]})`
        }
        const cand = t.maps[idx].get(raw)
        if (!cand) { ok = false; break }
        filled.push([idx, [...cand].map(v => v + bracket)])
      }
      if (!ok) continue
      let forms = [t.tgPat]
      for (const [idx, values] of filled) {
        const next = []
        for (const f of forms) for (const v of values) next.push(f.split(slotMark(idx)).join(v))
        forms = next
      }
      hits.push(forms)
      if (hits.length > 1) break
    }
    if (!hits.length) return null
    if (hits.length > 1) return { how: 'template', forms: [], ambiguous: true }
    return { how: 'template', forms: hits[0] }
  }

  function byName (s) {
    const from = []
    const all = new Set()
    for (const [table, map] of whole) {
      const c = map.get(s)
      if (!c) continue
      from.push(table)
      for (const v of c) all.add(v)
    }
    if (!from.length) return null
    return { how: 'name:' + from.join('+'), forms: [...all].sort() }
  }

  function byFrame (s) {
    const hits = []
    for (const f of frames) {
      if (!f.textual) continue
      let inner = null
      let wrap = null
      const m = f.re.exec(s)
      if (m) {
        inner = inside(m[1])
        wrap = x => f.tgBefore + x + f.tgAfter
      } else if (!f.enAfter && f.enBefore && s.includes('\n')) {
        // Prefix frames repeat per line: the cluster jewel enchant writes
        // "Added Small Passive Skills grant: " in front of EVERY line of a two
        // line mod, while the description file carries the two lines as one
        // block. Strip it from all of them, resolve the block, put it back.
        const lines = s.split('\n')
        const stripped = lines.map(l => f.re.exec(l)?.[1])
        if (stripped.every(Boolean)) {
          inner = inside(stripped.join('\n'))
          wrap = x => x.split('\n').map(l => f.tgBefore + l).join('\n')
        }
      }
      if (!inner || inner.ambiguous) continue
      hits.push(inner.forms.map(wrap))
      if (hits.length > 1) break
    }
    if (!hits.length) return null
    if (hits.length > 1) return { how: 'frame', forms: [], ambiguous: true }
    return { how: 'frame', forms: hits[0] }
  }

  /**
   * A frame around a bare value: "Difficulty #", "Tier 3". The captured part
   * carries no letters, so there is nothing to translate — only the frame is.
   */
  function byValueFrame (s) {
    const hits = new Set()
    for (const f of frames) {
      const m = f.re.exec(s)
      if (!m || /\p{L}/u.test(m[1])) continue
      hits.add(f.tgBefore + m[1] + f.tgAfter)
      if (hits.size > 1) break
    }
    if (!hits.size) return null
    // Several client strings with the same literal are fine as long as they
    // produce the same text; different results are ambiguous.
    if (hits.size > 1) return { how: 'valueFrame', forms: [], ambiguous: true }
    return { how: 'valueFrame', forms: [...hits] }
  }

  /**
   * "<name> (<value>)" — an Incursion room with its tier, a Lake reflection
   * with its difficulty. The game puts the brackets in two different places:
   * `IncursionRoomPopupTier` is "(Tier {0})" WITH them, `ItemDisplayLakeRoom-
   * Difficulty` is "Difficulty {0}" and APT adds them. Both are tried.
   */
  function byParen (s) {
    const cut = s.lastIndexOf(' (')
    if (cut < 1 || !s.endsWith(')')) return null
    const head = byName(s.slice(0, cut))
    if (!head || head.ambiguous) return null
    const bracketed = s.slice(cut + 1)
    const inner = bracketed.slice(1, -1)
    const whole = byValueFrame(bracketed)
    const tail = (whole && !whole.ambiguous)
      ? whole
      : wrapParens(inside(inner) ?? byValueFrame(inner))
    if (!tail || tail.ambiguous) return null
    const forms = []
    for (const a of head.forms) for (const b of tail.forms) forms.push(`${a} ${b}`)
    return { how: 'paren', forms }
  }

  const wrapParens = r => (r && !r.ambiguous) ? { ...r, forms: r.forms.map(f => `(${f})`) } : r

  /**
   * Texts that carry a CONCRETE number where the description line has a
   * placeholder — the cluster jewel enchants ("… grant: 12% increased Chaos
   * Damage"). Replace the numbers by `#`, resolve, put them back.
   *
   * Deliberately narrow: only when every number in the text is the SAME, and
   * only when the target form has exactly as many `#`. German word order moves
   * arguments around ("Adds {0} to {1}" -> "Fügt {1} bis {0}"), so re-inserting
   * DIFFERENT numbers positionally could silently swap them. Equal numbers
   * cannot be swapped wrongly.
   */
  function byNumeric (s, base) {
    // A literal sign belongs to the number: the description line writes it as
    // a format (`{0:+d}`) and render() swallows it, so the mask has to as well.
    const NUM = /[+\-]?\d+(?:\.\d+)?/g
    const nums = s.match(NUM)
    if (!nums || !nums.length) return null
    if (new Set(nums).size !== 1) return null
    const masked = s.replace(NUM, '#')
    const r = base(masked)
    if (!r || r.ambiguous) return null
    const forms = []
    for (const f of r.forms) {
      const holes = f.split('#').length - 1
      if (holes !== nums.length) return null
      let i = 0
      forms.push(f.replace(/#/g, () => nums[i++]))
    }
    return { how: 'numeric', forms }
  }

  // Inner texts of a frame are resolved WITHOUT frames — no recursion, so a
  // pathological pair of client strings cannot loop.
  function plain (s) {
    const r = byLine(s)
    if (r && !r.ambiguous) return r
    return byTemplate(s) || byName(s) || r
  }

  function inside (s) {
    const r = plain(s)
    if (r && !r.ambiguous) return r
    return byNumeric(s, plain) || r
  }

  function single (s) {
    const first = byLine(s)
    if (first && !first.ambiguous) {
      // A support gem mod exists TWICE in the game: once as a fixed
      // description line ("Socketed Gems are Supported by Level # Added Fire
      // Damage") and once through the indexable template. In English both
      // render the same, in German they do not — and the client really does
      // show both, depending on which stat the mod carries. Both forms are
      // therefore kept; they inherit the same flags from the same English
      // matcher, so this is a split, not a guess.
      const t = byTemplate(s)
      if (t && !t.ambiguous) {
        const forms = [...new Set([...first.forms, ...t.forms])]
        if (forms.length > first.forms.length) return { how: 'line+template', forms }
      }
      return first
    }
    return byTemplate(s) || byName(s) || byFrame(s) || byParen(s) ||
      byNumeric(s, plain) || first
  }

  /**
   * Last resort for multi-line matchers whose lines come from DIFFERENT
   * description blocks — the cluster jewel enchants that grant two small
   * passives at once. Every line has to resolve on its own and unambiguously;
   * one line short and the whole matcher is dropped.
   */
  function byLines (s) {
    if (!s.includes('\n')) return null
    const parts = s.split('\n').map(l => single(l))
    if (!parts.every(p => p && !p.ambiguous && p.forms.length === 1)) return null
    return { how: 'lines', forms: [parts.map(p => p.forms[0]).join('\n')] }
  }

  function resolve (s) {
    const r = single(s)
    if (r && !r.ambiguous) return r
    return byLines(s) || r
  }

  return { resolve, lineIndex, templates, frames }
}

// ------------------------------------------------------------------- stats

/** APT's own pseudo entries: the matcher string ends in a space. */
export const isPseudoMatcher = m => / $/.test(m.string)

/**
 * Builds the localized stats.ndjson lines.
 *
 * The English grouping (`{stats:[...]}`) and the order within it are kept
 * exactly — the group is a `resolve` strategy, not a display detail.
 *
 * @param enLines  parsed English stats.ndjson lines (groups NOT flattened)
 * @param resolve  from createResolver
 * @param pseudo   Map<English matcher string, target string> from the hand table
 */
export function deriveStats (enLines, resolve, pseudo) {
  const report = {
    matchers: 0,
    pseudo: 0,
    byStrategy: new Map(),
    ambiguous: [],
    misses: [],
    pseudoMisses: [],
    collapsed: [],
    collapseConflicts: [],
    split: 0,
    advancedTotal: 0,
    advancedMissing: []
  }
  const bump = k => report.byStrategy.set(k, (report.byStrategy.get(k) || 0) + 1)

  const deLines = enLines.map(line => {
    const stats = line.stats ? line.stats : [line]
    const out = stats.map(stat => {
      const matchers = []
      const byString = new Map()
      for (const m of stat.matchers) {
        report.matchers++
        let forms = null
        if (isPseudoMatcher(m)) {
          report.pseudo++
          const t = pseudo.get(m.string)
          if (t) { forms = [t]; bump('pseudo') } else { report.pseudoMisses.push(m.string) }
        } else {
          const r = resolve(m.string)
          if (!r) { report.misses.push({ ref: stat.ref, string: m.string }) } else if (r.ambiguous) {
            report.ambiguous.push({ ref: stat.ref, string: m.string, how: r.how })
            bump(r.how + '(ambiguous)')
          } else {
            forms = r.forms
            bump(r.how.replace(/:.*/, ''))
            if (forms.length > 1) report.split += forms.length - 1
          }
        }
        if (m.advanced != null) report.advancedTotal++
        let advForms = null
        if (forms && m.advanced != null) {
          const ra = resolve(m.advanced)
          if (ra && !ra.ambiguous) advForms = ra.forms
          else report.advancedMissing.push({ ref: stat.ref, advanced: m.advanced })
        }
        if (!forms) continue

        for (let i = 0; i < forms.length; i++) {
          // Inherit the flags of exactly this English matcher, verbatim.
          const copy = { ...m, string: forms[i] }
          if (m.advanced != null) {
            if (advForms) copy.advanced = advForms[Math.min(i, advForms.length - 1)]
            else delete copy.advanced
          }
          const prev = byString.get(copy.string)
          if (prev) {
            // Collapse: two English matchers land on the same target string.
            // Same flags -> one matcher. Different flags -> neither, because
            // which one wins would be pure chance.
            if (sameFlags(prev, copy)) { report.collapsed.push({ ref: stat.ref, string: copy.string }) } else {
              report.collapseConflicts.push({ ref: stat.ref, string: copy.string })
              byString.set(copy.string, null)
            }
            continue
          }
          byString.set(copy.string, copy)
          matchers.push(copy)
        }
      }
      const kept = matchers.filter(m => byString.get(m.string) === m)
      return { ...stat, matchers: kept }
    })
    return line.stats ? { ...line, stats: out } : out[0]
  })
  return { lines: deLines, report }
}

const flagKey = m => `${m.value ?? ''}|${m.negate ? 1 : 0}`
const sameFlags = (a, b) => flagKey(a) === flagKey(b)

// ------------------------------------------------------------------- items

/**
 * Builds the localized items.ndjson lines — `name`, and nothing else.
 *
 * A NAMESPACE THIS TABLE DOES NOT KNOW IS THE QUIETEST GAP IN THE WHOLE SET, and
 * until 2026-08-18 it was silent (docs/bugs.md B24). `ITEM_NAME_SOURCES` says
 * where each namespace's display name lives; upstream adding a new one — a new
 * kind of tradeable thing, which happens at league starts — means
 * `maps[item.namespace]` is undefined and every line of it keeps its English
 * name. Nothing downstream notices: the LINE exists, its `refName` matches, the
 * skew view compares refs and finds none missing, and the coverage checks are
 * about stats. The only trace was one entry per line in `report.kept`, which a
 * normal run has hundreds of.
 *
 * So the namespaces themselves are counted and handed back as
 * `report.unknownNamespaces`. The lines still keep their English name — an
 * English name is not a wrong price, and refusing a whole run over one new
 * namespace would throw away every name it DID translate — but the run says
 * which namespace and how many lines, and the generator turns that into a named
 * warning and into `build-info.json` (see lang-data-gen.mjs).
 */
export function deriveItems (enLines, tables) {
  const maps = {}
  for (const [ns, sources] of Object.entries(ITEM_NAME_SOURCES)) {
    maps[ns] = sources
      .filter(s => tables[s.table])
      .map(s => nameMap(tables, s.table, [s.enColumn], [s.tgColumn], { expand: false }))
  }
  const report = { total: 0, translated: 0, kept: [], ambiguous: [], unknownNamespaces: [] }
  // namespace -> how many lines carry it. Only for namespaces ITEM_NAME_SOURCES
  // has no entry for at all; a namespace whose TABLE is missing from this export
  // is a different fault and shows up as an empty source list, not as an unknown
  // name space.
  const unknown = new Map()
  const lines = enLines.map(item => {
    report.total++
    const sources = maps[item.namespace]
    if (!sources) unknown.set(item.namespace, (unknown.get(item.namespace) || 0) + 1)
    let name = null
    for (const m of sources ?? []) {
      const c = m.get(item.refName)
      if (!c) continue
      if (c.size > 1) { report.ambiguous.push(`${item.namespace}::${item.refName}`); break }
      name = [...c][0]
      break
    }
    if (name == null) {
      report.kept.push(`${item.namespace}::${item.refName}`)
      return { ...item }
    }
    report.translated++
    return { ...item, name }
  })
  report.unknownNamespaces = [...unknown]
    .map(([namespace, lines]) => ({ namespace, lines }))
    .sort((a, b) => b.lines - a.lines || a.namespace.localeCompare(b.namespace))
  return { lines, report }
}

// -------------------------------------------------------------- validation

const flatten = lines => lines.flatMap(l => l.stats ? l.stats : [l])

/**
 * How much of what the localized set ALREADY COVERED may fall away in one
 * regeneration before the run is refused.
 *
 * ONE PER CENT, and it is the same number the check has carried since it was
 * written — what changed is the population it is measured against, see the
 * coverage section of validate() below. Against the previously covered refs it
 * is the tighter reading of the two: that denominator does not grow when
 * English does, so a derivation that breaks trips the bar at the same absolute
 * size of damage however far upstream has run ahead.
 *
 * Configurable as POE_LANG_MAX_COVERAGE_LOSS_RATIO (numeric-settings.mjs).
 */
export const DEFAULT_MAX_COVERAGE_LOSS_RATIO = 0.01

/**
 * The checks from the design doc. Returns { errors, warnings, counts }.
 * A run with a non-empty `errors` writes NOTHING.
 *
 * `previousStats` are the parsed stat lines of the set this run would REPLACE —
 * the live localized data, not a guess. Without it there is no baseline and the
 * coverage bar falls back to the English set as a whole (a first build).
 */
export function validate ({
  enStats,
  deStats,
  enItems,
  deItems,
  previousStats = null,
  maxLossRatio = DEFAULT_MAX_COVERAGE_LOSS_RATIO
}) {
  const errors = []
  const warnings = []
  const en = flatten(enStats)
  const de = flatten(deStats)

  // 1. every target ref exists in English — trivially true for the replacement
  //    approach, kept as a regression barrier: if it ever fails, the generator
  //    left the "replace, don't rebuild" path.
  const enRefs = new Map()
  for (const s of en) enRefs.set(s.ref, (enRefs.get(s.ref) || 0) + 1)
  for (const s of de) if (!enRefs.has(s.ref)) errors.push(`target ref not in the English set: ${JSON.stringify(s.ref)}`)

  // 2. THE coverage check: every English ref needs at least one matcher.
  const deByRef = new Map()
  for (const s of de) {
    let a = deByRef.get(s.ref)
    if (!a) deByRef.set(s.ref, a = [])
    a.push(s)
  }
  const uncovered = []
  for (const s of en) {
    const cand = deByRef.get(s.ref) ?? []
    if (!cand.some(x => x.matchers.length > 0)) uncovered.push(s.ref)
  }
  // WHICH GAP IS A REASON TO THROW THE RUN AWAY — and this is the half that was
  // wrong until 2026-08-18 (docs/bugs.md B23).
  //
  // The bar used to be `uncovered / every English ref`, and it fires hardest in
  // exactly the situation where refusing helps least: English comes from an
  // upstream that ships on its own schedule, the localized side is derived from
  // the game data of a patch, and when upstream runs ahead the newly added stats
  // have no target text ANYWHERE to be derived from. Refusing to write then
  // keeps the PREVIOUS set live — a set that does not carry those refs at all.
  // A ref with an empty matcher list and a ref that is missing outright are the
  // same thing to every reader of this data: no match. So the refusal bought
  // nothing and cost every stat the run WOULD have resolved.
  //
  // The question the gate has to ask is therefore not "how complete is this
  // set" but "did this run LOSE something the live set already had". Two
  // populations, and only one of them can be repaired by not writing:
  //
  //   regressed  refs the previous localized set covered and this one does not.
  //              That is a broken derivation, and it is what the bar guards.
  //   newGaps    refs the previous set did not cover either — new material, or
  //              an old gap that is still a gap. Unbounded ON PURPOSE: keeping
  //              the old set does not close a single one of them.
  //
  // Completeness is not dropped, it is moved to where it belongs: it is
  // REPORTED here (warnings + counts, listed in full by the caller) and watched
  // continuously by lang-skew.mjs against the set actually being served.
  let baselineCovered = null
  let regressedRefs = uncovered
  let newGapRefs = []
  if (previousStats) {
    const prevCovered = new Set()
    for (const s of flatten(previousStats)) {
      if (s?.ref && Array.isArray(s.matchers) && s.matchers.length) prevCovered.add(s.ref)
    }
    // The population at risk is what the previous set covered AND English still
    // has. A ref upstream deleted since cannot be lost by this run, so counting
    // it would shrink the bar for a reason that has nothing to do with us.
    const seen = new Set()
    baselineCovered = 0
    for (const s of en) {
      if (seen.has(s.ref)) continue
      seen.add(s.ref)
      if (prevCovered.has(s.ref)) baselineCovered++
    }
    regressedRefs = uncovered.filter(r => prevCovered.has(r))
    newGapRefs = uncovered.filter(r => !prevCovered.has(r))
  }
  const lossBase = previousStats ? baselineCovered : en.length
  const pct = (n, base) => (base > 0 ? (n / base * 100).toFixed(2) : '0.00')
  const allowed = `allowed ${(maxLossRatio * 100).toFixed(2)} %`
  if (lossBase && regressedRefs.length > lossBase * maxLossRatio) {
    errors.push(previousStats
      ? `coverage regressed: ${regressedRefs.length} of ${lossBase} refs the previous localized set covered ` +
        `have no matcher any more (${pct(regressedRefs.length, lossBase)} %, ${allowed})`
      : `coverage gap too large: ${uncovered.length} of ${en.length} refs without a matcher ` +
        `(${pct(uncovered.length, en.length)} %, ${allowed})`)
  } else if (regressedRefs.length && previousStats) {
    warnings.push(
      `${regressedRefs.length} of ${lossBase} refs the previous localized set covered have no matcher any more ` +
      `(${pct(regressedRefs.length, lossBase)} %, under the ${allowed.slice(8)} bar — listed above)`
    )
  }
  if (newGapRefs.length) {
    warnings.push(
      `${newGapRefs.length} of ${en.length} English refs have no target matcher and the previous set had none ` +
      `either (${pct(newGapRefs.length, en.length)} %) — not a regression, and keeping the old set would not ` +
      'close a single one of them'
    )
  }

  // 3. an English matcher with `advanced` needs a target one with `advanced`.
  let advMissing = 0
  for (let i = 0; i < Math.min(en.length, de.length); i++) {
    if (en[i].ref !== de[i].ref) { errors.push(`stat order diverged at ${i}: ${en[i].ref} vs ${de[i].ref}`); break }
    const wantAdv = en[i].matchers.some(m => m.advanced != null)
    const hasAdv = de[i].matchers.some(m => m.advanced != null)
    if (wantAdv && !hasAdv && de[i].matchers.length) advMissing++
  }

  // 4. length deviations must be a split or a collapse — never new forms out
  //    of nowhere. Every target matcher has to come from exactly one English
  //    one, which the derivation guarantees structurally; what is checkable
  //    here is that nothing got ADDED beyond the split.
  let longer = 0
  let shorter = 0
  // ...and how many of the shorter ones went all the way to NOTHING. Without
  // that split `shorter` reads like a second, independent finding while it is
  // mostly the coverage gap counted again: a stat with no matcher at all is
  // necessarily shorter than its English original. The remainder — shorter but
  // still covered — is the only part of this number that says something the
  // coverage line does not.
  let shorterToZero = 0
  for (let i = 0; i < Math.min(en.length, de.length); i++) {
    const a = en[i].matchers.length
    const b = de[i].matchers.length
    if (b > a) longer++
    else if (b < a) { shorter++; if (b === 0) shorterToZero++ }
  }

  // 5. no two target forms with the same string but different flags.
  for (const s of de) {
    const seen = new Map()
    for (const m of s.matchers) {
      const k = flagKey(m)
      if (seen.has(m.string) && seen.get(m.string) !== k) {
        errors.push(`two forms with the same string and different flags: ${JSON.stringify(s.ref)} / ${JSON.stringify(m.string)}`)
      }
      seen.set(m.string, k)
    }
  }

  // 6. namespace counts, items.
  const nsCount = lines => {
    const m = {}
    for (const i of lines) m[i.namespace] = (m[i.namespace] || 0) + 1
    return m
  }
  const nsEn = nsCount(enItems)
  const nsDe = nsCount(deItems)
  for (const ns of new Set([...Object.keys(nsEn), ...Object.keys(nsDe)])) {
    if (nsEn[ns] !== nsDe[ns]) errors.push(`namespace count differs, ${ns}: ${nsEn[ns] || 0} -> ${nsDe[ns] || 0}`)
  }
  if (enItems.length !== deItems.length) errors.push(`item line count differs: ${enItems.length} -> ${deItems.length}`)
  for (let i = 0; i < Math.min(enItems.length, deItems.length); i++) {
    if (enItems[i].refName !== deItems[i].refName) {
      errors.push(`refName diverged at item ${i}: ${enItems[i].refName} vs ${deItems[i].refName}`)
      break
    }
  }

  return {
    errors,
    warnings,
    counts: {
      statsEn: en.length,
      statsDe: de.length,
      uncovered: uncovered.length,
      uncoveredRefs: uncovered,
      // The two halves of `uncovered`. `baselineCovered` is null when there was
      // no previous set to compare against — then `regressedRefs` IS `uncovered`
      // and the bar was measured against English, see above.
      baselineCovered,
      regressedRefs,
      newGapRefs,
      covered: en.length - uncovered.length,
      advMissing,
      longer,
      shorter,
      shorterToZero,
      namespaces: nsDe
    }
  }
}
