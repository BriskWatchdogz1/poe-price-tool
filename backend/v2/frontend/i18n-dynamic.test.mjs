// Stage (c) of acceptance criterion 6: the states that only exist for a moment.
//
// Rendering a page and looking at it proves nothing about the error banner, the
// rate-limit countdown, an empty result or a failed sync — none of them are on
// screen while things go well, so they slip through every other check. This
// file provokes each one on purpose, in a real Chrome, for a user the
// CONFIGURATION puts on a German client (POE_USER_LANGS), and reads back what
// the page actually says.
//
// The server is imported in-process (pattern: mod-picker-restore.test.mjs) for
// two reasons: the room can be seeded with finished cards instead of spending
// real trade-API budget, and `users.get(x).clients` lets the test push any
// protocol message into the page — which is how the transient states are
// reached without a network at all.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { quietEnv } from '../test-quiet-env.mjs'

const CHROME = process.env.CHROME_BIN || 'google-chrome-stable'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const tmpRoot = await mkdtemp(join(tmpdir(), 'ppt-i18n-'))
await mkdir(join(tmpRoot, 'chrome'), { recursive: true })

// ---- item names on a German page -------------------------------------------
// Item names are not in the string table: the tool ships both spellings of
// every one of them in data/<lang>/items.ndjson and the page applies that pair
// table (GET /item-name-map). The German set is generated locally and is NOT in
// the repo, so every expectation below is READ from it when it is there and
// stays English when it is not — the file is then honest on a fresh clone and
// exact on the machine that just ran the generator.
const DE_ITEMS = fileURLToPath(new URL('../../../renderer/public/data/de/items.ndjson', import.meta.url))
const HAVE_DE = existsSync(DE_ITEMS)
const skipDe = HAVE_DE ? false : 'no generated data/de here — run lang-data-gen.mjs first'
const deNames = new Map()
if (HAVE_DE) {
  for (const line of (await readFile(DE_ITEMS, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (typeof e.name !== 'string' || typeof e.refName !== 'string' || e.name === e.refName) continue
    // Same poisoning rule as the server's loader: ambiguous stays English.
    if (deNames.has(e.refName)) { if (deNames.get(e.refName) !== e.name) deNames.set(e.refName, null); continue }
    deNames.set(e.refName, e.name)
  }
}
// What the page must print for an English reference name.
const deName = ref => deNames.get(ref) || ref

// A snapshot with four categories, two tabs and an unpriced entry — enough to
// exercise the category names, the table, the unpriced block and the tab list.
const STORE = {
  schema_version: 2,
  users: {
    de1: {
      accountName: 'acct', league: 'Standard', cdRatio: 200,
      tabs: {
        0: {
          index: 0,
          name: 'DUMP',
          syncedAt: Date.now(),
          items: [
            { name: 'Headhunter', kind: 'unique', tab: 'DUMP', tabIndex: 0, qty: 1, chaosEach: 5000, chaosTotal: 5000 },
            { name: 'Divine Orb', kind: 'stackable', tab: 'DUMP', tabIndex: 0, qty: 10, chaosEach: 200, chaosTotal: 2000 },
            { name: 'The Doctor', kind: 'divcard', tab: 'DUMP', tabIndex: 0, qty: 2, chaosEach: 300, chaosTotal: 600 },
            { name: 'Awakened Spell Echo', kind: 'gem', tab: 'DUMP', tabIndex: 0, qty: 1, chaosEach: 120, chaosTotal: 120 }
          ],
          unpriced: [{ name: 'Metallic Fossil', kind: 'stackable', count: 7, tabIndex: 0 }],
          counts: { priced: 4, unpriced: 7, skipped: 0 }
        }
      },
      history: []
    }
  }
}

// The full set that keeps a booted server off the network, applied before the
// dynamic import below — server.mjs reads the environment at module load. One
// list, imported: every file that wrote it out by hand left something out, and
// what kept being left out was the switch a WebSocket needs (test-quiet-env.mjs).
quietEnv()
// Env must be set BEFORE server.mjs is imported (it reads it at load time).
process.env.PORT = '0'
process.env.POE_USERS = 'de1,en1'
process.env.POE_USER_LANGS = 'de1:de'          // <- the whole point: from config
process.env.POE_FAUSTUS_DISABLED = '1'
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_DATA_REFRESH_DISABLED = '1'
process.env.POE_REFERENCE_DISABLED = '1'
process.env.POE_NETWORTH_AUTOSYNC = '0'
process.env.POE_NETWORTH_STORE = join(tmpRoot, 'networth-store.json')
process.env.POE_NETWORTH_HISTORY = join(tmpRoot, 'networth-history.ndjson')
process.env.POE_NETWORTH_CONFIG = join(tmpRoot, 'no-such-credentials.json') // -> state 'missing'
process.env.POE_ADMIN_PASSWORD_FILE = join(tmpRoot, 'admin-password')   // created on boot with the default
await writeFile(process.env.POE_NETWORTH_STORE, JSON.stringify(STORE), 'utf8')

let mod
let base

function freePort () {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

async function cdpConnect (wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  let id = 0
  const pending = new Map()
  ws.on('message', buf => {
    const m = JSON.parse(String(buf))
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  })
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const msg = { id: ++id, method, params }
    if (sessionId) msg.sessionId = sessionId
    pending.set(msg.id, { res, rej })
    ws.send(JSON.stringify(msg))
  })
  return { send, close: () => ws.close() }
}

let chrome
let cdp
let S
let evalJs

before(async () => {
  mod = await import('../server.mjs')
  base = `http://127.0.0.1:${mod.server.address().port}`

  const dbg = await freePort()
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${dbg}`, `--user-data-dir=${join(tmpRoot, 'chrome')}`,
    '--window-size=1280,1000', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let verUrl = null
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${dbg}/json/version`)
      if (r.ok) { verUrl = (await r.json()).webSocketDebuggerUrl; break }
    } catch {}
    await sleep(100)
  }
  assert.ok(verUrl, 'Chrome DevTools reachable')

  cdp = await cdpConnect(verUrl)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  S = (m, p) => cdp.send(m, p, sessionId)
  await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable')

  evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
})

