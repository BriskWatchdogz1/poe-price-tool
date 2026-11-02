// Stage (b) of acceptance criterion 6 — and the one that actually measures
// "vollständig deutsch".
//
// A hardcoded display text produces no error, no fallback and no warning. It is
// simply English, forever, and neither the key-coverage test nor a fallback
// counter in t() can ever see it: both only look at texts that already ask the
// table. So this file goes the other way round — it reads the templates and the
// frontend code, collects everything that LOOKS like a sentence shown to a
// user, and demands that each one either goes through the table or stands in
// the allowlist below with a reason.
//
// The allowlist is therefore not a way around the test; it IS the inventory of
// what stays English, and every entry had to be argued for once. A new
// hardcoded text is not on it, so it turns this file red.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = p => fileURLToPath(new URL(p, import.meta.url))

const JS_FILES = ['app.js', 'networth.js', 'history.js', 'settings.js', 'shell.js', 'tabs.js', 'networth-sync.js', 'highlight.js', 'history-chart.js']
const HTML_FILES = ['index.html', 'networth.html', 'history.html', 'settings.html']

// ---------------------------------------------------------------------------
// What is allowed to stand in the code as a literal, and why.
// ---------------------------------------------------------------------------
const JS_ALLOWED = new Map([
  // Not display text at all — they only look like prose to the scanner.
  ['use strict', 'JS directive'],
  ['last scan', 'fragment of the autosync title attribute; the assembled string is built from the table'],
  ['(prefers-reduced-motion:reduce)', 'media query'],
  ['poe.ninja', 'proper noun: the source name, printed the same in every language']
  // Wire-level vocabulary: message types, storage keys, selectors, endpoints.
  // Translating any of these would break the protocol, not the page.
  // Deliberately English on screen — see the report.
])

// Text nodes / attribute values in the templates that carry no key on purpose.
const HTML_ALLOWED = new Map([
  ['Trade Console', 'placeholder for the server-configured app name (POE_APP_NAME); Shell.applyBrand overwrites it'],
  ['Path of Exile', 'the game’s name — identical in the German client'],
  ['Standard', 'league name; the real list comes from /leagues'],
  ['Hardcore', 'league name; the real list comes from /leagues'],
  // <title> is rewritten by Shell.applyBrand as soon as /users answers, from
  // the configured app name plus the translated page name.
  ['Trade Console — Path of Exile', 'placeholder title, replaced by Shell.applyBrand'],
  ['Net Worth — Path of Exile', 'placeholder title, replaced by Shell.applyBrand'],
  ['History — Path of Exile', 'placeholder title, replaced by Shell.applyBrand'],
  ['Settings — Path of Exile', 'placeholder title, replaced by Shell.applyBrand'],
  ['Name#1234', 'example account name — a format, not a sentence']
])

// ---------------------------------------------------------------------------
// JS scanning
// ---------------------------------------------------------------------------

