// The trade site's whisper templates (whisper.mjs): every entry reads its own
// sample, people's additions are tolerated, and nothing here ever throws.
// The English samples follow the shape counted in a real Client.txt. The
// samples of every other language follow SlimTrade's patterns (LangRegex.java,
// MIT, (c) 2020 zmilla93), not a real log: the item names in them are made up
// for the test, the template wording around them is SlimTrade's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WHISPER_TEMPLATES, parseWhisper, splitLeague } from './whisper.mjs'

const EN_SINGLE = 'Hi, I would like to buy your Tabula Rasa, Simple Robe listed for 12 chaos in Mercenaries (stash tab "Sale"; position: left 5, top 3)'
const EN_BULK = "Hi, I'd like to buy your 10 Orb of Alchemy for my 1 Divine Orb in Mercenaries"
const EN_UNPRICED = 'Hi, I would like to buy your Lost in the Pit in Mercenaries (stash tab "S"; position: left 1, top 2)'
const DE_SINGLE = "Hi, ich möchte 'Tabula Rasa, Einfaches Gewand' zum angebotenen Preis von 1,5 divine in der 'Mercenaries'-Liga kaufen (Truhenfach \"Verkauf\"; Position: 3 von links, 4 von oben)"
const DE_BULK = "Hi, ich möchte '10 Alchemie-Sphäre' zum angebotenen Preis von '1 Göttliche Sphäre' in der 'Hardcore Mercenaries'-Liga kaufen"
const FR_SINGLE = "Bonjour, je souhaiterais t'acheter Tabula Rasa, Robe simple pour 12 chaos dans la ligue Mercenaries (onglet de réserve \"Vente\" ; 5e en partant de la gauche, 3e en partant du haut)"
const FR_BULK = "Bonjour, je voudrais t'acheter 10 Orbe d'alchimie contre 1 Orbe divin dans la ligue Mercenaries"
const RU_SINGLE = 'Здравствуйте, хочу купить у вас Табула Раса, Простая роба за 12 chaos в лиге Mercenaries (секция "Продажа"; позиция: 5 столбец, 3 ряд)'
const RU_BULK = 'Здравствуйте, хочу купить у вас 10 Сфера алхимии за 1 Божественная сфера в лиге Mercenaries'
const ES_SINGLE = 'Hola, quisiera comprar tu Tabula Rasa, Túnica simple listado por 12 chaos en Mercenaries (pestaña de alijo "Venta"; posición: izquierda5, arriba 3)'
const ES_BULK = 'Hola, me gustaría comprar tu(s) 10 Orbe de alquimia por mi 1 Orbe divino en Mercenaries'
const PT_SINGLE = 'Olá, eu gostaria de comprar o seu item Tabula Rasa, Túnica Simples listado por 12 chaos na Mercenaries (aba do baú: "Venda"; posição: esquerda 5, topo 3)'
const PT_BULK = 'Olá, eu gostaria de comprar seu(s) 10 Orbe de Alquimia pelo(s) meu(s) 1 Orbe Divino na Mercenaries'