after(async () => {
  try { cdp && cdp.close() } catch {}
  try { chrome && chrome.kill('SIGTERM') } catch {}
  await new Promise(resolve => mod.server.close(resolve))
  await sleep(150)
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
})

// ---- helpers ---------------------------------------------------------------
const asUser = async (user) => S('Network.setCookie', { name: 'ppt_user', value: user, url: base + '/' })

const text = sel => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.trim() : null })()`)
const attr = (sel, a) => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.getAttribute(${JSON.stringify(a)}) : null })()`)

async function waitFor (expr, what, tries = 150) {
  for (let i = 0; i < tries; i++) {
    try { if (await evalJs(expr)) return } catch {}
    await sleep(100)
  }
  assert.fail(what)
}

// Push a protocol message straight into the page's socket. This is how the
// transient states are reached — no trade API, no waiting for a real failure.
function pushToRoom (user, msg) {
  const room = mod.users.get(user)
  for (const ws of room.clients) ws.send(JSON.stringify(msg))
}

// A card with a valid price: replays as `done` and is NOT re-queued on connect
// (see hasValidPrice in server.mjs) — the test must not spend trade budget.
function seedCard (user, id) {
  const room = mod.users.get(user)
  room.items.set(id, {
    id,
    item: {},
    preset: { filters: {}, stats: [] },
    addedMsg: {
      type: 'item-added',
      id,
      name: 'Hypnotic Track',
      itemClass: 'Boots',
      rarity: 'rare',
      baseType: 'Warlock Boots',
      corrupted: true,
      priceStatus: 'queued',
      facts: ['Quality: 27%', 'Item Level: 84'],
      mods: [
        { text: 'Linked sockets', kind: 'links', selected: true, value: 4, valueRange: [1, 4] },
        { text: 'Energy Shield: #', kind: 'explicit', selected: true, value: 313, valueRange: [313, 345], tier: 1 },
        { text: '+#% to Fire Resistance', kind: 'suffix', selected: false, value: 42, valueRange: [36, 45] },
        { text: '+# to maximum Life', kind: 'prefix', selected: false, value: 90, valueRange: [80, 99] },
        { text: 'Fractured: +#% Chaos Resistance', kind: 'fractured', selected: false, value: 20, valueRange: [10, 25] },
        { text: '+# to Level of Socketed Physical Gems', kind: 'unknown', selected: false, searchable: false }
      ]
    },
    alive: true,
    status: 'done',
    lastPrice: {
      type: 'price-result', id, display: 'single', currency: 'divine',
      priceLow: 8, priceHigh: 125, priceMedian: 52.5, count: 65, league: 'Standard', tradeId: 'abc123',
      listings: [
        { price: 8, currency: 'divine', seller: '@A', ageMinutes: 3 },
        { price: 9, currency: 'divine', seller: '@B', ageMinutes: 9 },
        { price: 10, currency: 'divine', seller: '@C', ageMinutes: 30 },
        { price: 11, currency: 'divine', seller: '@D', ageMinutes: 61 },
        { price: 12, currency: 'divine', seller: '@E', ageMinutes: 200 },
        { price: 13, currency: 'divine', seller: '@F', ageMinutes: 900 },
        { price: 14, currency: 'divine', seller: '@G', ageMinutes: 3000 }
      ]
    }
  })
  return room.items.get(id)
}