// Comment- and regex-aware collector for every string literal and every static
// chunk of a template literal. A hand-rolled scanner rather than a parser
// dependency: the project ships exactly two runtime deps and keeps it that way.
function literals (src, base = 0) {
  const out = []
  const lineAt = pos => src.slice(0, pos).split('\n').length + base
  let i = 0
  let prev = ''
  const n = src.length

  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
    if (c === '/' && /[(,=:[!&|?{};+\-*%~^]/.test(prev)) {           // regex literal
      i++
      while (i < n && src[i] !== '/') {
        if (src[i] === '\\') i++
        else if (src[i] === '[') { while (i < n && src[i] !== ']') { if (src[i] === '\\') i++; i++ } }
        i++
      }
      i++
      while (i < n && /[gimsuy]/.test(src[i])) i++
      prev = '/'
      continue
    }
    if (c === "'" || c === '"') {
      const start = i; const q = c; i++
      let buf = ''
      while (i < n && src[i] !== q) { if (src[i] === '\\') { buf += src[i + 1]; i += 2; continue } buf += src[i]; i++ }
      i++
      out.push({ text: buf, line: lineAt(start), pre: src.slice(Math.max(0, start - 80), start) })
      prev = q
      continue
    }
    if (c === '`') {
      const start = i; i++
      let buf = ''
      while (i < n) {
        if (src[i] === '\\') { buf += src[i + 1]; i += 2; continue }
        if (src[i] === '$' && src[i + 1] === '{') {
          out.push({ text: buf, line: lineAt(start), pre: '`' }); buf = ''
          i += 2
          let depth = 1
          let sub = ''
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') { depth--; if (!depth) break }
            sub += src[i]; i++
          }
          i++
          for (const l of literals(sub, lineAt(start) - 1)) out.push(l)
          continue
        }
        if (src[i] === '`') { i++; break }
        buf += src[i]; i++
      }
      out.push({ text: buf, line: lineAt(start), pre: '`' })
      prev = '`'
      continue
    }
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out
}

// Strips everything that is markup rather than words: whole tags, tag
// fragments (a template chunk usually cuts a tag in half), attribute pairs,
// entities and our own {placeholders}. What is left is the visible sentence.
function visibleText (raw) {
  let s = String(raw)
  s = s.replace(/<[^<>]*>/g, ' ')            // complete tags
  s = s.replace(/<[^<>]*$/, ' ')             // tag cut off at the end of a chunk
  s = s.replace(/^[^<>]*>/, ' ')             // tail of a tag at the start of a chunk
  s = s.replace(/[\w-]+\s*=\s*"[^"]*"/g, ' ') // leftover attribute pairs
  s = s.replace(/[\w-]+\s*=\s*"?/g, ' ')     // leftover half attributes
  s = s.replace(/&[a-z]+;/g, ' ')
  s = s.replace(/\{\w+\}/g, ' ')
  return s.trim().replace(/\s+/g, ' ')
}

// Two or more words of letters, and at least one space — a single token is a
// key, an id or a class name, never a sentence. Single words that ARE shown to
// the user are caught by the assignment check further down instead.
function prose (raw) {
  const s = visibleText(raw)
  if (!/ /.test(s)) return null
  const words = s.match(/[A-Za-zÄÖÜäöüßÀ-ÿ]{2,}/g) || []
  return words.length >= 2 ? s : null
}

// Contexts in which a string is addressing the machine, not the reader. Kept
// deliberately short: every entry here is a hole in the test, so it may only
// name calls that can never take display text.
const MACHINE_CONTEXT = /(querySelector|querySelectorAll|closest|matches|getElementById|createElement|setAttribute|getAttribute|removeAttribute|addEventListener|removeEventListener|matchMedia|getItem|setItem|removeItem)\s*\(\s*$/

// A CSS selector, not a sentence. Two words alone are NOT enough to qualify —
// "no price" would pass that — so at least one token has to carry selector
// syntax (a dot, a hash or an attribute bracket).
function isSelectorish (s) {
  if (/^[.#[]/.test(s)) return true
  const toks = s.trim().split(/\s+/)
  if (toks.length < 2) return false
  const tokenish = t => /^[>+~]$/.test(t) || /^[.#[]/.test(t) || /^[a-z][\w-]*([.#[:][^\s]*)?$/.test(t)
  return toks.every(tokenish) && toks.some(t => /[.#[]/.test(t))
}

function isWireish (s) {
  return /^[a-z][\w-]*$/.test(s) ||                // message types: item-added
    /^ppt_/.test(s) ||                             // storage keys
    /^https?:\/\//.test(s) || s.startsWith('/') || s.startsWith('./') ||
    /^ppt_user=/.test(s) || /path=\/; max-age/.test(s) ||
    /^application\//.test(s) || s === 'content-type'
}

// ---------------------------------------------------------------------------
// HTML scanning
// ---------------------------------------------------------------------------
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

// Walks the template with a tag stack so a text node inside <div data-i18n-html>
// counts as covered even when it sits behind a nested <kbd>.
function htmlFindings (html) {
  // Blank the non-content regions instead of deleting them, so the reported
  // line numbers still point at the real file.
  const blank = m => m.replace(/[^\n]/g, ' ')
  const src = html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<script[\s\S]*?<\/script>/gi, blank)
    .replace(/<style[\s\S]*?<\/style>/gi, blank)
  const findings = []
  const stack = []
  const tagRe = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  let last = 0
  let m
  const emitText = (text, upTo) => {
    const p = prose(text)
    if (!p) return
    const covered = stack.some(f => f.keyed)
    if (!covered) findings.push({ kind: 'text', text: p, line: src.slice(0, upTo).split('\n').length })
  }
  while ((m = tagRe.exec(src))) {
    emitText(src.slice(last, m.index), m.index)
    last = tagRe.lastIndex
    const closing = m[0][1] === '/'
    const name = m[1].toLowerCase()
    const attrs = m[2] || ''
    if (closing) { while (stack.length && stack.pop().name !== name) { /* unwind */ } continue }
    const keyed = /\bdata-i18n(-html)?=/.test(attrs)
    // Attributes the user reads.
    for (const [attr, partner] of [['title', 'data-i18n-title'], ['placeholder', 'data-i18n-ph'], ['aria-label', 'data-i18n-aria']]) {
      const a = new RegExp(`(^|\\s)${attr}\\s*=\\s*"([^"]*)"`).exec(attrs)
      if (!a) continue
      const p = prose(a[2]) || (/[A-Za-zÄÖÜäöüß]{2,}/.test(a[2]) ? a[2].trim() : null)
      if (!p) continue
      if (!attrs.includes(partner + '=')) {
        findings.push({ kind: attr, text: p, line: src.slice(0, m.index).split('\n').length })
      }
    }
    if (!VOID.has(name) && !m[0].endsWith('/>')) stack.push({ name, keyed })
  }
  emitText(src.slice(last), src.length)
  return findings
}

// ---------------------------------------------------------------------------
async function tableKeys () {
  const src = await readFile(here('i18n.js'), 'utf8')
  const ctx = vm.createContext({ window: {} })
  vm.runInContext(src, ctx, { filename: 'i18n.js' })
  return new Set(Object.keys(ctx.window.I18n.STRINGS.en))
}

// Negative control. A scanner that finds nothing looks exactly like a scanner
// that is broken, so it has to prove on planted text that it still bites.
test('the scanner still catches a planted hardcoded text', async () => {
  const planted = `const x = 'Nothing to see here'\n` +
    'const y = `<div class="c">Nothing to see here</div>`\n' +
    "el.textContent = 'Nothing to see here'\n"
  const hits = literals(planted).map(l => prose(l.text)).filter(Boolean)
  assert.ok(hits.includes('Nothing to see here'), 'a plain literal is seen')
  assert.equal(hits.filter(h => h === 'Nothing to see here').length, 3,
    'inside a template literal and behind a tag it is seen too')
  assert.equal(isSelectorish('Nothing to see here'), false, 'and not mistaken for a selector')
  assert.equal(isWireish('Nothing to see here'), false, 'nor for a wire constant')
})

test('no display text in the frontend code bypasses the string table', async () => {
  const keys = await tableKeys()
  const found = []
  for (const file of JS_FILES) {
    const src = await readFile(here(file), 'utf8')
    for (const lit of literals(src)) {
      const raw = lit.text
      if (!raw || keys.has(raw)) continue          // it IS a translation key
      const p = prose(raw)
      if (!p) continue
      if (isSelectorish(p) || isWireish(p)) continue
      if (MACHINE_CONTEXT.test(lit.pre)) continue
      if (JS_ALLOWED.has(p)) continue
      found.push(`${file}:${lit.line}  ${JSON.stringify(p)}`)
    }
  }
  assert.deepEqual(found, [],
    'these texts never reach the string table — they stay English in every language:\n' + found.join('\n'))
})

// The single-word case the sentence heuristic above cannot see: a bare word
// written straight into what the user reads.
test('no bare literal is assigned to visible DOM text', async () => {
  const keys = await tableKeys()
  const found = []
  const re = /\.(textContent|innerHTML|placeholder|title)\s*=\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/g
  for (const file of JS_FILES) {
    const src = await readFile(here(file), 'utf8')
    let m
    while ((m = re.exec(src))) {
      const text = m[3]
      if (!text) continue                               // clearing a slot is fine
      if (keys.has(text)) continue
      if (!/[A-Za-zÄÖÜäöüß]{2,}/.test(text)) continue   // symbols, numbers, units
      if (JS_ALLOWED.has(text)) continue
      found.push(`${file}:${src.slice(0, m.index).split('\n').length}  ${JSON.stringify(text)}`)
    }
  }
  assert.deepEqual(found, [],
    'a literal written straight into visible DOM text:\n' + found.join('\n'))
})

test('no display text in the templates bypasses the string table', async () => {
  const found = []
  for (const file of HTML_FILES) {
    const html = await readFile(here(file), 'utf8')
    for (const f of htmlFindings(html)) {
      if (HTML_ALLOWED.has(f.text)) continue
      found.push(`${file}:${f.line}  [${f.kind}] ${JSON.stringify(f.text)}`)
    }
  }
  assert.deepEqual(found, [],
    'template text without a data-i18n key — it stays English in every language:\n' + found.join('\n'))
})

test('every key a template references exists in the table', async () => {
  const keys = await tableKeys()
  const missing = []
  for (const file of HTML_FILES) {
    const html = await readFile(here(file), 'utf8')
    for (const m of html.matchAll(/data-i18n(?:-html|-title|-ph|-aria)?="([^"]+)"/g)) {
      if (!keys.has(m[1])) missing.push(`${file}: ${m[1]}`)
    }
  }
  assert.deepEqual(missing, [], 'templates point at keys the table does not have:\n' + missing.join('\n'))
})

test('every page loads i18n.js, and before anything that uses it', async () => {
  for (const file of HTML_FILES) {
    const html = await readFile(here(file), 'utf8')
    const i18nAt = html.indexOf('src="i18n.js"')
    const shellAt = html.indexOf('src="shell.js"')
    assert.ok(i18nAt >= 0, `${file}: i18n.js is not loaded`)
    assert.ok(shellAt > i18nAt, `${file}: shell.js must come after i18n.js`)
    const pageAt = html.search(/src="(app|networth|history|settings)\.js"/)
    assert.ok(pageAt > i18nAt, `${file}: the page script must come after i18n.js`)
  }
})
