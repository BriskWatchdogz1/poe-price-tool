// Browser test (headless Chrome, same CDP setup as shell-load.test.mjs): after a
// reload the mod picker of a card must show the selection its PRICE was searched
// with — not the item defaults.
//
// Reported symptom: the card said "Match mods 4" while the price and the listing
// count came from a 3-mod search (and the Corrupted toggle had jumped back from
// "no" to "any"), so nothing on screen told the user what had actually been
// searched.
//
// The server is imported IN-PROCESS (pattern: server.test.mjs) instead of being
// spawned, so the room can be seeded with a finished card directly: the reload
// path is what's under test, and re-pricing it would spend real trade-API budget
// on a test.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { quietEnv } from '../test-quiet-env.mjs'

// The full set that keeps a booted server off the network, applied before the
// dynamic import below — server.mjs reads the environment at module load. One
// list, imported: every file that wrote it out by hand left something out, and
// what kept being left out was the switch a WebSocket needs (test-quiet-env.mjs).
quietEnv()
process.env.PORT = '0'
process.env.POE_FAUSTUS_DISABLED = '1'
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_DATA_REFRESH_DISABLED = '1'
process.env.POE_REFERENCE_DISABLED = '1'
process.env.POE_NETWORTH_AUTOSYNC = '0'
process.env.POE_USERS = 'picker'

const CHROME = process.env.CHROME_BIN || 'google-chrome-stable'
const sleep = ms => new Promise(r => setTimeout(r, ms))

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

let mod
before(async () => { mod = await import('../server.mjs') })
after(async () => { await new Promise((resolve) => mod.server.close(resolve)) })

