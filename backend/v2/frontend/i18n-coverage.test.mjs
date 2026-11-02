// Stage (a) of acceptance criterion 6: the string tables stay deckungsgleich.
//
// A key that exists in `en` but not in `de` does not blow up at runtime — t()
// silently falls back to English, and the German page just has one English
// sentence on it. Nobody notices. So the shape of the tables is pinned here:
// same keys, same placeholders, no empty values.
//
// This is the CHEAPEST of the three stages and proves the least. It cannot see
// a text that never asks the table at all — that is what i18n-hardcoded.test.mjs
// (stage b) is for, and why a fallback counter is not a proof either.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = p => fileURLToPath(new URL(p, import.meta.url))

// i18n.js is a classic browser script (see the header comment there for why).
// Evaluating it in a vm context with a bare `window` is enough — nothing in it
// touches the DOM at load time.
export async function loadI18n () {
  const src = await readFile(here('i18n.js'), 'utf8')
  const ctx = vm.createContext({ window: {}, localStorage: undefined })
  vm.runInContext(src, ctx, { filename: 'i18n.js' })
  return ctx.window.I18n
}

const placeholders = s => (String(s).match(/\{(\w+)\}/g) || []).sort()

test('every language ships the same set of keys', async () => {
  const I18n = await loadI18n()
  // Array.from: the module runs in a vm realm, so its arrays are not
  // reference-equal to this realm's Array prototype.
  const langs = Array.from(I18n.languages())
  assert.deepEqual(langs.slice().sort(), ['de', 'en'], 'exactly the two shipped languages')

  const base = Object.keys(I18n.STRINGS.en).sort()
  assert.ok(base.length > 150, `the table is suspiciously small (${base.length} keys)`)

  for (const lang of langs) {
    const keys = Object.keys(I18n.STRINGS[lang]).sort()
    const missing = base.filter(k => !keys.includes(k))
    const extra = keys.filter(k => !base.includes(k))
    assert.deepEqual(missing, [], `${lang} is missing keys`)
    assert.deepEqual(extra, [], `${lang} has keys no other language has`)
  }
})

test('no value is empty and no value is left as a copy-paste marker', async () => {
  const I18n = await loadI18n()
  for (const lang of Array.from(I18n.languages())) {
    for (const [k, v] of Object.entries(I18n.STRINGS[lang])) {
      assert.equal(typeof v, 'string', `${lang}.${k} is not a string`)
      assert.ok(v.length > 0, `${lang}.${k} is empty`)
      assert.ok(!/^TODO/i.test(v), `${lang}.${k} is still a TODO`)
    }
  }
})

test('a translation keeps every placeholder of its English original', async () => {
  const I18n = await loadI18n()
  for (const lang of Array.from(I18n.languages())) {
    if (lang === 'en') continue
    for (const [k, en] of Object.entries(I18n.STRINGS.en)) {
      assert.deepEqual(placeholders(I18n.STRINGS[lang][k]), placeholders(en),
        `${lang}.${k} does not carry the same {placeholders} as the English text`)
    }
  }
})

// Only keys marked `_html` may contain markup — everything else is inserted
// with esc()/textContent, so a stray tag would show up as literal text.
test('markup only where the key says so', async () => {
  const I18n = await loadI18n()
  for (const lang of Array.from(I18n.languages())) {
    for (const [k, v] of Object.entries(I18n.STRINGS[lang])) {
      if (k.endsWith('_html')) continue
      assert.ok(!/[<>]/.test(v), `${lang}.${k} contains markup but is not an _html key: ${v}`)
    }
  }
})

// The history chart's (i) is the one control on the page whose whole content IS
// the string table: closed it is a label plus a glyph, open it is the whole
// explanation. A key that is missing in one language would leave that button
// opening onto the other language's sentence, and only the reader would ever
// notice.
test('the history chart’s unit explanation ships in both languages', async () => {
  const I18n = await loadI18n()
  // The sentence the rail used to carry permanently, now folded in here: a
  // window can show a net LOSS although the chaos total rose.
  const netLoss = { en: /net loss/i, de: /Netto-Verlust/i }
  for (const lang of Array.from(I18n.languages())) {
    const t = I18n.STRINGS[lang]
    for (const k of ['hi.unitInfo', 'hi.unitInfoAria', 'hi.unitInfoBtn', 'hi.rateLine', 'hi.covRate']) {
      assert.ok(t[k] && t[k].length > 0, `${lang}.${k} is missing`)
    }
    // It has to answer all four questions: which rate is used, what that does
    // to the curve, how a risen chaos total can still be a loss, and what the
    // pale line is for.
    assert.ok(t['hi.unitInfo'].split(/[.!?] /).length >= 4, `${lang}.hi.unitInfo is shorter than the explanation it owes`)
    assert.ok(/C:D/.test(t['hi.unitInfo']), `${lang}.hi.unitInfo never names the rate`)
    assert.match(t['hi.unitInfo'], netLoss[lang],
      `${lang}.hi.unitInfo dropped the case the rail note used to cover on its own`)
    // The button carries a visible label now, and a screen reader hears the
    // longer sentence — so the accessible name has to CONTAIN the visible one,
    // or the two names disagree (WCAG 2.5.3).
    assert.ok(t['hi.unitInfoAria'].toLowerCase().includes(t['hi.unitInfoBtn'].toLowerCase()),
      `${lang}: the button’s visible label is not part of its accessible name`)
  }
  assert.notEqual(I18n.STRINGS.en['hi.unitInfo'], I18n.STRINGS.de['hi.unitInfo'], 'one of them is untranslated')
})