test('every template reads its own sample', () => {
  const s = parseWhisper(EN_SINGLE)
  assert.equal(s.template, 'en-single')
  assert.equal(s.lang, 'en')
  assert.equal(s.kind, 'single')
  assert.equal(s.item, 'Tabula Rasa, Simple Robe')
  assert.equal(s.amount, 12)
  assert.equal(s.tag, 'chaos')
  assert.equal(s.league, 'Mercenaries')
  assert.equal(s.tab, 'Sale')
  assert.equal(s.left, 5)
  assert.equal(s.top, 3)
  assert.equal(s.extraLen, 0)

  // The real bulk form has NO final dot: all 52 counted ones end in ' in <league>'.
  const b = parseWhisper(EN_BULK)
  assert.equal(b.template, 'en-bulk')
  assert.equal(b.kind, 'bulk')
  assert.equal(b.qty, 10)
  assert.equal(b.item, 'Orb of Alchemy')
  assert.equal(b.amount, 1)
  assert.equal(b.currency, 'Divine Orb')
  assert.equal(b.rest, 'Mercenaries')
  assert.equal(b.league, undefined, 'a bulk whisper leaves the league to splitLeague')

  const u = parseWhisper(EN_UNPRICED)
  assert.equal(u.template, 'en-single-unpriced')
  assert.equal(u.kind, 'unpriced-listing')
  assert.equal(u.item, 'Lost in the Pit', "a name with ' in ' does not cut the league")
  assert.equal(u.league, 'Mercenaries')
  assert.equal(u.tab, 'S')
  assert.equal(u.left, 1)
  assert.equal(u.top, 2)

  const priced = parseWhisper('Hi, I would like to buy your Lost in the Pit listed for 3 chaos in Hardcore Mercenaries (stash tab "S"; position: left 1, top 2)')
  assert.equal(priced.item, 'Lost in the Pit')
  assert.equal(priced.league, 'Hardcore Mercenaries', 'a league with a space is read whole')

  const d = parseWhisper(DE_SINGLE)
  assert.equal(d.template, 'de-single')
  assert.equal(d.lang, 'de')
  assert.equal(d.kind, 'single')
  assert.equal(d.item, 'Tabula Rasa, Einfaches Gewand')
  assert.equal(d.amount, 1.5)
  assert.equal(d.tag, 'divine')
  assert.equal(d.league, 'Mercenaries')
  assert.equal(d.tab, 'Verkauf')
  assert.equal(d.left, 3)
  assert.equal(d.top, 4)
})

test('every template entry is data with an id, a language and a kind', () => {
  const ids = WHISPER_TEMPLATES.map(t => t.id)
  assert.deepEqual(ids, ['en-single', 'en-single-unpriced', 'en-bulk', 'de-single', 'de-bulk', 'fr-single', 'fr-bulk',
    'ru-single', 'ru-bulk', 'es-single', 'es-bulk', 'pt-single', 'pt-bulk'])
  for (const t of WHISPER_TEMPLATES) {
    assert.ok(t.lang && t.kind && t.re instanceof RegExp, t.id)
  }
})

test('the rest of a bulk whisper is cut against the user\'s league', () => {
  assert.deepEqual(splitLeague('Mercenaries', 'Mercenaries'), { league: 'Mercenaries', extraLen: 0 })
  assert.deepEqual(splitLeague('Hardcore Mercenaries', 'Hardcore Mercenaries'), { league: 'Hardcore Mercenaries', extraLen: 0 })
  assert.equal(splitLeague('Hardcore Mercenaries', 'Mercenaries'), null)
  assert.equal(splitLeague('Mercenaries', 'Hardcore Mercenaries'), null)
  assert.deepEqual(splitLeague('Mercenaries 20c?', 'Mercenaries'), { league: 'Mercenaries', extraLen: 4 })
  assert.deepEqual(splitLeague('Mercenaries.', 'Mercenaries'), { league: 'Mercenaries', extraLen: 0 }, 'an older closing dot is no addition')
  assert.deepEqual(splitLeague('Mercenaries. ty', 'Mercenaries'), { league: 'Mercenaries', extraLen: 2 })
  assert.equal(splitLeague('MercenariesX', 'Mercenaries'), null, 'a longer word is another league')
  assert.equal(splitLeague('Standard', 'Mercenaries'), null)
  // Never a one-character league: an empty or missing user league matches nothing.
  assert.equal(splitLeague('M', ''), null)
  assert.equal(splitLeague('Mercenaries', ''), null)
  assert.equal(splitLeague('Mercenaries', null), null)
  assert.equal(splitLeague(null, 'Mercenaries'), null)
})

test("people's additions and number formats are tolerated", () => {
  const extra = parseWhisper(EN_SINGLE + ' 20c?')
  assert.equal(extra.extraLen, 4)
  assert.equal(extra.item, 'Tabula Rasa, Simple Robe')
  assert.equal(extra.league, 'Mercenaries')
  assert.equal(extra.top, 3)
  assert.equal(parseWhisper(EN_SINGLE.replace('12 chaos', '1,5 divine')).amount, 1.5)
  assert.equal(parseWhisper(EN_SINGLE.replace('12 chaos', '0.5 divine')).amount, 0.5)
  assert.equal(parseWhisper(EN_SINGLE.replace('12 chaos', '99999999999 chaos')), null)
  assert.equal(parseWhisper(EN_BULK.replace('10 Orb', '99999999999 Orb')), null)
  assert.equal(parseWhisper('hello there'), null)
  assert.equal(parseWhisper('Hi, I would like to buy your soul'), null)
  for (const odd of ['', null, undefined, 42, {}, 'x'.repeat(10_000), ('Hi, I would like to buy your ' + 'a in '.repeat(2000))]) {
    assert.doesNotThrow(() => parseWhisper(odd))
    assert.equal(parseWhisper(odd), null)
  }
})

