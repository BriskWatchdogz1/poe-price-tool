// daemon/poe-price-post.sh — the clipboard language filter.
//
// Why this lives here: `npm test` runs `node --test backend/v2`, so a test
// outside this directory would never run. The script itself is bash; we spawn
// it the way the daemon does (content on stdin, config via env).
//
// The backend URL points at a closed port on purpose: curl then fails, which
// is irrelevant — what we assert is whether the filter LET THE ITEM THROUGH,
// and the only observable signal for that is the dedup file the script writes
// just before POSTing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../daemon/poe-price-post.sh')

/** Run the handler with `clipboard` on stdin; true if it reached the POST. */
function passesFilter (clipboard, prefixes) {
  const runtimeDir = mkdtempSync(path.join(tmpdir(), 'ppt-filter-'))
  try {
    const env = {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeDir,
      PPT_BACKEND_URL: 'http://127.0.0.1:1' // closed port -> curl fails, we don't care
    }
    if (prefixes !== undefined) env.PPT_ITEM_PREFIXES = prefixes.join('\n')
    else delete env.PPT_ITEM_PREFIXES
    spawnSync('bash', [SCRIPT], { input: clipboard, env, encoding: 'utf8' })
    return existsSync(path.join(runtimeDir, 'ppt-last-posted'))
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
}

const EN_ITEM = 'Item Class: Belts\nRarity: Unique\nThe Tides of Time'
const DE_ITEM = 'Gegenstandsklasse: Gürtel\nSeltenheit: Einzigartig\nDie Gezeiten der Zeit'

test('English item passes with the English prefix', () => {
  assert.equal(passesFilter(EN_ITEM, ['Item Class: ']), true)
})

test('German item is dropped when only the English prefix is configured', () => {
  // The bug this whole feature starts from: without config, every German item
  // dies here and no backend work can ever show.
  assert.equal(passesFilter(DE_ITEM, ['Item Class: ']), false)
})

test('German item passes with the German prefix', () => {
  assert.equal(passesFilter(DE_ITEM, ['Gegenstandsklasse: ']), true)
})

test('both languages pass when both prefixes are configured', () => {
  const both = ['Item Class: ', 'Gegenstandsklasse: ']
  assert.equal(passesFilter(EN_ITEM, both), true)
  assert.equal(passesFilter(DE_ITEM, both), true)
})

test('non-item clipboard content is still dropped silently', () => {
  // Every Ctrl+C in the game lands here, so a miss must stay quiet.
  assert.equal(passesFilter('some text copied from a browser', ['Item Class: ', 'Gegenstandsklasse: ']), false)
})

test('missing PPT_ITEM_PREFIXES falls back to the English prefix', () => {
  // Old configs and old installs must keep working untouched.
  assert.equal(passesFilter(EN_ITEM, undefined), true)
  assert.equal(passesFilter(DE_ITEM, undefined), false)
})