// ---------------------------------------------------------------------------
test('Price Check: card, mod editor and every transient price state are German',
  { timeout: 240_000 }, async () => {
    const rec = seedCard('de1', 'i18n-card-1')
    await asUser('de1')
    try {
      await S('Page.navigate', { url: base + '/' })
      await waitFor('!!document.querySelector(".card")', 'the seeded card never rendered')

      // The language came from the configuration, not from the browser.
      assert.equal(await evalJs('window.I18n.lang()'), 'de', 'the page resolved its language from /users')
      assert.equal(await evalJs('document.documentElement.lang'), 'de')

      // Static chrome around the cards.
      assert.equal(await text('.mhead h1'), 'Geprüfte Gegenstände')
      assert.equal(await text('#badge'), '1 aktiv')
      assert.equal(await text('.mhead .note'), 'Suchen laufen nur auf Anforderung')
      assert.equal(await text('#clear'), 'Alle entfernen')

      // Card head: rarity word and the corruption marker.
      const sub = await text('.card .name small')
      assert.match(sub, /Selten/, 'the rarity reads German')
      assert.match(sub, /Verderbt/, 'so does the corruption marker')
      assert.equal(await attr('.card .x', 'aria-label'), 'Schließen')

      // Facts chips: the server sends "Quality: 27%", the label is ours.
      const chips = await evalJs('[...document.querySelectorAll(".card .mod.fact")].map(e => e.textContent)')
      assert.deepEqual(Array.from(chips), ['Qualität: 27%', 'Gegenstandsstufe: 84'])

      // Mod editor: group headers, badges, buttons.
      const heads = await evalJs('[...document.querySelectorAll(".card .gh")].map(e => e.textContent)')
      assert.deepEqual(Array.from(heads), ['Fassungen', 'Nicht suchbar', 'Frakturiert', 'Präfixe', 'Suffixe', 'Explizit'])
      assert.equal(await text('.card .modbar .tag'), 'Mods wählen')
      assert.equal(await text('.card .allmods'), 'Alle Mods')
      assert.equal(await text('.card .toptier'), 'T2+')
      assert.equal(await text('.card .resetbtn'), '↺ Zurücksetzen')
      assert.equal(await text('.card .searchbtn .lbl'), 'Suchen')
      assert.equal(await text('.card .corruptbar .cl'), 'Verderbt')
      const cbtns = await evalJs('[...document.querySelectorAll(".card .ctog button")].map(e => e.textContent)')
      assert.deepEqual(Array.from(cbtns), ['egal', 'ja', 'nein'])
      assert.equal(await text('.card .mrow.unsearch .fracbadge'), 'nicht suchbar')
      assert.equal(await text('.card .mrow[data-text="Fractured: +#% Chaos Resistance"] .fracbadge'), 'frakturiert')
      assert.equal(await text('.card .mrow[data-text="Energy Shield: #"] .tier'), 'Tier 1')

      // ---- filter rows the ENGINE invents ---------------------------------
      // Not an item name and not a stat from the data set: the vendored engine
      // builds this label out of a string literal, so nothing but the string
      // table can translate it. Both places it shows: the chip strip up top and
      // the row in the mod picker. `data-text` stays the ENGLISH original — it
      // is the protocol key the search payload is built from.
      // (.mtxt also carries the tier chip, hence the prefix match)
      assert.match(await text('.card .mrow[data-text="Energy Shield: #"] .mtxt'), /^Energieschild: 313/)
      const modChips = await evalJs('[...document.querySelectorAll(".card .mod:not(.fact)")].map(e => e.textContent)')
      assert.ok(Array.from(modChips).includes('Energieschild: 313'),
        `the chip strip still reads English: ${JSON.stringify(Array.from(modChips))}`)
      assert.ok(!Array.from(modChips).some(c => c.startsWith('Energy Shield')),
        'and the English wording is gone from it')
      // The synthetic "Linked sockets" mod is server text, translated on arrival.
      assert.match(await text('.card .mrow[data-text="Linked sockets"] .mtxt'), /Verbundene Fassungen/)
      assert.equal(await text('.card .lmore .lmi'), '+ 2 weitere')
      assert.equal(await text('.card .opentrade'), 'Handel öffnen ↗')

      // ---- transient price states, one at a time --------------------------
      const states = [
        ['queued', 'wartet', 'in der Warteschlange'],
        ['searching', 'suche…', 'bevorzugt'],
        ['rate-limited', 'Limit erreicht', 'Suchen pausiert'],
        ['error', 'kein Preis', 'erneut versuchen']
      ]
      for (const [state, pr, hits] of states) {
        pushToRoom('de1', mod.itemAddedFor(rec, state))
        await waitFor(`document.querySelector(".card .pblock .pr").textContent.trim() === ${JSON.stringify(pr)}`,
          `price state "${state}" never showed as "${pr}"`)
        assert.equal(await text('.card .pblock .hits'), hits, `sub-line of the "${state}" state`)
      }

      // ---- rate-limit banner + countdown ----------------------------------
      pushToRoom('de1', {
        type: 'rate-limit',
        active: true,
        until: Date.now() + 3600_000,
        message: "GGG's trade API rate-limited the app — searches are paused (retry-after). Common at league launch under heavy load."
      })
      await waitFor('!document.getElementById("ratebanner").hidden', 'the rate-limit banner never appeared')
      assert.equal(await text('#rbmsg'),
        'Die Handels-API von GGG hat die App ausgebremst — Suchen pausieren (Retry-After). Bei Liga-Start unter Last üblich.')
      assert.match(await text('#rbwait'), /^Erneuter Versuch in ~(1h|59min)\.$/, 'the countdown is German')

      // ---- soft warning (budget nearly spent), a different code path -------
      pushToRoom('de1', { type: 'rate-limit', active: false })
      pushToRoom('de1', { type: 'queue-status', depth: 0, bgDepth: 0, rateLimits: [{ used: 19, limit: 20 }] })
      await waitFor('document.getElementById("rbmsg").textContent.startsWith("Limit der Handels-API")',
        'the soft rate-limit warning never showed in German')
      assert.equal(await text('#rbmsg'), 'Limit der Handels-API fast ausgeschöpft — Suchen pausieren möglicherweise gleich.')

      // ---- M2 data-freshness note (shell.js, its own clock) ----------------
      const now = Date.now()
      pushToRoom('de1', {
        type: 'data-status', enabled: true, now, since: now - 90 * 3600_000, staleAfterMs: 24 * 3600_000,
        sources: [{ source: 'poe.ninja', lastSuccessAt: now - 50 * 3600_000 }]
      })
      await waitFor('!document.getElementById("appStatus").hidden', 'the data-freshness note never appeared')
      assert.equal(await text('#appStatus'),
        'Automatische Datenaktualisierung: keine erfolgreiche Prüfung von poe.ninja seit 2 Tagen — das Werkzeug läuft mit den vorhandenen Daten weiter.')

      // ---- empty state -----------------------------------------------------
      await evalJs('document.getElementById("clear").click()')
      await waitFor('document.getElementById("empty").style.display !== "none"', 'the empty state never came back')
      assert.equal(await text('#empty [data-i18n="pc.empty"]'), 'Keine Gegenstände in der Warteschlange. Prüfe im Spiel einen Gegenstand.')
      // The second sentence (daemon-status, sent on connect) is German too.
      await waitFor('document.getElementById("emptyHint").textContent !== ""', 'the daemon hint never appeared')
      assert.match(await text('#emptyHint'), /Hotkey-Daemon/)
    } finally {
      mod.users.get('de1').items.clear()
    }
  })

