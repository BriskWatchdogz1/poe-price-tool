// The unpriced block under the Net-Worth table has to obey the stash-tab
// selection, exactly like the priced table above it. It did not: the snapshot's
// unpriced rows were merged by NAME across all tabs, so tab membership was gone
// by the time the page rendered them — unchecking every tab but one still
// listed the divination cards from the (unchecked) Divination tab.
// Boots the real server on a two-tab store snapshot and clicks in a real Chrome.
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

// Two tabs, both with unpriced content, only one with a priced item — the shape
// of the reported case (a Delve tab selected, a Divination tab unchecked).
//
// Every number is deliberately different from every other one, because the
// summary line and the list under it speak in PIECES while the per-tab counts
// speak in ENTRIES, and the page used to print both as "items" (B18):
//   DELVE  — 4 stash entries holding 31 pieces, of which the 100-name display
//            cap leaves one row of 30 on screen. That hidden piece is the "40
//            over a list of 39" of the report, in miniature.
//   Divin. — 9 entries, 9 pieces, one row, nothing hidden.
const DELVE_ENTRIES = 4
const DELVE_PIECES = 31
const DELVE_SHOWN = 30
const DIV_ENTRIES = 9
const DIV_PIECES = 9
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
            name: 'DELVE',
            syncedAt: Date.now(),
            items: [{ name: 'Sanctified Fossil', kind: 'stackable', tab: 'DELVE', tabIndex: 0, qty: 1, chaosEach: 200, chaosTotal: 200 }],
            unpriced: [{ name: 'Metallic Fossil', kind: 'stackable', count: DELVE_SHOWN }],
            counts: { priced: 1, unpriced: DELVE_ENTRIES, unpricedPieces: DELVE_PIECES, skipped: 0 }
          },
          1: {
            index: 1,
            name: 'Divination',
            syncedAt: Date.now(),
            items: [],
            unpriced: [{ name: 'Prosperity', kind: 'divcard', count: DIV_PIECES }],
            counts: { priced: 0, unpriced: DIV_ENTRIES, unpricedPieces: DIV_PIECES, skipped: 0 }
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

test('unpriced block follows the stash-tab selection', { timeout: 120_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-unp-'))
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
  const unpricedNames = () => evalJs(`[...document.querySelectorAll('#unpricedList li')].map(li => li.textContent)`)
  const unpricedSummary = () => evalJs(`document.getElementById('unpricedSummary').textContent`)
  const tabCells = () => evalJs(`[...document.querySelectorAll('#wrap tbody .tabcell')].map(td => td.textContent)`)
  // What the ×N of the rows actually add up to. The summary has to open with
  // this number — the headline used to be in a different unit (stash entries)
  // and could sit either side of it.
  const listedPieces = () => evalJs(
    `[...document.querySelectorAll('#unpricedList li')]
       .reduce((sum, li) => sum + Number(li.textContent.match(/×(\\d+)/)[1]), 0)`)
  const summaryAgreesWithList = async (why) => {
    const summary = await unpricedSummary()
    const pieces = await listedPieces()
    const rows = (await unpricedNames()).length
    assert.match(summary, new RegExp(`^${pieces} pcs unpriced across ${rows} name${rows === 1 ? '' : 's'} `),
      `${why}: the summary must state the list's own pieces and rows — got "${summary}"`)
  }

  try {
    await S('Page.navigate', { url: base + '/networth.html' })
    for (let i = 0; i < 100; i++) {
      if ((await evalJs(`document.querySelectorAll('#unpricedList li').length`)) >= 2) break
      await sleep(100)
    }

    // Every tab on: both tabs' unpriced names show, the summary states the
    // pieces and names it is actually showing, and says separately how many
    // pieces the display cap kept out (one, from DELVE).
    let names = await unpricedNames()
    assert.equal(names.length, 2, 'both tabs contribute while everything is selected\n' + srvLog.join(''))
    assert.ok(names.some(n => n.includes('Prosperity')), 'divination card listed')
    assert.ok(names.some(n => n.includes('Metallic Fossil')), 'fossil listed')
    assert.equal(await unpricedSummary(),
      `${DELVE_SHOWN + DIV_PIECES} pcs unpriced across 2 names (not counted)` +
      ` · ${DELVE_PIECES - DELVE_SHOWN} pcs not listed`)
    await summaryAgreesWithList('all tabs on')

    // One click on the sidebar row unchecks the Divination tab (index 1).
    await evalJs(`document.querySelector('.tabrow[data-idx="1"]').click()`)

    // Control: the priced table is scoped (it always was).
    assert.deepEqual([...new Set(await tabCells())], ['DELVE'], 'priced table shows only the selected tab')

    // The point of this test: so is the unpriced block.
    names = await unpricedNames()
    assert.deepEqual(names.map(n => n.split(' ×')[0]), ['Metallic Fossil'],
      'unpriced block must drop the unchecked tab\'s items')
    // Scoped to the one selected tab — and "1 name", not "1 names".
    assert.equal(await unpricedSummary(),
      `${DELVE_SHOWN} pcs unpriced across 1 name (not counted) · ${DELVE_PIECES - DELVE_SHOWN} pcs not listed`)
    await summaryAgreesWithList('one tab unchecked')

    // A kind chip narrows the selection to something no tab count can answer.
    // The line then states only what it can see — and still agrees with it.
    await evalJs(`[...document.querySelectorAll('#kindChips .chip')].find(c => c.dataset.k === 'stackable').click()`)
    assert.equal(await unpricedSummary(), `${DELVE_SHOWN} pcs unpriced across 1 name (not counted)`,
      'nothing is claimed about what is missing when the selection is not expressible in tabs')
    await summaryAgreesWithList('kind chip active')
    await evalJs(`[...document.querySelectorAll('#kindChips .chip')].find(c => c.dataset.k === '').click()`)

    // Back on -> both again (the filter is live, not a one-way trim).
    await evalJs(`document.querySelector('.tabrow[data-idx="1"]').click()`) // -> ignored
    await evalJs(`document.querySelector('.tabrow[data-idx="1"]').click()`) // -> on
    assert.equal((await unpricedNames()).length, 2, 'selecting the tab again brings its unpriced items back')
  } finally {
    cdp.close()
    chrome.kill('SIGTERM')
    srv.kill('SIGTERM')
    await sleep(200)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
