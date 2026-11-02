// Parser and text renderer for GGG's Metadata/StatDescriptions/*.txt.
//
// Those files are the ONLY place that pairs an English mod line with its
// translation: every file carries all languages at once, the English block
// first and one `lang "German"` block per translation. Gate 0-5 of the design
// established the property everything else rests on — line i of the German
// block is line i of the English block, same conditions, same handlers, same
// count (15 034 blocks, zero length deviations across all 45 files).
//
// Everything here is pure: text in, data out. No fs, no network — so the tests
// can drive it from a few hundred bytes of fixture instead of the 51 MB of
// real game data. The file reading lives in lang-data-gen.mjs.
//
// Grammar (indentation defined):
//   description
//   \t<idCount> <id1> ... <idN>
//   \t<lineCount>
//   \t\t<conditions> "<text>" <handlers...>      (lineCount times)
//   [\tlang "<Language>"  +  \t<lineCount>  +  \t\t...]*

/** Splits a description line into conditions, quoted text and handlers. */
export function splitDescLine (raw) {
  const s = String(raw).replace(/^\t\t/, '')
  const q1 = s.indexOf('"')
  if (q1 === -1) return null
  // Closing quote: the last unescaped one on the line.
  let q2 = -1
  for (let i = s.length - 1; i > q1; i--) {
    if (s[i] === '"' && s[i - 1] !== '\\') { q2 = i; break }
  }
  if (q2 === -1) return null
  return {
    cond: s.slice(0, q1).trim(),
    text: s.slice(q1 + 1, q2),
    handlers: s.slice(q2 + 1).trim()
  }
}

/**
 * Parses one *_stat_descriptions.txt into blocks.
 * Each block: { ids: string[], langs: Map<language, row[]> }, the English rows
 * under the key 'English'.
 */
export function parseStatDescriptions (text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/)
  const blocks = []
  let i = 0
  const N = lines.length
  while (i < N) {
    if (lines[i] !== 'description') { i++; continue }
    i++
    const idLine = (lines[i] ?? '').replace(/^\t/, '')
    i++
    const idParts = idLine.split(/\s+/).filter(Boolean)
    const nIds = Number(idParts[0])
    const ids = Number.isFinite(nIds) ? idParts.slice(1, 1 + nIds) : idParts.slice(1)

    const langs = new Map()
    let lang = 'English'
    while (i < N) {
      const cur = lines[i]
      if (cur === '') { i++; continue }
      if (!/^\t/.test(cur)) break                        // next description / no_description
      const lm = /^\tlang\s+"([^"]+)"\s*$/.exec(cur)
      if (lm) { lang = lm[1]; i++; continue }
      const cm = /^\t(\d+)\s*$/.exec(cur)
      if (!cm) { i++; continue }
      const n = Number(cm[1]); i++
      const rows = []
      for (let k = 0; k < n && i < N; k++, i++) {
        const p = splitDescLine(lines[i])
        rows.push(p ?? { cond: null, text: null, handlers: null })
      }
      langs.set(lang, rows)
    }
    blocks.push({ ids, langs })
  }
  return blocks
}

// --------------------------------------------------------------- placeholders

/**
 * Every `{n}` / `{n:fmt}` / `{}` in a description text, in order, with the
 * argument index resolved (empty braces auto-number). A leading `+`/`-` right
 * in front of the brace belongs to the placeholder: the game writes the sign
 * either as a format (`{0:+d}`) or literally (`+{0}`), and APT's matcher
 * strings carry NEITHER — the `#` swallows the sign in both spellings. Getting
 * that wrong was the single biggest error source while this was developed.
 */
export function placeholders (text) {
  const out = []
  let auto = 0
  const re = /([+\-]?)\{(\d*)(?::([^}]*))?\}/g
  let m
  while ((m = re.exec(text))) {
    const idx = m[2] === '' ? auto++ : Number(m[2])
    out.push({ start: m.index, end: re.lastIndex, idx, sign: m[1] })
  }
  return out
}

/** `{...}` (with an optional literal sign in front) becomes `#`. */
export const renderPlaceholders = s => s
  .replace(/[+\-]?\{(\d*)(?::([^}]*))?\}/g, '#')

/** `\n` in the game text is a real line break; APT keeps it. */
export const unescapeNewlines = s => s.replace(/\\n/g, '\n')