test('Net Worth: categories, filters, unpriced block and the sync failure states are German',
  { timeout: 240_000 }, async () => {
    await asUser('de1')
    await S('Page.navigate', { url: base + '/networth.html' })
    await waitFor('document.querySelectorAll("#wrap .grp").length >= 4', 'the grouped view never rendered')

    assert.equal(await text('.mhead h1'), 'Vermögen')
    assert.equal(await text('#settingsBtn'), 'Sync-Einstellungen')
    assert.equal(await text('.tohistory'), 'Verlauf →')
    assert.equal(await text('#ovToggle h3'), 'Überblick — nach Kategorie')

    // Category names — explicitly part of the brief.
    const groups = await evalJs('[...document.querySelectorAll("#wrap .grp .gtitle")].map(e => e.textContent)')
    assert.deepEqual(Array.from(groups), ['Unikate', 'Währung & Stapelbares', 'Weissagungskarten', 'Edelsteine'])
    const chips = await evalJs('[...document.querySelectorAll("#kindChips .chip")].map(e => e.textContent)')
    assert.deepEqual(Array.from(chips), ['Alle', 'Unikate', 'Währung & Stapelbares', 'Weissagungskarten', 'Edelsteine'])

    // Table head and the rail.
    // The active sort column appends an arrow glyph — strip it before comparing.
    const cols = await evalJs('[...document.querySelectorAll("#wrap .grp thead th")].map(e => e.textContent.replace(/[\u25b2\u25bc]/g, "").trim())')
    assert.deepEqual(Array.from(cols).slice(0, 5), ['Gegenstand', 'Tab', 'Anz.', 'Stück', 'Gesamt'])
    assert.equal(await text('#selValued'), 'Nur mit Wert')
    assert.match(await attr('.tabrow', 'title'), /wird gezählt\. Klicken, um ihn auszuschließen\.$/)
    assert.match(await text('#autosync'), /^1\/1 Tabs in den letzten 10 min synchronisiert · ältester Tab vor \d+ min synchronisiert$/)

    // Unpriced block.
    // Pieces and names, both matching the row below it — and "1 Namen" is the
    // German dative, where singular and plural coincide (nw.unpricedNameOne).
    assert.equal(await text('#unpricedSummary'), '7 Stück ohne Preis in 1 Namen (nicht gezählt)')
    // The item name comes from the generated data set rather than the string
    // table, and it arrives one fetch after the page (GET /item-name-map), so
    // the row is waited for instead of read straight away.
    await waitFor(`document.querySelector('#unpricedList li').textContent.startsWith(${JSON.stringify(deName('Metallic Fossil'))})`,
      'the unpriced row never showed its localized name')
    assert.equal(await text('#unpricedList li'), `${deName('Metallic Fossil')} ×7 (Währung & Stapelbares)`)

    // Numbers follow the language, not the browser (5.000 c, not 5,000 c).
    assert.match(await text('#totalChaos'), /^7\.720 c$/)

    // ---- empty result: a filter that matches nothing ----------------------
    await evalJs(`(() => { const q = document.getElementById('q'); q.value = 'zzzz-nichts'; q.dispatchEvent(new Event('input')) })()`)
    await waitFor('!!document.querySelector("#wrap .empty")', 'the no-match state never rendered')
    assert.equal(await text('#wrap .empty'), 'Keine Gegenstände passen zu den gesetzten Filtern.')
    assert.ok(await evalJs('document.getElementById("unpricedBox").hidden'),
      'the unpriced block follows the same filter')
    await evalJs(`(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input')) })()`)

    // ---- Stash-Highlight, including its empty case ------------------------
    await evalJs('document.getElementById("hlToggle").click()')
    await waitFor('!document.getElementById("hlBox").hidden', 'the highlight box never opened')
    assert.equal(await text('#hlCopy'), 'Kopieren')
    await evalJs(`(() => { const q = document.getElementById('q'); q.value = 'zzzz-nichts'; q.dispatchEvent(new Event('input')) })()`)
    await waitFor('document.getElementById("hlMeta").textContent.length > 0', 'the highlight meta line stayed empty')
    assert.equal(await text('#hlMeta'), 'nichts ausgewählt — passe die Filter an')
    await evalJs(`(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input')) })()`)

    // ---- sync failure states, pushed one after another --------------------
    // 'missing' is the real state here (no credentials file), the other two are
    // pushed because provoking a genuine GGG cooldown is not a test.
    await waitFor('!document.getElementById("appStatus").hidden', 'the sync status line never appeared')
    assert.equal(await text('#appStatus'), 'Keine Zugangsdaten hinterlegt — zum Eintragen die Einstellungen öffnen.')

    pushToRoom('de1', { type: 'networth-sync-status', state: 'expired' })
    await waitFor('document.getElementById("appStatus").textContent.startsWith("POESESSID")', 'the expired state never showed')
    assert.equal(await text('#appStatus'), 'POESESSID abgelaufen — Hintergrund-Sync pausiert. Zum Erneuern die Einstellungen öffnen.')

    pushToRoom('de1', { type: 'networth-sync-status', state: 'cooldown', until: Date.now() + 3600_000 })
    await waitFor('document.getElementById("appStatus").textContent.startsWith("Von GGG")', 'the cooldown state never showed')
    assert.match(await text('#appStatus'), /^Von GGG ausgebremst — der Sync läuft um .+ weiter\.$/)

    // ---- error banner (partial snapshot + error) --------------------------
    pushToRoom('de1', { type: 'networth-result', error: 'Stash-API antwortet nicht' })
    await waitFor('!document.getElementById("errBox").hidden', 'the error banner never appeared')
    assert.equal(await text('#errBox'), 'Stash-API antwortet nicht', 'server text is shown as it came in')

    // ---- the settings entry point ----------------------------------------
    // The credential form is not a modal on this page any more; the button is a
    // link. Its label is still ours to translate.
    assert.equal(await text('#settingsBtn'), 'Sync-Einstellungen')
    assert.equal(await evalJs('new URL(document.getElementById("settingsBtn").href).pathname'), '/settings.html')
  })

