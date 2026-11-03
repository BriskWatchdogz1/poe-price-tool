// backend/v2/whisper.mjs
// Trade whispers as the trade site writes them, read back into fields. Pure:
// no I/O, no prices, no names of players (the daemon never sends one).
//
// THE TEMPLATES ARE DATA, NOT CODE PATHS: a new language or a reworded
// template after a patch is one more entry below, and whisper.test.mjs runs
// every entry against its sample. Updating the server updates every daemon at
// once. The English ones were checked against a real Client.txt in shape
// (counts only, 2026-11-03): 1,123 single whispers, 52 bulk; the English single
// template keeps a one-word trade tag and plain quotes, the shape of those
// lines. Every other language (German, French, Russian, Spanish, Portuguese,
// single and bulk) is GGG's trade-site template as SlimTrade reads it
// (LangRegex.java in https://github.com/zmilla93/SlimTrade), adapted for this
// parser (licence notice below), not seen in a real log. As in SlimTrade: where
// it allows two forms, both are read (the German league with or without quotes,
// the Spanish left with or without a space after 'izquierda'); a single
// whisper's listed currency may be several words ('5 Orbe du chaos'; a name no
// lookup knows ends as 'unknown-currency' or 'no-language-data', item and
// position kept); a backslash before the quotes around the tab name is read and
// dropped (\"Sale\" -> Sale; SlimTrade reads one before the opening quote).
//
// SlimTrade licence (the patterns above are adapted from its LangRegex.java):
//   MIT License
//
//   Copyright (c) 2020 zmilla93
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
//
// The bulk templates (but the German one) have no closing mark after the
// league: all 52 real English ones end in ' in <league>' (none with a '.'), and
// league names contain spaces (Hardcore …). So they return the REST after the
// league word, and splitLeague() cuts it against the user's league. The German
// bulk template closes its league with '-Liga kaufen' and returns league and
// extraLen like a single one. Text after the closing bracket is returned as its
// LENGTH only (extraLen, without surrounding blanks); the daemon shows it from
// its own copy, so a buyer's free text is never kept here.
export const WHISPER_TEMPLATES = [
  { id: 'en-single', lang: 'en', kind: 'single',
    re: /^Hi, I would like to buy your (?<item>.+?) listed for (?<amount>\d+(?:[.,]\d+)?) (?<tag>\S+) in (?<league>.+?) \(stash tab "(?<tab>[^"]*)"; position: left (?<left>\d+), top (?<top>\d+)\)(?<extra>.*)$/s },
  { id: 'en-single-unpriced', lang: 'en', kind: 'unpriced-listing',
    // item GREEDY: a name with ' in ' ('Lost in the Pit') must not cut the league
    re: /^Hi, I would like to buy your (?<item>.+) in (?<league>[^(]+?) \(stash tab "(?<tab>[^"]*)"; position: left (?<left>\d+), top (?<top>\d+)\)(?<extra>.*)$/s },
  { id: 'en-bulk', lang: 'en', kind: 'bulk',
    re: /^Hi, I'd like to buy your (?<qty>\d+(?:[.,]\d+)?) (?<item>.+?) for my (?<amount>\d+(?:[.,]\d+)?) (?<currency>.+?) in (?<rest>.+)$/s },
  { id: 'de-single', lang: 'de', kind: 'single',
    re: /^Hi, ich möchte '(?<item>.+?)' zum angebotenen Preis von (?<amount>\d+(?:[.,]\d+)?) (?<tag>.+?) in der '?(?<league>.+?)'?-Liga kaufen \(Truhenfach \\?"(?<tab>[^"]*?)\\?"; Position: (?<left>\d+) von links, (?<top>\d+) von oben\)(?<extra>.*)$/s },
  { id: 'de-bulk', lang: 'de', kind: 'bulk',
    re: /^Hi, ich möchte '(?<qty>\d+(?:[.,]\d+)?) (?<item>.+?)' zum angebotenen Preis von '(?<amount>\d+(?:[.,]\d+)?) (?<currency>.+?)' in der '?(?<league>.+?)'?-Liga kaufen(?<extra>.*)$/s },
  { id: 'fr-single', lang: 'fr', kind: 'single',
    re: /^Bonjour, je souhaiterais t'acheter (?<item>.+?) pour (?<amount>\d+(?:[.,]\d+)?) (?<tag>.+?) dans la ligue (?<league>.+?) \(onglet de réserve \\?"(?<tab>[^"]*?)\\?" ; (?<left>\d+)e en partant de la gauche, (?<top>\d+)e en partant du haut\)(?<extra>.*)$/s },
  { id: 'fr-bulk', lang: 'fr', kind: 'bulk',
    re: /^Bonjour, je voudrais t'acheter (?<qty>\d+(?:[.,]\d+)?) (?<item>.+?) contre (?<amount>\d+(?:[.,]\d+)?) (?<currency>.+?) dans la ligue (?<rest>.+)$/s },
  { id: 'ru-single', lang: 'ru', kind: 'single',
    re: /^Здравствуйте, хочу купить у вас (?<item>.+?) за (?<amount>\d+(?:[.,]\d+)?) (?<tag>.+?) в лиге (?<league>.+?) \(секция \\?"(?<tab>[^"]*?)\\?"; позиция: (?<left>\d+) столбец, (?<top>\d+) ряд\)(?<extra>.*)$/s },
  { id: 'ru-bulk', lang: 'ru', kind: 'bulk',
    re: /^Здравствуйте, хочу купить у вас (?<qty>\d+(?:[.,]\d+)?) (?<item>.+?) за (?<amount>\d+(?:[.,]\d+)?) (?<currency>.+?) в лиге (?<rest>.+)$/s },
  { id: 'es-single', lang: 'es', kind: 'single',
    re: /^Hola, quisiera comprar tu (?<item>.+?) listado por (?<amount>\d+(?:[.,]\d+)?) (?<tag>.+?) en (?<league>.+?) \(pestaña de alijo \\?"(?<tab>[^"]*?)\\?"; posición: izquierda ?(?<left>\d+), arriba (?<top>\d+)\)(?<extra>.*)$/s },
  { id: 'es-bulk', lang: 'es', kind: 'bulk',
    re: /^Hola, me gustaría comprar tu\(s\) (?<qty>\d+(?:[.,]\d+)?) (?<item>.+?) por mi (?<amount>\d+(?:[.,]\d+)?) (?<currency>.+?) en (?<rest>.+)$/s },
  { id: 'pt-single', lang: 'pt', kind: 'single',
    re: /^Olá, eu gostaria de comprar o seu item (?<item>.+?) listado por (?<amount>\d+(?:[.,]\d+)?) (?<tag>.+?) na (?<league>.+?) \(aba do baú: \\?"(?<tab>[^"]*?)\\?"; posição: esquerda (?<left>\d+), topo (?<top>\d+)\)(?<extra>.*)$/s },
  { id: 'pt-bulk', lang: 'pt', kind: 'bulk',
    re: /^Olá, eu gostaria de comprar seu\(s\) (?<qty>\d+(?:[.,]\d+)?) (?<item>.+?) pelo\(s\) meu\(s\) (?<amount>\d+(?:[.,]\d+)?) (?<currency>.+?) na (?<rest>.+)$/s }
]

// Longer than any whisper the server accepts (2000 characters, see
// whisper-price.mjs); the cap keeps the lazy patterns above from ever walking
// a huge text.
const MAX_TEXT = 4000
const MAX_NUMBER = 1e9

// '1,5' -> 1.5 (a comma inside a number is a decimal); above MAX_NUMBER or not
// a number -> null.
function num (s) {
  if (s == null) return null
  const n = Number(String(s).replace(',', '.'))
  return Number.isFinite(n) && n >= 0 && n <= MAX_NUMBER ? n : null
}

const extraLenOf = s => String(s || '').trim().length

// -> { template, lang, kind, item, qty, amount, tag | currency, league, tab, left,
//      top, extraLen } or null; bulk: `rest` instead of league and extraLen,
//      but league and extraLen for a template that closes its league (de-bulk).
// A comma inside a number is a decimal ('1,5' -> 1.5); numbers above 1e9 ->
// null. Never throws (also not on '' or 10 KB of text).
export function parseWhisper (body, templates = WHISPER_TEMPLATES) {
  if (typeof body !== 'string' || !body || body.length > MAX_TEXT) return null
  for (const t of templates) {
    let m
    try { m = t.re.exec(body) } catch { m = null }
    if (!m) continue
    const g = m.groups || {}
    const out = { template: t.id, lang: t.lang, kind: t.kind, item: g.item }
    if (t.kind === 'bulk') {
      out.qty = num(g.qty)
      out.amount = num(g.amount)
      out.currency = g.currency
      if (g.league != null) {
        // A bulk template that closes its league (German): the league and the
        // length of what follows; an older closing '.' is no addition.
        out.league = g.league
        out.extraLen = extraLenOf(String(g.extra || '').replace(/^\s*\./, ''))
      } else {
        out.rest = g.rest
      }
      if (out.qty == null || out.qty === 0 || out.amount == null) return null
      return out
    }
    if (t.kind === 'single') {
      out.amount = num(g.amount)
      out.tag = g.tag
      if (out.amount == null) return null
    }
    out.league = g.league
    out.tab = g.tab
    out.left = num(g.left)
    out.top = num(g.top)
    out.extraLen = extraLenOf(g.extra)
    if (out.left == null || out.top == null) return null
    return out
  }
  return null
}

// The rest of a bulk whisper against the user's league: { league, extraLen }
// when rest IS the league or starts with it plus ' ' or '.', else null (another
// league, or one that cannot be told apart -> 'other-league'; the entry then
// shows rest cut to 40 characters). An older template closed with a '.', which
// is no addition of the buyer's.
export function splitLeague (rest, league) {
  if (typeof rest !== 'string' || typeof league !== 'string' || !league) return null
  if (rest === league) return { league, extraLen: 0 }
  if (!rest.startsWith(league)) return null
  const after = rest.slice(league.length)
  if (after[0] !== ' ' && after[0] !== '.') return null
  return { league, extraLen: extraLenOf(after.replace(/^\./, '')) }
}
