/* Mock server for the Trade Console v2 frontend.
 *
 * - Serves backend/v2/frontend/ statically.
 * - Holds a WebSocket endpoint at /events.
 * - Simulates a realistic price-check session: cd-ratio, a burst of item-added
 *   cards that move queued -> searching -> priced, periodic queue-status with
 *   changing depth + rate-limit snapshot, and priority requeries on `search`.
 *
 * Only dependency: `ws` (the same one server.mjs uses).
 * Start:  node backend/v2/mock-server.mjs   (PORT env optional, default 8788)
 *
 * This is a standalone stand-in; it shares no state with server.mjs.
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const FE_DIR = fileURLToPath(new URL('./frontend/', import.meta.url))
const PORT = Number(process.env.PORT) || 8788

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.map': 'application/json'
}

// ---- static file serving (locked into FE_DIR) ------------------------------
async function serveStatic (urlPath, res) {
  const clean = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '')
  const filePath = join(FE_DIR, clean)
  if (!filePath.startsWith(FE_DIR)) { res.writeHead(403).end(); return }
  try {
    const s = await stat(filePath)
    const target = s.isDirectory() ? join(filePath, 'index.html') : filePath
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
  }
}

const server = createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); return }
  serveStatic(req.url.split('?')[0], res)
})

// ---- WebSocket /events -----------------------------------------------------
const wss = new WebSocketServer({ server, path: '/events' })

// ---------------------------------------------------------------------------
// Scenario data
// ---------------------------------------------------------------------------
const listing = (price, currency, seller, ageMinutes) => ({ price, currency, seller, ageMinutes })

function scenarioItems () {
  return [
    {
      item: {
        id: 'mageblood', name: 'Mageblood', itemClass: 'Belt', rarity: 'unique',
        baseType: 'Heavy Belt', corrupted: false,
        mods: [
          { text: 'Leftmost 4 Magic Utility Flasks constantly apply their Flask Effects', kind: 'explicit', selected: false },
          { text: '+36 to Dexterity', kind: 'explicit', value: 36, valueRange: [30, 50], selected: true },
          { text: '+23% to Fire Resistance', kind: 'explicit', value: 23, valueRange: [15, 25], selected: true },
          { text: '+25% to Cold Resistance', kind: 'explicit', value: 25, valueRange: [15, 25], selected: true }
        ]
      },
      price: {
        display: 'single', currency: 'divine', priceLow: 125, priceHigh: 170, count: 259,
        listings: [
          listing(128, 'divine', '@Exilequeen', 4),
          listing(130, 'divine', '@Sixlink_Sam', 12),
          listing(132, 'divine', '@ChaosMerchant', 61)
        ]
      },
      addDelay: 400, searchDelay: 1500
    },
    {
      item: {
        id: 'behemoth-locket', name: 'Behemoth Locket', itemClass: 'Amulet', rarity: 'rare',
        baseType: 'Onyx Amulet', corrupted: false,
        mods: [
          { text: '+22 to all Attributes', kind: 'implicit', value: 22, selected: false },
          { text: '+72 to maximum Life', kind: 'prefix', tier: 6, value: 72, valueRange: [60, 79], selected: true },
          { text: '18% increased Spell Damage', kind: 'prefix', tier: 4, value: 18, valueRange: [15, 24], selected: false },
          { text: '54% increased Global Critical Strike Chance', kind: 'suffix', tier: 2, value: 54, valueRange: [46, 58], selected: true },
          { text: '+42% to Cold Resistance', kind: 'suffix', tier: 3, value: 42, valueRange: [36, 45], selected: true },
          { text: '+30 to Intelligence', kind: 'suffix', tier: 4, value: 30, valueRange: [25, 33], selected: false }
        ]
      },
      price: {
        display: 'single', currency: 'chaos', priceLow: 25, priceHigh: 40, count: 18,
        listings: [
          listing(25, 'chaos', '@BudgetGear', 6),
          listing(30, 'chaos', '@AmuletKing', 40),
          listing(38, 'chaos', '@RareBazaar', 95)
        ]
      },
      addDelay: 750, searchDelay: 2600
    },
    {
      item: {
        id: 'chaos-orb', name: 'Chaos Orb', itemClass: 'Currency', rarity: 'currency',
        baseType: 'Chaos Orb', corrupted: false,
        mods: [
          { text: 'Reforges a rare item with new random modifiers', kind: 'implicit', selected: false },
          { text: 'Minimum stock 500 per listing', kind: 'explicit', value: 500, valueRange: [100, 5000], selected: true }
        ]
      },
      price: {
        display: 'bulk', currency: 'chaos', priceLow: 215, priceHigh: 215, count: 47,
        listings: [
          listing(214, 'chaos', '@BulkBazaar · 4k stock', null),
          listing(215, 'chaos', '@FastCurrency · 1.8k stock', null),
          listing(216, 'chaos', '@OrbFactory · 900 stock', null)
        ]
      },
      addDelay: 1100, searchDelay: 3600
    },
    {
      item: {
        id: 'replica-iron-commander', name: 'Replica Iron Commander', itemClass: 'Bow', rarity: 'unique',
        baseType: 'Death Bow', corrupted: true,
        mods: [
          { text: 'Adds 6 to 11 Physical Damage', kind: 'implicit', selected: false },
          { text: '16% increased Attack Speed', kind: 'explicit', value: 16, valueRange: [12, 20], selected: true },
          { text: '+1 to maximum number of Summoned Totems per 200 Strength', kind: 'explicit', selected: false }
        ]
      },
      price: {
        display: 'single', currency: 'divine', priceLow: 2, priceHigh: 20, count: 73,
        listings: [
          listing(2, 'divine', '@LeagueStarter', 8),
          listing(11, 'divine', '@MirrorService', 182),
          listing(18, 'divine', '@CorruptKing', 320)
        ]
      },
      addDelay: 1450, searchDelay: 4600
    },
    {
      item: {
        id: 'quicksilver-flask', name: "Experimenter's Quicksilver Flask of Adrenaline",
        itemClass: 'Flask', rarity: 'magic', baseType: 'Quicksilver Flask', corrupted: false,
        mods: [
          { text: '28% increased Duration', kind: 'prefix', tier: 'Prefix', value: 28, valueRange: [20, 35], selected: true },
          { text: '20% increased Movement Speed when used', kind: 'suffix', tier: 'Suffix', value: 20, valueRange: [10, 20], selected: true }
        ]
      },
      price: {
        display: 'single', currency: 'chaos', priceLow: 3, priceHigh: 8, count: 140,
        listings: [
          listing(3, 'chaos', '@FlaskFactory', 2),
          listing(5, 'chaos', '@SpeedRunner', 15)
        ]
      },
      addDelay: 1750, searchDelay: 5600
    }
  ]
}

// jitter a done price a little so a requery visibly changes numbers
function requery (price) {
  const bump = () => Math.floor(Math.random() * 7) - 3
  const low = Math.max(1, price.priceLow + bump())
  const high = Math.max(low, price.priceHigh + bump())
  const count = Math.max(1, price.count + (Math.floor(Math.random() * 21) - 10))
  return { ...price, priceLow: low, priceHigh: high, count }
}

// ---------------------------------------------------------------------------
// Per-connection simulation
// ---------------------------------------------------------------------------
wss.on('connection', ws => {
  const send = obj => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)) }
  const timers = []
  const later = (ms, fn) => timers.push(setTimeout(fn, ms))

  const items = new Map()      // id -> scenario entry
  const alive = new Set()      // ids still on screen (not dismissed)
  let chaosPerDivine = 215

  // 1) opening ratio
  send({ type: 'cd-ratio', chaosPerDivine, trendHint: '▲ +9 / wk' })

  // 2) drift the ratio a touch over time (live feel)
  const cdTimer = setInterval(() => {
    chaosPerDivine += Math.floor(Math.random() * 5) - 2
    send({ type: 'cd-ratio', chaosPerDivine, trendHint: '▲ +9 / wk' })
  }, 7000)

  // 3) stream items in: queued -> (soon) searching -> priced
  for (const entry of scenarioItems()) {
    items.set(entry.item.id, entry)
    alive.add(entry.item.id)
    later(entry.addDelay, () => {
      send({ type: 'item-added', ...entry.item, priceStatus: 'queued' })
      // move to searching shortly, then deliver a price
      later(600, () => send({ type: 'item-added', ...entry.item, priceStatus: 'searching' }))
      later(entry.searchDelay - entry.addDelay + 600, () => {
        send({ type: 'price-result', id: entry.item.id, ...entry.price })
      })
    })
  }

  // 4) periodic queue-status with wandering depth + rate-limit snapshot
  let tick = 0
  const qTimer = setInterval(() => {
    tick++
    const depth = Math.max(0, 3 - Math.floor(tick / 2) + (Math.random() < 0.4 ? 1 : 0))
    send({
      type: 'queue-status',
      depth,
      priorityActive: false,
      rateLimits: [
        { policy: 'trade-search', used: 2 + (tick % 5), limit: 8, windowSec: 10 },
        { policy: 'trade-fetch', used: 5 + (tick % 9), limit: 12, windowSec: 5 },
        { policy: 'account', used: 40 + tick, limit: 60, windowSec: 60 }
      ]
    })
  }, 2200)

  // 5) react to client messages
  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.type === 'search') {
      const entry = items.get(msg.id)
      if (!entry || !alive.has(msg.id)) return
      // show the priority immediately
      send({
        type: 'queue-status', depth: 4, priorityActive: true,
        rateLimits: [
          { policy: 'trade-search', used: 6, limit: 8, windowSec: 10 },
          { policy: 'trade-fetch', used: 9, limit: 12, windowSec: 5 },
          { policy: 'account', used: 44, limit: 60, windowSec: 60 }
        ]
      })
      // ~1s later: a fresh price result (proves priority requery)
      later(1000, () => {
        send({ type: 'price-result', id: msg.id, ...requery(entry.price) })
        send({
          type: 'queue-status', depth: 2, priorityActive: false,
          rateLimits: [
            { policy: 'trade-search', used: 4, limit: 8, windowSec: 10 },
            { policy: 'trade-fetch', used: 6, limit: 12, windowSec: 5 },
            { policy: 'account', used: 45, limit: 60, windowSec: 60 }
          ]
        })
      })
    }

    if (msg.type === 'dismiss') {
      alive.delete(msg.id)
    }
  })

  ws.on('close', () => {
    clearInterval(cdTimer); clearInterval(qTimer)
    for (const t of timers) clearTimeout(t)
  })
})

server.listen(PORT, () => {
  console.log(`[mock-server] http + ws on http://localhost:${PORT}  (ws: /events)`)
  console.log(`[mock-server] serving ${FE_DIR}`)
})