// The button exists so the explanation is NOT permanent. A rail note repeating
// it word for word cancels that, which is exactly what had happened — so the
// key is gone, and staying gone is the assertion.
test('the unit explanation lives in the (i) only, not a second time in the rail', async () => {
  const I18n = await loadI18n()
  for (const lang of Array.from(I18n.languages())) {
    assert.equal(I18n.STRINGS[lang]['hi.covUnitNote'], undefined,
      `${lang}.hi.covUnitNote is back — the explanation would stand permanently again`)
    // The note that legitimately stays there is about the event LIST, and it
    // must not quietly grow into the conversion explanation either.
    assert.ok(!/C:D/.test(I18n.STRINGS[lang]['hi.covNote']),
      `${lang}.hi.covNote has taken over the rate explanation the (i) owns`)
  }
})

test('the German table is actually German, not a copy of the English one', async () => {
  const I18n = await loadI18n()
  const en = I18n.STRINGS.en
  const de = I18n.STRINGS.de
  const same = Object.keys(en).filter(k => en[k] === de[k])
  // Identical entries are legitimate — game vocabulary, units, proper names.
  // What must not happen is the table drifting into a wholesale copy.
  assert.ok(same.length < Object.keys(en).length * 0.25,
    `${same.length} of ${Object.keys(en).length} entries are identical — that reads like an untranslated copy:\n` +
    same.join('\n'))
})

test('a language switch changes what t() returns, and an unknown key is visible', async () => {
  const I18n = await loadI18n()
  assert.equal(I18n.lang(), 'en')
  assert.equal(I18n.t('nw.heading'), 'Net Worth')
  I18n.setLang('de')
  assert.equal(I18n.lang(), 'de')
  assert.equal(I18n.t('nw.heading'), 'Vermögen')
  assert.equal(I18n.t('pc.active', { n: 3 }), '3 aktiv')
  assert.equal(I18n.tn('pc.ed.mod', 1), 'Mod')
  assert.equal(I18n.tn('pc.ed.mod', 2), 'Mods')
  assert.equal(I18n.locale(), 'de-DE')
  // An unknown key returns the key itself — loud on screen, and counted.
  assert.equal(I18n.t('nope.not.here'), 'nope.not.here')
  assert.equal(I18n.missing().get('nope.not.here'), 1)
  I18n.setLang('en')
})

test('server-sent text: known literals are translated, unknown ones pass through', async () => {
  const I18n = await loadI18n()
  I18n.setLang('de')
  assert.equal(I18n.srv('Linked sockets'), 'Verbundene Fassungen')
  assert.equal(I18n.srv('market rate'), 'Marktkurs')
  // A source name is a proper noun and stays put.
  assert.equal(I18n.srv('poe.ninja'), 'poe.ninja')
  // Anything the table does not know is rendered as it came in — an English
  // line beats a blank card.
  assert.equal(I18n.srv('some brand new server message'), 'some brand new server message')
  assert.equal(I18n.srv(''), '')
  assert.equal(I18n.srv(null), null)
  I18n.setLang('en')
})

test('card facts: the label is translated, the value is left alone', async () => {
  const I18n = await loadI18n()
  I18n.setLang('de')
  assert.equal(I18n.fact('Quality: 27%'), 'Qualität: 27%')
  assert.equal(I18n.fact('Item Level: 84'), 'Gegenstandsstufe: 84')
  assert.equal(I18n.fact('Level: 20 (any priced)'), 'Stufe: 20 (beliebig bepreist)')
  assert.equal(I18n.fact('Base Percentile: 88%'), 'Basis-Perzentil: 88%')
  // Unknown label -> unchanged, never mangled.
  assert.equal(I18n.fact('Brand New: 5'), 'Brand New: 5')
  assert.equal(I18n.fact('no colon here'), 'no colon here')
  I18n.setLang('en')
})