// ---------------------------------------------------------------------------
// Item names — the half of "vollständig deutsch" that no string table can hold.
//
// This is the one place the two sides can be seen at once: the name the user
// READS is German, the name the page LOOKS UP with is English. The trade link
// is the visible proof of the second half — it is built from the row's name and
// must keep pointing at the English one, exactly like the value join and the
// price sources do server-side (item-name-map.test.mjs).
test('Net Worth prints item names in German and still links them by their English name',
  { timeout: 240_000, skip: skipDe }, async () => {
    await asUser('de1')
    await S('Page.navigate', { url: base + '/networth.html' })
    await waitFor('document.querySelectorAll("#wrap .grp").length >= 4', 'the grouped view never rendered')
    await waitFor(`document.getElementById('wrap').textContent.includes(${JSON.stringify(deName('Headhunter'))})`,
      'the localized item names never arrived')

    const shown = await evalJs('[...document.querySelectorAll("#wrap .iname")].map(e => e.textContent.trim())')
    const names = Array.from(shown)
    for (const ref of ['Headhunter', 'Divine Orb', 'The Doctor']) {
      assert.ok(names.includes(deName(ref)), `${ref} is not printed as "${deName(ref)}": ${JSON.stringify(names)}`)
      assert.ok(!names.includes(ref), `${ref} is still printed in English`)
    }
    // The honest case, and the reason there is no placeholder: a name the data
    // set has no entry for stays English instead of going blank.
    assert.ok(names.includes(deName('Awakened Spell Echo')))

    // …while the link out to the trade site still carries the English name.
    const hrefs = await evalJs('[...document.querySelectorAll("#wrap a.tradebtn")].map(a => a.getAttribute("href")).join("\\n")')
    assert.ok(String(hrefs).includes(encodeURIComponent('Headhunter')),
      'the trade link must be built from the English reference name')
    assert.ok(!String(hrefs).includes(encodeURIComponent(deName('Headhunter'))),
      'and never from the localized one')

    // Searching by what is on screen has to work, or the translation makes the
    // page harder to use than it was in English.
    const q = deName('Headhunter').slice(0, 5)
    await evalJs(`(() => { const e = document.getElementById('q'); e.value = ${JSON.stringify(q)}; e.dispatchEvent(new Event('input')) })()`)
    await waitFor('document.querySelectorAll("#wrap .iname").length === 1', 'the German search term matched nothing')
    assert.equal(await text('#wrap .iname'), deName('Headhunter'))
    await evalJs(`(() => { const e = document.getElementById('q'); e.value = ''; e.dispatchEvent(new Event('input')) })()`)
  })

test('the reference rail translates its rows, including the ones with a shortened name',
  { timeout: 240_000, skip: skipDe }, async () => {
    await asUser('de1')
    await S('Page.navigate', { url: base + '/' })
    await waitFor('!!window.I18n && window.I18n.lang() === "de"', 'the price-check page never resolved its language')
    await waitFor('!!window.I18n.itemName("Chaos Orb")', 'the name table never arrived on this page')

    // The rail is off in this environment (POE_REFERENCE_DISABLED), so the
    // message is pushed in — same technique as the transient states above.
    // The lifeforce row is the interesting one: what the rail PRINTS is a
    // shortened wording that exists in no data set, so only the `refName` the
    // server puts next to it can be looked up.
    pushToRoom('de1', {
      type: 'reference',
      league: 'Standard',
      currency: [{ name: 'Mirror of Kalandra', display: '300 div', invert: false, src: 'ninja' }],
      lifeforce: [{ name: 'Vivid Lifeforce', refName: 'Vivid Crystallised Lifeforce', display: '12 c', invert: true, src: 'faustus' }],
      beasts: [],
      refreshedAt: Date.now()
    })
    await waitFor('document.querySelectorAll("#ref .rrow .n").length >= 2', 'the rail never rendered')
    const rows = await evalJs('[...document.querySelectorAll("#ref .rrow .n")].map(e => e.getAttribute("title"))')
    assert.deepEqual(Array.from(rows),
      [deName('Mirror of Kalandra'), deName('Vivid Crystallised Lifeforce')])
    // The German section heading over an English entry was the reported symptom.
    const heads = await evalJs('[...document.querySelectorAll("#ref .rsec .rh")].map(e => e.textContent)')
    assert.ok(Array.from(heads).length >= 2)
  })