test('the bulk league is the text after the FIRST " in " behind the currency, never one character', () => {
  const b = parseWhisper("Hi, I'd like to buy your 6 Awakened Sextant for my 900 Chaos Orb in Hardcore Mercenaries")
  assert.equal(b.currency, 'Chaos Orb')
  assert.equal(b.rest, 'Hardcore Mercenaries')
  assert.equal(b.qty, 6)
  assert.equal(b.amount, 900)
  for (const r of [b.rest, parseWhisper(EN_BULK).rest]) assert.ok(r.length > 1)
})

// Every other language: the single template gives the same fields as the
// English one, the bulk template the same as English bulk.
const SINGLES = [
  ['de-single', 'de', DE_SINGLE, 'Tabula Rasa, Einfaches Gewand', 1.5, 'divine', 'Verkauf', 3, 4],
  ['fr-single', 'fr', FR_SINGLE, 'Tabula Rasa, Robe simple', 12, 'chaos', 'Vente', 5, 3],
  ['ru-single', 'ru', RU_SINGLE, 'Табула Раса, Простая роба', 12, 'chaos', 'Продажа', 5, 3],
  ['es-single', 'es', ES_SINGLE, 'Tabula Rasa, Túnica simple', 12, 'chaos', 'Venta', 5, 3],
  ['pt-single', 'pt', PT_SINGLE, 'Tabula Rasa, Túnica Simples', 12, 'chaos', 'Venda', 5, 3]
]
const BULKS = [
  ['fr-bulk', 'fr', FR_BULK, 'Orbe d\'alchimie', 'Orbe divin'],
  ['ru-bulk', 'ru', RU_BULK, 'Сфера алхимии', 'Божественная сфера'],
  ['es-bulk', 'es', ES_BULK, 'Orbe de alquimia', 'Orbe divino'],
  ['pt-bulk', 'pt', PT_BULK, 'Orbe de Alquimia', 'Orbe Divino']
]

test('the single template of every other language reads its sample', () => {
  for (const [id, lang, text, item, amount, tag, tab, left, top] of SINGLES) {
    const s = parseWhisper(text)
    assert.ok(s, id)
    assert.deepEqual(
      [s.template, s.lang, s.kind, s.item, s.amount, s.tag, s.league, s.tab, s.left, s.top, s.extraLen],
      [id, lang, 'single', item, amount, tag, 'Mercenaries', tab, left, top, 0], id)
    const more = parseWhisper(text + ' 20c?')
    assert.equal(more.extraLen, 4, id)
    assert.equal(more.top, top, id)
  }
})

// The listed currency of a single whisper in another language may be several
// words (SlimTrade reads it as '.+'): the whisper is still read whole.
const MULTI_WORD = [
  ['de-single', DE_SINGLE.replace('1,5 divine', '5 Göttliche Sphäre'), 'Göttliche Sphäre'],
  ['fr-single', FR_SINGLE.replace('12 chaos', '5 Orbe du chaos'), 'Orbe du chaos'],
  ['ru-single', RU_SINGLE.replace('12 chaos', '5 Сфера хаоса'), 'Сфера хаоса'],
  ['es-single', ES_SINGLE.replace('12 chaos', '5 Orbe del caos'), 'Orbe del caos'],
  ['pt-single', PT_SINGLE.replace('12 chaos', '5 Orbe do Caos'), 'Orbe do Caos']
]

test('the single template of every other language reads a currency of several words', () => {
  for (const [id, text, tag] of MULTI_WORD) {
    const s = parseWhisper(text)
    assert.ok(s, id)
    assert.deepEqual([s.template, s.amount, s.tag, s.league, s.left, s.top, s.extraLen],
      [id, 5, tag, 'Mercenaries', ...SINGLES.find(r => r[0] === id).slice(7), 0], id)
  }
  const hc = parseWhisper(MULTI_WORD[0][1].replace("'Mercenaries'-Liga", "'Hardcore Mercenaries'-Liga"))
  assert.equal(hc.tag, 'Göttliche Sphäre')
  assert.equal(hc.league, 'Hardcore Mercenaries')
})

