// "Listed below market" on the Net Worth page: every stored price note under
// the tool's own market value, by the whisper verdict's rule, sorted by the
// chaos lost. Boots the real server on a store whose tabs carry price notes
// (networth-store.json `listed`) and reads the block in a real Chrome.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { QUIET_ENV } from '../test-quiet-env.mjs'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CHROME = process.env.CHROME_BIN || 'google-chrome-stable'

function freePort () {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const NOW = Date.now()
const L = (name, note, chaosEach, over = {}) => ({ name, kind: 'unique', qty: 1, x: 0, y: 0, note, fromTab: false, chaosEach, uncertain: null, ...over })
const row = (name, tab, tabIndex, qty, chaosEach, kind = 'unique') =>
  ({ name, kind, tab, tabIndex, qty, chaosEach, chaosTotal: chaosEach * qty, source: 'mock', uncertain: null })
function mockStore (user = 'player1') {
  return JSON.stringify({
    schema_version: 2,
    users: {
      [user]: {
        accountName: 'acct',
        league: 'Standard',
        cdRatio: 214,
        tabs: {
          0: {
            index: 0,
            name: 'Sale',
            syncedAt: NOW,
            items: [row('Headhunter', 'Sale', 0, 1, 900), row('Mageblood', 'Sale', 0, 1, 5000),
              row('Fair Ring', 'Sale', 0, 1, 100), row('The Doctor', 'Sale', 0, 3, 50, 'divcard')],
            unpriced: [],
            counts: { priced: 4, unpriced: 0, unpricedPieces: 0, skipped: 0 },
            listed: [
              L('Headhunter', '~price 100 chaos', 900, { x: 2, y: 4 }), // loss 800
              L('Mageblood', '~price 1 divine', 5000),                   // the rate is the fallback here
              L('Fair Ring', '~price 95 chaos', 100),                    // fair: not listed
              L('The Doctor', '~price 10 chaos', 50, { kind: 'divcard', qty: 3, x: 5, y: 0 }) // loss 120
            ]
          },
          1: {
            index: 1,
            name: 'Uniques',
            syncedAt: NOW,
            items: [row('Tabula Rasa', 'Uniques', 1, 1, 10)],
            unpriced: [],
            counts: { priced: 1, unpriced: 0, unpricedPieces: 0, skipped: 0 },
            listed: [
              L('Tabula Rasa', '~b/o 5 chaos', 10, { x: 13, y: 20 }), // loss 5
              // Stored unrounded (5.45 c): shown to one decimal, so the two
              // prices do not both read "5 c" next to a ratio of 0.84.
              L('Odd Ring', '~price 4.6 chaos', 5.45, { x: 1, y: 1 })  // loss 0.85
            ]
          },
          3: {
            // A tab priced by its name: every entry in it is listed, 100 of
            // them below the market by 0.5 c each. With the 4 above, 104 rows
            // are below; the snapshot carries the 100 biggest losses.
            index: 3,
            name: '~price 1 chaos',
            syncedAt: NOW,
            items: [],
            unpriced: [],
            counts: { priced: 100, unpriced: 0, unpricedPieces: 0, skipped: 0 },
            listed: Array.from({ length: 100 }, (_, i) =>
              L(`Filler ${i}`, '~price 1 chaos', 1.5, { kind: 'stackable', fromTab: true, x: i % 12, y: Math.floor(i / 12) }))
          },
          2: {
            // Stored before notes were kept: no `listed` key at all.
            index: 2,
            name: 'Old',
            syncedAt: NOW,
            items: [row('Goldrim', 'Old', 2, 1, 50)],
            unpriced: [],
            counts: { priced: 1, unpriced: 0, unpricedPieces: 0, skipped: 0 }
          }
        },
        history: []
      }
    }
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

test('listed-below-market block lists notes under the market value, by loss', { timeout: 120_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-below-'))
  const port = await freePort()
  const dbg = await freePort()
  await writeFile(join(tmp, 'networth-store.json'), mockStore(), 'utf8')

  const srv = spawn(process.execPath, [join(ROOT, 'backend/v2/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      // The full set that keeps a booted server off the network — one list,
      // imported, because every file that wrote it out by hand got it wrong.
      // Spread first, so anything below may still override it deliberately.
      ...QUIET_ENV,
      PORT: String(port),
      POE_USERS: 'player1,player2',
      POE_NETWORTH_STORE: join(tmp, 'networth-store.json'),
      POE_NETWORTH_HISTORY: join(tmp, 'networth-history.ndjson'),
      POE_NETWORTH_AUTOSYNC: '0',
      POE_FAUSTUS_DISABLED: '1',
      POE_CORPSE_DISABLED: '1',
      POE_DATA_REFRESH_DISABLED: '1',
      POE_REFERENCE_DISABLED: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const srvLog = []
  srv.stdout.on('data', d => srvLog.push(String(d)))
  srv.stderr.on('data', d => srvLog.push(String(d)))

  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/users`); if (r.ok) break } catch {}
    await sleep(100)
  }

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
  const base = `http://127.0.0.1:${port}`
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const S = (m, p) => cdp.send(m, p, sessionId)
  await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable')
  await S('Network.setCookie', { name: 'ppt_user', value: 'player1', url: base + '/' })

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }

  try {
    await S('Page.navigate', { url: base + '/networth.html' })
    for (let i = 0; i < 100; i++) {
      if ((await evalJs(`document.querySelectorAll('#belowList tbody tr').length`)) >= 3) break
      await sleep(100)
    }
    const rows = () => evalJs(`[...document.querySelectorAll('#belowList tbody tr')].map(tr => [...tr.cells].map(td => td.textContent.trim()))`)

    assert.equal(await evalJs(`document.getElementById('belowBox').hidden`), false, 'block shown\n' + srvLog.join(''))
    assert.equal(await evalJs(`document.querySelector('#belowBox h3').textContent.trim()`), 'Listed below market')
    const r = await rows()
    // Sorted by the chaos lost; the fair one and the divine one (the rate is
    // the fallback in a server with no live sources) are not rows.
    assert.deepEqual(r.slice(0, 5).map(c => c[0]), ['Headhunter', 'The Doctor ×3', 'Tabula Rasa', 'Odd Ring', 'Filler 0'], JSON.stringify(r.slice(0, 5)))
    // Item, tab, position, listed, market, ratio, in that order.
    assert.deepEqual(r[0], ['Headhunter', 'Sale', 'left 3, top 5', '100 c', '900 c', '0.11 (−89 %)'])
    assert.deepEqual(r[1], ['The Doctor ×3', 'Sale', 'left 6, top 1', '30 c', '150 c', '0.2 (−80 %)'])
    assert.deepEqual(r[2], ['Tabula Rasa', 'Uniques', 'left 14, top 21', '5 c', '10 c', '0.5 (−50 %)'])
    assert.deepEqual(r[3], ['Odd Ring', 'Uniques', 'left 2, top 2', '4.6 c', '5.5 c', '0.84 (−16 %)'])
    assert.deepEqual(r[4], ['Filler 0', '~price 1 chaos (tab price)', 'left 1, top 1', '1 c', '1.5 c', '0.67 (−33 %)'])
    // 104 below the market, 100 sent; the rest is counted, not dropped silently.
    assert.equal(r.length, 100)
    assert.equal(await evalJs(`document.getElementById('belowMore').textContent.trim()`),
      '4 more below the market, not listed (the 100 biggest losses are shown)')
    // What was not compared is said, so a missing row is not read as fair.
    assert.equal(await evalJs(`document.getElementById('belowSkipped').textContent.trim()`),
      'Not compared: 1 priced in divine (the Chaos:Divine rate is the fallback or stale)')

    // The block is about what is up for sale, not about the selection:
    // a tab taken out of the count keeps its listings, also when the block
    // is drawn again (a language switch redraws the whole snapshot).
    await evalJs(`document.querySelector('.tabrow[data-idx="1"]').click()`)
    assert.match(await evalJs(`document.querySelector('.tabrow[data-idx="1"]').className`), /\bst-off\b/, 'tab 1 is out of the count')
    await evalJs(`I18n.setLang('de')`)
    for (let i = 0; i < 50; i++) {
      if ((await evalJs(`document.querySelector('#belowBox h3').textContent.trim()`)) === 'Unter Marktwert eingestellt') break
      await sleep(100)
    }
    assert.equal(await evalJs(`document.querySelector('#belowBox h3').textContent.trim()`), 'Unter Marktwert eingestellt')
    const de = await rows()
    assert.equal(de.length, 100, 'tab selection does not filter the block')
    assert.deepEqual(de[2].slice(0, 3), ['Tabula Rasa', 'Uniques', '14 von links, 21 von oben'])
    assert.match(await evalJs(`document.querySelector('.tabrow[data-idx="1"]').className`), /\bst-off\b/, 'still out of the count after the redraw')
  } finally {
    cdp.close()
    chrome.kill('SIGTERM')
    srv.kill('SIGTERM')
    await sleep(200)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