// The two tests below need the server to OFFER German: the language selector
// lists only languages a parser was loaded for, and that needs the generated
// data/de set — so a fresh clone skips them, like the two item-name tests above.
test('Settings: the sync section, the admin gate and the whole admin view are German',
  { timeout: 240_000, skip: skipDe }, async () => {
    await asUser('de1')
    await S('Page.navigate', { url: base + '/settings.html' })
    // Wait for the SCRIPTS, not for an element: every id on this page is in the
    // static HTML, so a parsed-but-not-yet-executed document would pass an
    // element check and then fail on the first window.I18n call.
    await waitFor('!!window.I18n && window.I18n.lang() === "de" && !!document.getElementById("setState")',
      'the settings page never resolved its language')

    assert.equal(await evalJs('window.I18n.lang()'), 'de', 'the page resolved its language from /users')
    assert.equal(await text('.mhead h1'), 'Einstellungen')
    assert.equal(await evalJs('[...document.querySelectorAll(".navlinks .backlink")].pop().textContent'), 'Einstellungen')

    // ---- client language (the user's own setting, first section) ----------
    const heads = await evalJs('[...document.querySelectorAll(".sect h2")].map(e => e.textContent)')
    assert.deepEqual(Array.from(heads), ['Sprache des Spiel-Clients', 'Sync-Einstellungen', 'Versionen', 'Quellen', 'Admin-Bereich'])
    assert.match(await text('.sect .lead'), /^Wähle die Sprache, in der dein Spiel läuft/)
    assert.equal(await evalJs('document.querySelector("label[for=langSel] span").textContent'),
      'Sprache deines Spiel-Clients')
    // The option labels are ordinary UI text; the values stay the wire codes.
    await waitFor('document.querySelectorAll("#langSel option").length >= 2',
      'the language selector never got its options')
    const langOpts = await evalJs('[...document.querySelectorAll("#langSel option")].map(o => o.value + "=" + o.textContent)')
    assert.deepEqual(Array.from(langOpts).sort(), ['de=Deutsch', 'en=Englisch'])
    assert.equal(await evalJs('document.getElementById("langSel").value'), 'de',
      'the selector shows the language this user is actually on')

    // ---- sync section (the former dialog) ---------------------------------
    assert.equal(await text('#setSave'), 'Speichern')
    assert.equal(await attr('#setSessid', 'placeholder'), 'leer lassen, um die hinterlegte zu behalten')
    await waitFor('document.getElementById("setState").textContent.startsWith("Für diesen Nutzer")',
      'the settings page never showed the real credential state')
    assert.equal(await text('#setState'),
      'Für diesen Nutzer sind noch keine Zugangsdaten hinterlegt. Trage Kontonamen und POESESSID ein, damit der Sync startet.')
    assert.match(await text('#setNote'), /^Die hinterlegte POESESSID wird hier nie angezeigt/)
    // This server runs without a writable /config, so the honest note about it
    // is on screen — and in German.
    assert.ok(!(await evalJs('document.getElementById("langNote").hidden')),
      'the "not persisted" note is missing although /config is not writable here')
    assert.equal(await text('#langNote'),
      'Dieser Server kann deine Wahl gerade nicht speichern (sein Log nennt den Grund, meist ein nicht beschreibbares /config): sie gilt jetzt, ist aber beim nächsten Neustart des Servers wieder weg.')

    // the plausibility hint is its own dynamic state
    await evalJs(`(() => { const s = document.getElementById('setSessid'); s.value = 'zu-kurz'; s.dispatchEvent(new Event('input')) })()`)
    await waitFor('!document.getElementById("setHint").hidden', 'the sessid hint never appeared')
    assert.equal(await text('#setHint'),
      'Hinweis: dieser Wert hat 7 Zeichen — POESESSID-Cookies haben üblicherweise 32. Speichern ist trotzdem erlaubt.')

    // ---- admin gate: locked, and the refusal is German too -----------------
    assert.equal(await text('#admGate label span'), 'Admin-Passwort')
    assert.equal(await text('#admOpen'), 'Öffnen')
    assert.match(await text('.gatenote'), /^Ein Klartext-Passwort aus einer Datei auf dem Server/)

    await evalJs(`(() => { document.getElementById('admPass').value = 'falsch'; document.getElementById('admOpen').click() })()`)
    await waitFor('!document.getElementById("admErr").hidden', 'a wrong password produced no message')
    assert.equal(await text('#admErr'), 'Falsches Passwort.')

    // ---- admin view: every heading, note and metric label -------------------
    await evalJs(`(() => { document.getElementById('admPass').value = 'admin'; document.getElementById('admOpen').click() })()`)
    await waitFor('!document.getElementById("admView").hidden', 'the admin view never opened')

    assert.equal(await text('#admReload'), 'Neu laden')
    assert.equal(await text('#admClose'), 'Schließen')
    assert.match(await text('#admMeta'), /^Konfiguriert: en, de · Aktive Parser-Instanzen: /)

    const blocks = await evalJs('[...document.querySelectorAll("#admView .admblock > h3")].map(e => e.textContent)')
    assert.deepEqual(Array.from(blocks),
      ['Server-Einstellungen', 'Auf eine neuere Version aktualisieren', 'Nach einer neueren Version suchen',
        'Datensatz-Versatz zwischen den Sprachen',
        'Lücken, die das Werkzeug selbst gefunden hat',
        'Fehlgeschlagene Parses', 'Unaufgelöste Mod-Zeilen',
        'Womit dieser Server sonst noch läuft'])

    // ---- the update block: the state a fresh installation is really in ------
    // No host script is installed here, and this is the case the operator has
    // to be able to read: the button is visible but disabled, and the sentence
    // under it says what to install. In German, like everything else.
    assert.equal(await text('#updBtn'), 'Jetzt aktualisieren')
    assert.equal(await evalJs('document.getElementById("updBtn").disabled'), true,
      'without a host script there is nothing to press')
    assert.ok(!(await evalJs('document.getElementById("updSetup").hidden')),
      'the "how to set this up" sentence is hidden although no updater is installed')
    assert.match(await text('#updSetup'), /^Auf dem Host ist kein Update-Skript eingerichtet/)
    // This server is started without a BUILD_COMMIT, so the honest answer to
    // "which version is this" is that it does not know — not a made-up value.
    assert.match(await text('#updBuild'), /^Dieser Container weiß nicht, aus welchem Commit/)

    // ---- the settings table: labels the SERVER never sends ------------------
    // Group headings, the readable rendering of `source`, the restart note and
    // its confirmation are all page text and all have to be German.
    // Four tables: live, restart, and the request-volume block — which carries
    // the same live/restart split INSIDE its own section, so its group headings
    // read the same as the ones above them and that is not a copy-paste slip.
    await waitFor('document.querySelectorAll("#cfgTables table.cfgtab").length === 4',
      'the settings table never rendered all four groups')
    const groups = await evalJs('[...document.querySelectorAll("#cfgTables .cfggroup")].map(e => e.textContent)')
    assert.deepEqual(Array.from(groups),
      ['Wirkt sofort', 'Braucht einen Neustart', 'Wirkt sofort', 'Braucht einen Neustart'])
    // The block that sets the traffic settings apart, and the per-row sentence
    // saying which direction costs somebody else a request. Both are page text
    // built from the string table; the server only sends the wire word.
    assert.equal(await text('#cfgTables .cfgtraffic h4'), 'Wie oft dieses Werkzeug fremde Server anfragt')
    assert.match(await text('#cfgTables .cfgtraffic > .note'), /^Diese Werte entscheiden, wie viel Verkehr/)
    const dirs = await evalJs('[...new Set([...document.querySelectorAll("#cfgTables .cfgflag.traffic")].map(e => e.textContent))].sort()')
    // Three sentences, not two: the section holds one SWITCH, and a checkbox told
    // "smaller values send more requests" is describing a number its row does not
    // have.
    assert.deepEqual(Array.from(dirs),
      ['Ausgeschaltet erzeugt es mehr Anfragen.', 'Größere Werte erzeugen mehr Anfragen.',
        'Kleinere Werte erzeugen mehr Anfragen.'])
    assert.equal(await evalJs('document.querySelectorAll("#cfgTables .cfgtraffic .cfgflag.traffic").length'),
      await evalJs('document.querySelectorAll("#cfgTables .cfgflag.traffic").length'),
      'a traffic hint outside the traffic block means a row escaped the grouping')
    const cfgCols = await evalJs('[...document.querySelectorAll("#cfgTables table.cfgtab thead th")].map(e => e.textContent).slice(0, 3)')
    assert.deepEqual(Array.from(cfgCols), ['Einstellung', 'Wert', 'Woher der Wert kommt'])
    // Every source cell says a German sentence, never the raw wire word.
    const sources = await evalJs('[...new Set([...document.querySelectorAll("#cfgTables td.src")].map(e => e.textContent))]')
    for (const s of Array.from(sources)) {
      assert.ok(['hier auf dieser Seite gesetzt', 'aus der Compose-Datei des Servers', 'eingebauter Vorgabewert'].includes(s),
        `a source cell reads "${s}" — that is the raw word from the wire`)
    }
    assert.match(await text('#cfgRestartNote'), /^Der Container hält an und wird von seiner Aufsicht wieder gestartet/)
    assert.equal(await text('#cfgRestart'), 'Jetzt neu starten')
    assert.match(await text('#cfgPath'), /^Gespeichert in /)
    // The read-only block at the end is filled and reads as name/value pairs.
    assert.ok(await evalJs('document.querySelectorAll("#cfgRuntime .rtrow").length > 5'),
      'the read-only runtime list stayed empty')

    assert.match(await text('#admSkewNote'), /^Jede Zeile misst einen übersetzten Datensatz an en/)
    // The offset section says one of exactly two German things: a set that is
    // there and within the bar, or one that is not there at all.
    const skewHead = await text('#admSkew .skewhead')
    assert.ok(/^Kein Versatz oberhalb der Schwelle\.$/.test(skewHead) ||
      /^Für de gibt es überhaupt keinen Datensatz/.test(skewHead) ||
      /^de hängt hinter en\.$/.test(skewHead), `unexpected offset headline: ${skewHead}`)

    // Empty states of both gap lists — they only exist while nothing failed,
    // which is exactly why they slip through a render-and-look check.
    const empties = await evalJs('[...document.querySelectorAll("#admGaps .empty")].map(e => e.textContent)')
    assert.ok(Array.from(empties).every(t => t === 'Nichts aufgezeichnet.'), 'the empty state is German')

    // ---- and with entries in it -------------------------------------------
    // Provoked, not awaited: a text the engine has to refuse, sent as the
    // German user, then the view reloaded.
    await fetch(base + '/item', { method: 'POST', headers: { 'x-user': 'de1' }, body: 'kein Gegenstandstext\nzweite Zeile\n' })
    await fetch(base + '/item', { method: 'POST', headers: { 'x-user': 'de1' }, body: 'kein Gegenstandstext\nzweite Zeile\n' })
    await evalJs('document.getElementById("admReload").click()')
    await waitFor('document.querySelectorAll("#admGaps table.admtab").length > 0', 'the recorded gap never showed up')

    const cols = await evalJs('[...document.querySelectorAll("#admGaps table.admtab th")].map(e => e.textContent)')
    assert.deepEqual(Array.from(cols).slice(0, 4), ['Anzahl', 'Text', 'Grund', 'Zuletzt'])
    assert.equal(await text('#admGaps .admlang'), 'Sprache: de')
    assert.equal(await text('#admGaps table.admtab tbody tr td.n'), '2', 'two sightings, one counted row')
    assert.equal(await text('#admGaps .admsample summary'), 'Auslösender Text')
  })