test('the single template of every other language drops a backslash before the tab quotes', () => {
  for (const [id, , text, , , , tab] of SINGLES) {
    const escaped = text.replace(`"${tab}"`, `\\"${tab}\\"`)
    assert.notEqual(escaped, text, id)
    const s = parseWhisper(escaped)
    assert.ok(s, id)
    assert.equal(s.template, id)
    assert.equal(s.tab, tab, id)
    assert.equal(parseWhisper(text.replace(`"${tab}"`, `\\"${tab}"`)).tab, tab, id + ': only before the opening quote, as SlimTrade reads it')
  }
  assert.equal(parseWhisper(FR_SINGLE.replace('"Vente"', '"a\\b"')).tab, 'a\\b', 'a backslash inside the name stays')
})

test('the German single template reads the league with and without quotes', () => {
  const plain = parseWhisper(DE_SINGLE.replace("'Mercenaries'-Liga", 'Mercenaries-Liga'))
  assert.equal(plain.league, 'Mercenaries')
  const hc = parseWhisper(DE_SINGLE.replace("'Mercenaries'-Liga", "'Hardcore Mercenaries'-Liga"))
  assert.equal(hc.league, 'Hardcore Mercenaries')
  assert.equal(hc.item, 'Tabula Rasa, Einfaches Gewand')
})

test('the Spanish single template reads left with and without a space after izquierda', () => {
  assert.equal(parseWhisper(ES_SINGLE).left, 5)
  assert.equal(parseWhisper(ES_SINGLE.replace('izquierda5', 'izquierda 5')).left, 5)
})

test('the bulk template of every other language reads its sample, the league is left to splitLeague', () => {
  for (const [id, lang, text, item, currency] of BULKS) {
    const b = parseWhisper(text)
    assert.ok(b, id)
    assert.deepEqual([b.template, b.lang, b.kind, b.qty, b.item, b.amount, b.currency, b.rest, b.league],
      [id, lang, 'bulk', 10, item, 1, currency, 'Mercenaries', undefined], id)
    assert.equal(parseWhisper(text.replace('Mercenaries', 'Hardcore Mercenaries')).rest, 'Hardcore Mercenaries', id)
  }
})

test('the German bulk template closes its league, so it gives the league itself', () => {
  const b = parseWhisper(DE_BULK)
  assert.deepEqual([b.template, b.lang, b.kind, b.qty, b.item, b.amount, b.currency, b.league, b.extraLen, b.rest],
    ['de-bulk', 'de', 'bulk', 10, 'Alchemie-Sphäre', 1, 'Göttliche Sphäre', 'Hardcore Mercenaries', 0, undefined])
  assert.equal(parseWhisper(DE_BULK + '. danke').extraLen, 5, 'a closing dot is no addition, the rest is')
  assert.equal(parseWhisper(DE_BULK.replace("'Hardcore Mercenaries'-Liga", 'Mercenaries-Liga')).league, 'Mercenaries')
  assert.equal(parseWhisper(DE_BULK.replace("'10 ", "'99999999999 ")), null)
})

test('no template of another language throws or matches on odd text', () => {
  const starts = ["Hi, ich möchte '", "Bonjour, je souhaiterais t'acheter ", "Bonjour, je voudrais t'acheter ",
    'Здравствуйте, хочу купить у вас ', 'Hola, quisiera comprar tu ', 'Hola, me gustaría comprar tu(s) ',
    'Olá, eu gostaria de comprar o seu item ', 'Olá, eu gostaria de comprar seu(s) ']
  for (const start of starts) {
    for (const odd of [start, start + 'x', start + '1 a pour 1 b dans la ligue '.repeat(120), start + "1 a' zum angebotenen Preis von '".repeat(100)]) {
      assert.doesNotThrow(() => parseWhisper(odd))
      assert.equal(parseWhisper(odd), null, odd.slice(0, 60))
    }
  }
})
