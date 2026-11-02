// Shell consistency test (gitignored, local): all four pages fill the same
// slots in the same order — rail (brand, user, nav, league, C:D) and main head
// (mhead, conn, appStatus). That was exactly the brief of the UI overhaul; this
// test nails the order down so it cannot drift apart per page again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const here = p => fileURLToPath(new URL(p, import.meta.url))

const PAGES = [
  { file: 'index.html', name: 'Price Check' },
  { file: 'networth.html', name: 'Net Worth' },
  { file: 'history.html', name: 'History' },
  { file: 'settings.html', name: 'Settings' }
]

// Fixed slot order: every marker must be present and must appear AFTER the
// previous one (empty slots are fine, moved ones are not).
const SLOTS = [
  'class="rail"',      // shell: left rail
  'class="logo"',      // R1 brand
  'class="navlinks"',  // R2/R3 container
  'id="whoami"',       // R2 user
  'class="backlink',   // R3 nav entries
  'id="leagueSel"',    // R4 league
  'id="cdValue"',      // R5 C:D tile
  'class="mhead"',     // M1 head row
  'id="conn"',         // M1 live status
  'id="appStatus"'     // M2 status line
]

for (const page of PAGES) {
  test(`${page.file}: global slots present and in a fixed order`, async () => {
    const html = await readFile(here(page.file), 'utf8')
    let pos = -1
    for (const marker of SLOTS) {
      const i = html.indexOf(marker)
      assert.ok(i >= 0, `${marker} missing`)
      assert.ok(i > pos, `${marker} comes before the previous slot`)
      pos = i
    }
  })

  test(`${page.file}: nav lists every target, active page marked`, async () => {
    const html = await readFile(here(page.file), 'utf8')
    const nav = html.slice(html.indexOf('class="navlinks"'), html.indexOf('leaguebar'))
    const order = ['Price Check', 'Net Worth', 'History', 'Settings']
    let pos = -1
    for (const label of order) {
      const i = nav.indexOf(`>${label}<`)
      assert.ok(i >= 0, `nav entry "${label}" missing`)
      assert.ok(i > pos, `nav entry "${label}" out of order`)
      pos = i
    }
    // active entry: exactly one, namely the page itself, and not a link
    const on = nav.match(/class="backlink on"[^>]*>([^<]+)</g) || []
    assert.equal(on.length, 1, 'exactly one active nav entry')
    assert.ok(on[0].includes(page.name), `active entry is "${page.name}"`)
  })

  test(`${page.file}: shell.js is loaded before the page script`, async () => {
    const html = await readFile(here(page.file), 'utf8')
    const shellAt = html.indexOf('src="shell.js"')
    assert.ok(shellAt >= 0, 'shell.js missing')
    const pageScript = html.search(/src="(app|networth|history|settings)\.js"/)
    assert.ok(pageScript > shellAt, 'page script must come after shell.js')
  })
}