test('History: empty window and the rail summary are German', { timeout: 240_000 }, async () => {
  await asUser('de1')
  await S('Page.navigate', { url: base + '/history.html' })
  await waitFor('!document.getElementById("covBox").hidden', 'the rail summary never rendered')

  assert.equal(await text('.mhead h1'), 'Verlauf')
  assert.equal(await text('#covBox h3'), 'Dieser Ausschnitt')
  const rows = await evalJs('[...document.querySelectorAll("#covBox .covrow span:first-child")].map(e => e.textContent)')
  assert.deepEqual(Array.from(rows), ['Zeitraum', 'Aufgezeichnet', 'Ereignisse', 'Nettoänderung', 'C:D-Kurs'])
  assert.equal(await text('.evhead h2'), 'Was sich bewegt hat')
  // ONE permanent note in the rail, and it is the one about the event list.
  // How the divine figures are converted belongs to the (i) at the chart and
  // used to stand here a second time, word for word.
  const notes = await evalJs('[...document.querySelectorAll("#covBox .covnote")].map(e => e.textContent)')
  assert.equal(Array.from(notes).length, 1, 'the conversion note is standing permanently in the rail again')
  assert.match(Array.from(notes)[0], /^Ereignisse sind Bestandsbewegungen/)
  // The rate itself is a measurement, not prose, and stays: the row above is
  // what makes a negative net change readable at all (see the rows check).
  assert.match(await text('#covRate'), /\S/, 'the C:D rate row is a measurement and has to stay')

  // The (i) at the chart: an explanation ON REQUEST. Closed by default, opened
  // and closed again by the button — and German when it is open.
  assert.equal(await evalJs('document.getElementById("unitInfo").open'), false, 'the explanation must not stand there permanently')
  assert.equal(await evalJs('document.querySelector("#unitInfo > summary").getAttribute("aria-label")'),
    'Wie die Divine-Beträge gerechnet werden', 'the button has to be named for a screen reader')
  // On request is not the same as hidden. A bare glyph in an 18px circle was
  // not findable by anyone who did not know it was there, so the summary
  // carries a visible label — translated, and wide enough to read as a control.
  assert.equal(await text('#unitInfo > summary [data-i18n="hi.unitInfoBtn"]'), 'Divine-Beträge',
    'the button needs a visible, translated label')
  assert.ok(await evalJs('document.querySelector("#unitInfo > summary").offsetWidth >= 90'),
    'the button collapsed back to a bare glyph — nobody finds that')
  assert.ok(await evalJs('!!document.querySelector("#unitInfo > summary .caret")'),
    'the ▾ that says "this opens" is gone')
  await evalJs('document.querySelector("#unitInfo > summary").click()')
  assert.equal(await evalJs('document.getElementById("unitInfo").open'), true)
  assert.match(await text('#unitInfo p'), /^Jeder Punkt wird mit dem C:D-Kurs umgerechnet/)
  assert.match(await text('#unitInfo p'), /Netto-Verlust/, 'the sentence taken over from the rail note is missing')
  assert.match(await text('#unitInfo p'), /blasse Linie/, 'and it says what the pale line is for')
  await evalJs('document.querySelector("#unitInfo > summary").click()')
  assert.equal(await evalJs('document.getElementById("unitInfo").open'), false, 'the same button closes it again')

  // The two empty states of this page.
  assert.equal(await text('#chartEmpty'), 'Sammle Daten…')
  await waitFor('!document.getElementById("evNone").hidden', 'the "nothing recorded" note never appeared')
  assert.equal(await text('#evNone'), 'Für diesen Ausschnitt ist noch nichts aufgezeichnet.')

  const opts = await evalJs('[...document.querySelectorAll("#minSel option")].map(e => e.textContent)')
  assert.deepEqual(Array.from(opts), ['allem Aufgezeichneten', '0,5 Div', '1 Div', '3 Div', '10 Div'])
})