test('after a reload the picker shows the selection the price was searched with', { timeout: 180_000 }, async () => {
  const id = 'hypnotic-track-1'
  // A finished card as it exists after: paste (auto search, 3 mods ticked) ->
  // untick "Linked sockets", set Corrupted to "no", pull the ES minimum up to
  // 320 -> Search. The price below is the one THAT search returned.
  const room = mod.users.get('picker')
  room.items.clear()
  room.items.set(id, {
    id, item: {}, preset: { filters: {}, stats: [] },
    addedMsg: {
      type: 'item-added', id, name: 'Hypnotic Track', itemClass: 'Boots',
      rarity: 'rare', baseType: 'Warlock Boots', corrupted: false, priceStatus: 'queued',
      mods: [
        { text: 'Linked sockets', kind: 'links', selected: true, value: 4, valueRange: [1, 4] },
        { text: 'Energy Shield: #', kind: 'explicit', selected: true, value: 313, valueRange: [313, 345] },
        { text: '+#% total Elemental Resistance', kind: 'explicit', selected: true, value: 122, valueRange: [122, 133] }
      ]
    },
    alive: true,
    status: 'done',
    lastPrice: {
      type: 'price-result', id, display: 'single', currency: 'divine',
      priceLow: 8, priceHigh: 125, priceMedian: 52.5, count: 65,
      listings: [{ price: 8, currency: 'divine', seller: '@Someone', ageMinutes: 3 }]
    },
    selection: {
      corrupted: 'no',
      mods: [{ text: 'Energy Shield: #', min: 320 }, { text: '+#% total Elemental Resistance' }]
    }
  })

  const tmp = await mkdtemp(join(tmpdir(), 'ppt-picker-'))
  const dbg = await freePort()
  const base = `http://127.0.0.1:${mod.server.address().port}`

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${dbg}`, `--user-data-dir=${join(tmp, 'chrome')}`,
    '--window-size=1280,900', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let verUrl = null
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${dbg}/json/version`)
      if (r.ok) { verUrl = (await r.json()).webSocketDebuggerUrl; break }
    } catch {}
    await sleep(100)
  }
  assert.ok(verUrl, 'Chrome DevTools reachable')

  const cdp = await cdpConnect(verUrl)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const S = (m, p) => cdp.send(m, p, sessionId)
  await S('Page.enable'); await S('Runtime.enable')
  await S('Network.enable')
  await S('Network.setCookie', { name: 'ppt_user', value: 'picker', url: base + '/' })

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }

  // Everything the card claims, picker and price block side by side.
  //
  // `priced` is the readiness flag, and it is deliberately not one of the
  // values under test. A reconnect replays TWO messages per card — `item-added`
  // (which builds the card) and the `price-result` right behind it (which fills
  // the price block in a second render, see applyPriceResult in app.js). Waiting
  // for `.card` alone therefore snapshots a card that exists but has no price
  // yet, and app.js renders exactly that state as "in queue" (priceHtml's first
  // branch: no price and not error/searching/rate-limited). That is the flake:
  // the run below asserted the listing count against a card the second message
  // had not reached. So the loop waits for the price block to have LEFT its
  // waiting state — a signal from the render path, independent of the count,
  // the mod ticks and the corruption toggle the assertions then check.
  const SNAP = `(() => {
    const c = document.querySelector('.card')
    if (!c) return null
    const pr = c.querySelector('.pblock .pr')
    const rows = [...c.querySelectorAll('.mrow')].map(r => ({
      text: r.dataset.text,
      defsel: r.dataset.defsel,
      checked: !!(r.querySelector('.chk') && r.querySelector('.chk').checked),
      min: r.querySelector('.slmin') ? r.querySelector('.slmin').value : null,
      max: r.querySelector('.slmax') ? r.querySelector('.slmax').value : null
    }))
    return {
      priced: !!pr && !pr.classList.contains('wait'),
      rows,
      modbarCount: c.querySelector('.modbar .cnt').textContent,
      footCount: c.querySelector('.ed-foot .sel').textContent,
      corrupted: c.querySelector('.ctog').dataset.val,
      corruptedOn: c.querySelector('.ctog button.on').dataset.c,
      hits: c.querySelector('.pblock .hits').textContent
    }
  })()`

  try {
    await S('Page.navigate', { url: base + '/' })
    let snap = null
    for (let i = 0; i < 150; i++) {
      snap = await evalJs(SNAP)
      if (snap && snap.priced) break
      await sleep(100)
    }
    assert.ok(snap, 'the replayed card is rendered')
    // Reached only if the price block stayed on a waiting state for the whole
    // budget — i.e. the replayed price never arrived at all. That is a real
    // failure, and it says so here rather than surfacing as a confusing
    // "expected 65, got in queue" three lines down.
    assert.ok(snap.priced, `the replayed price reached the card (price block still reads "${snap.hits}")`)

    // The price block shows the 2-mod search's result ...
    assert.match(snap.hits, /65/, 'the replayed listing count is on the card')
    // ... so the picker has to show that same 2-mod selection.
    const ticked = snap.rows.filter(r => r.checked).map(r => r.text)
    assert.deepEqual(ticked, ['Energy Shield: #', '+#% total Elemental Resistance'],
      'exactly the mods the price was searched with are ticked')
    assert.equal(snap.modbarCount, '2', '"Match mods" counts the searched mods, not the defaults')
    assert.equal(snap.footCount, '2', 'the editor footer agrees')

    const es = snap.rows.find(r => r.text === 'Energy Shield: #')
    assert.equal(es.min, '320', 'the roll minimum the user searched with is back')
    assert.equal(es.max, '345', 'an omitted upper bound means the handle sits at the ceiling')
    const res = snap.rows.find(r => r.text === '+#% total Elemental Resistance')
    assert.equal(res.min, '122', 'a bound-less mod keeps its stops')
    assert.equal(res.max, '133')

    assert.equal(snap.corrupted, 'no', 'the corruption filter is the one that was searched')
    assert.equal(snap.corruptedOn, 'no', 'and the toggle button shows it')

    // The item's OWN defaults must survive as the reset target — the restored
    // selection is a state on top of them, not a replacement.
    const links = snap.rows.find(r => r.text === 'Linked sockets')
    assert.equal(links.checked, false, 'the mod the user unticked stays unticked')
    assert.equal(links.defsel, '1', 'but "↺ Reset" still knows it was on by default')
    const afterReset = await evalJs(`(() => {
      document.querySelector('.card .resetbtn').click()
      const c = document.querySelector('.card')
      return { count: c.querySelector('.modbar .cnt').textContent,
               links: c.querySelector('.mrow[data-text="Linked sockets"] .chk').checked }
    })()`)
    assert.equal(afterReset.count, '3', 'Reset goes back to the item defaults')
    assert.equal(afterReset.links, true, 'including the mod the user had unticked')
  } finally {
    cdp.close()
    chrome.kill('SIGTERM')
    await sleep(200)
    room.items.clear()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