/** GGG's alternative syntax `[shown|actual]` resp. `[word]`. */
export const pickBracket = (s, side = 'right') =>
  s.replace(/\[([^\]]*)\]/g, (_, inner) => {
    const p = inner.split('|')
    return p.length === 1 ? p[0] : (side === 'left' ? p[0] : p[p.length - 1])
  })

/**
 * render(text) — the form APT really ships. Character exact, it ends up in the
 * data set.
 */
export function render (s, opt = {}) {
  if (s == null) return null
  const brackets = opt.brackets === undefined ? 'right' : opt.brackets
  let t = unescapeNewlines(String(s))
  t = renderPlaceholders(t)
  if (brackets) t = pickBracket(t, brackets)
  return t
}

// ------------------------------------------------------------ grammar markup

/**
 * Localized name tables carry the target language's grammar as inline markup:
 *   German  `<if:MS>{Rüstiger}<elif:FS>{Rüstige}<elif:NS>{Rüstiges}…`
 *   Russian `<if:gen>{Академии}<else>{Академия}`
 * 4714 German `Mods.Name` values, 524 `Words.Text2`, 6 `ClientStrings`; the
 * English tables have exactly one. Which form the client shows depends on the
 * gender and number of the item it sits on — so a MOD NAME genuinely has
 * several valid surface forms and all of them belong in the matcher list
 * (upstream's Russian set carries exactly the four for "Catarina's Veiled"),
 * while an ITEM NAME needs the one citation form.
 *
 * Returns every distinct full string the markup can produce, in the order the
 * branches appear.
 */
export function grammarForms (text) {
  if (text == null) return []
  const s = String(text)
  const start = s.indexOf('<if:')
  if (start === -1) return [s]
  const alts = []
  let i = start
  const head = s.slice(0, start)
  while (i < s.length) {
    const m = /^(<if:[^>]*>|<elif:[^>]*>|<else>)/.exec(s.slice(i))
    if (!m) break
    i += m[0].length
    if (s[i] !== '{') break
    let depth = 0
    let j = i
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++
      else if (s[j] === '}') { depth--; if (depth === 0) break }
    }
    if (depth !== 0) break
    let inner = s.slice(i + 1, j)
    // `{{Synthetisierter}}` — one extra layer of braces in some entries.
    if (inner.startsWith('{') && inner.endsWith('}')) inner = inner.slice(1, -1)
    alts.push({ text: inner, isElse: m[1] === '<else>' })
    i = j + 1
  }
  if (!alts.length) return [s]
  const tails = grammarForms(s.slice(i))
  const out = []
  for (const a of alts) for (const t of tails) out.push(head + a.text + t)
  return [...new Set(out)]
}

/**
 * The one citation form of a marked-up name — what goes into `items.ndjson`.
 * `<else>` is the neutral branch where the language has one (Russian's
 * nominative against the genitive); otherwise the first branch.
 */
export function grammarPlain (text) {
  if (text == null) return text
  const s = String(text)
  if (!s.includes('<if:')) return s
  const start = s.indexOf('<if:')
  const head = s.slice(0, start)
  let i = start
  const alts = []
  while (i < s.length) {
    const m = /^(<if:[^>]*>|<elif:[^>]*>|<else>)/.exec(s.slice(i))
    if (!m) break
    i += m[0].length
    if (s[i] !== '{') break
    let depth = 0
    let j = i
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++
      else if (s[j] === '}') { depth--; if (depth === 0) break }
    }
    if (depth !== 0) break
    let inner = s.slice(i + 1, j)
    if (inner.startsWith('{') && inner.endsWith('}')) inner = inner.slice(1, -1)
    alts.push({ text: inner, isElse: m[1] === '<else>' })
    i = j + 1
  }
  if (!alts.length) return s
  const pick = alts.find(a => a.isElse) ?? alts[0]
  return head + pick.text + grammarPlain(s.slice(i))
}

/**
 * matchKey(text) — lookup key only. May flatten differences that do not
 * survive translation anyway (where the line break sits). NEVER written out.
 */
export function matchKey (s, opt = {}) {
  const r = render(s, opt)
  if (r == null) return null
  return r.replace(/\s+/g, ' ').trim()
}