// The control: the same build, the same browser, a user the configuration puts
// on an English client. Without this the German could just as well be hardcoded.
test('the English user still gets English — the language comes from the mapping',
  { timeout: 240_000, skip: skipDe }, async () => {
    await asUser('en1')
    await S('Page.navigate', { url: base + '/' })
    await waitFor('window.I18n && window.I18n.lang() === "en"', 'the English user did not resolve to English')
    assert.equal(await text('.mhead h1'), 'Checked items')
    assert.equal(await text('#empty [data-i18n="pc.empty"]'), 'No items in the queue. Price-check something in-game.')
    await waitFor('document.getElementById("emptyHint").textContent !== ""', 'the daemon hint never appeared')
    assert.match(await text('#emptyHint'), /hotkey daemon/)
    assert.equal(await text('#clear'), 'Clear all')

    await S('Page.navigate', { url: base + '/networth.html' })
    await waitFor('window.I18n && window.I18n.lang() === "en"', 'the net-worth page did not resolve to English')
    assert.equal(await text('.mhead h1'), 'Net Worth')
    assert.equal(await text('#appStatus'), 'No credentials configured — open settings to add them.')

    await S('Page.navigate', { url: base + '/settings.html' })
    await waitFor('window.I18n && window.I18n.lang() === "en"', 'the settings page did not resolve to English')
    assert.equal(await text('.mhead h1'), 'Settings')
    const heads = await evalJs('[...document.querySelectorAll(".sect h2")].map(e => e.textContent)')
    assert.deepEqual(Array.from(heads), ['Client language', 'Sync settings', 'Releases', 'Sources', 'Admin area'])
    // The Sources block (B29) is filled from GET /source-status, one row per source.
    await waitFor('document.querySelectorAll("#srcRows tr").length === 4', 'the Sources block never filled')
    const srcNames = await evalJs('[...document.querySelectorAll("#srcRows tr td:first-child")].map(e => e.textContent)')
    assert.deepEqual(Array.from(srcNames),
      ['Faustus prices (GGG Currency Exchange)', 'poe.ninja Chaos:Divine', 'poe.ninja prices', 'Trade API'])
    assert.equal(await text('#admOpen'), 'Open')
    await waitFor('document.getElementById("langSel").value === "en"',
      'the English user is not shown as being on English')
    const langOpts = await evalJs('[...document.querySelectorAll("#langSel option")].map(o => o.textContent)')
    assert.deepEqual(Array.from(langOpts).sort(), ['English', 'German'])
  })
