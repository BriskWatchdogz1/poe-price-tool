// backend/v2/networth/integration.test.mjs
// Starts the REAL server.mjs on a random port (pattern: cluster/integration.test.mjs).
// networth-latest arrives on connect (null, no manual scan trigger any more —
// snapshots are filled exclusively by the 24/7 background refresher).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const NW_STORE = join(tmpdir(), `ppt-nw-int-${process.pid}.json`)

process.env.PORT = '0'
process.env.POE_HARVEST_DISABLED = '1'
process.env.POE_CLUSTER_STORE = join(tmpdir(), `ppt-cl-int-${process.pid}.json`)
process.env.POE_NETWORTH_STORE = NW_STORE
process.env.POE_NETWORTH_CONFIG = '/nonexistent/networth-users.json' // -> no creds
process.env.POE_USERS = 'player1,player2'

let mod, port

before(async () => {
  mod = await import('../server.mjs')
  port = mod.server.address().port
})

after(async () => {
  await new Promise(r => mod.server.close(r))
  await rm(NW_STORE, { force: true })
  await rm(process.env.POE_CLUSTER_STORE, { force: true })
})

// Buffer messages FROM socket creation on. Reason: the server sends the opening
// burst (league-state, cd-ratio, …, networth-latest) synchronously on connect,
// and the 'ws' lib emits those frames in the same tick right after 'open'.
// Attaching the 'message' listener only after `await connect()` (i.e. one
// microtask after 'open') would lose the burst messages. Hence the persistent
// buffer listener that collectUntil consults.
function connect (user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events`, { headers: { Cookie: `ppt_user=${user}` } })
    ws.seen = []
    ws.waiters = []
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString())
      ws.seen.push(msg)
      for (const w of ws.waiters.slice()) {
        if (w.predicate(msg)) { ws.waiters.splice(ws.waiters.indexOf(w), 1); w.resolve(msg) }
      }
    })
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function collectUntil (ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const buffered = ws.seen.find(predicate)
    if (buffered) return resolve(buffered)
    const t = setTimeout(() => reject(new Error(`timeout; seen: ${ws.seen.map(m => m.type)}`)), timeoutMs)
    ws.waiters.push({ predicate, resolve: m => { clearTimeout(t); resolve(m) } })
  })
}

test('connect: networth-latest (null, no snapshot yet) arrives in the opening burst', async () => {
  const ws = await connect('player1')
  const msg = await collectUntil(ws, m => m.type === 'networth-latest')
  assert.equal(msg.snapshot, null)
  ws.close()
})

test('networth-history -> empty list', async () => {
  const ws = await connect('player1')
  await collectUntil(ws, m => m.type === 'networth-latest')
  ws.send(JSON.stringify({ type: 'networth-history' }))
  const msg = await collectUntil(ws, m => m.type === 'networth-history')
  assert.deepEqual(msg.items, [])
  ws.close()
})
