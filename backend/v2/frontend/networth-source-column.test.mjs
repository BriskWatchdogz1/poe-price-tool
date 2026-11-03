// The Net-Worth table has to say which FEED priced a row. It did not, and
// docs/bugs.md B20 is the bill for it: four divination cards were measured
// against the in-game Currency Exchange, two of them 30-70x too high, and
// nobody can say to this day whether those numbers came from the GGG digest
// (Faustus) or from the poe.ninja exchange line behind it — both paths admit
// the reported magnitudes (backend/v2/networth/faustus.test.mjs and
// valuator.test.mjs, same marker). The value has ridden along in the snapshot
// since the price guard needed it for its log line; only the page was silent.
//
// Boots the real server on a store snapshot and reads the rendered table in a
// real Chrome, like the other Net-Worth page tests here.
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

// Three rows, three answers to "where did this price come from":
//   - the GGG digest (`faustus`),
//   - the poe.ninja card exchange (`exchange:DivinationCard`) — the other
//     candidate path for B20's two wrong cards,
//   - a row from a backend that predates the field at all (no `source`), which
//     must print an em dash and must not sort as the string "null".
function mockStore (user = 'player1') {
  const items = [
    { name: 'Divine Orb', kind: 'stackable', tab: 'A', tabIndex: 0, qty: 3, chaosEach: 200, chaosTotal: 600, source: 'faustus' },
    { name: 'Imperial Legacy', kind: 'divcard', tab: 'A', tabIndex: 0, qty: 14, chaosEach: 4.6, chaosTotal: 64.4, source: 'exchange:DivinationCard' },
    { name: 'Ancient Orb', kind: 'stackable', tab: 'A', tabIndex: 0, qty: 1, chaosEach: 30, chaosTotal: 30 }
  ]
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
            name: 'A',
            syncedAt: Date.now(),
            items,
            unpriced: [],
            counts: { priced: 3, unpriced: 0, unpricedPieces: 0, skipped: 0 }
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

test('every priced row names the feed that priced it', { timeout: 120_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-src-'))
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
  const headers = () => evalJs(`[...document.querySelectorAll('#wrap thead th')].map(th => th.textContent.replace(/[▲▼]/g, ''))`)
  const sources = () => evalJs(`[...document.querySelectorAll('#wrap tbody tr')].map(tr => tr.querySelector('.srccell').textContent)`)
  // The item cell leads with the kind badge ("Divination Cards…"), which is
  // not part of the name — drop it.
  const names = () => evalJs(
    `[...document.querySelectorAll('#wrap tbody tr')].map(tr =>
       tr.querySelector('.iname').textContent.replace(tr.querySelector('.kb')?.textContent || '', '').trim())`)

  try {
    await S('Page.navigate', { url: base + '/networth.html' })
    for (let i = 0; i < 100; i++) {
      if ((await evalJs(`document.querySelectorAll('#wrap tbody tr').length`)) >= 3) break
      await sleep(100)
    }

    // The page opens in the grouped view; the flat list is the one this test
    // reads first.
    await evalJs(`document.querySelector('#viewSeg button[data-v="list"]').click()`)
    assert.deepEqual(await headers(), ['Item', 'Tab', 'Qty', 'Each', 'Total', 'Confidence', 'Source'],
      'the table has to name the feed\n' + srvLog.join(''))

    // Default sort is total value descending: Divine Orb 600, Imperial Legacy
    // 64.4, Ancient Orb 30.
    assert.deepEqual(await sources(), ['faustus', 'exchange:DivinationCard', '—'],
      'each row states its own source, and a row without one states nothing rather than something')

    // Sorting by the new column must work on the mixed set, missing value
    // included — a non-numeric column must not end in a NaN comparison.
    await evalJs(`document.querySelector('#wrap thead th[data-k="source"]').click()`)
    assert.deepEqual(await sources(), ['—', 'exchange:DivinationCard', 'faustus'],
      'text sorts as text, and the row without a source is not the string "null" in the middle')
    assert.deepEqual(await names(), ['Ancient Orb', 'Imperial Legacy', 'Divine Orb'],
      'the rows themselves moved with their source, not just the cells')
    await evalJs(`document.querySelector('#wrap thead th[data-k="source"]').click()`)
    assert.deepEqual(await sources(), ['faustus', 'exchange:DivinationCard', '—'], 'and back the other way')

    // The grouped view carries the same column (same COLS table).
    await evalJs(`document.querySelector('#viewSeg button[data-v="grouped"]').click()`)
    for (let i = 0; i < 50; i++) {
      if ((await evalJs(`document.querySelectorAll('#wrap .grp').length`)) >= 2) break
      await sleep(50)
    }
    const groupHeaders = await evalJs(
      `[...document.querySelectorAll('#wrap .grp')].map(g => [...g.querySelectorAll('thead th')].map(th => th.textContent.replace(/[▲▼]/g, '')))`)
    assert.ok(groupHeaders.length >= 2, 'both kinds got a group')
    for (const h of groupHeaders) {
      assert.deepEqual(h, ['Item', 'Tab', 'Qty', 'Each', 'Total', 'Confidence', 'Source'],
        'the grouped view must not be the one place a price has no origin')
    }
  } finally {
    cdp.close()
    chrome.kill('SIGTERM')
    srv.kill('SIGTERM')
    await sleep(200)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
