// daemon/ppt_results.py — what the player sees after a price check: one state
// per item this daemon posted, turned into card lines and a notification text.
//
// Why this lives here: `npm test` covers only backend/v2 (same reason as
// daemon-diag.test.mjs). ppt_results.py is standard library only and has no
// clock of its own: every time below is a number handed in.
//
// The rule under test: there is ALWAYS an answer. An item without a result ends
// as "no result within …", a lost result as "missed", a missing back channel
// and a local failure are cards too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DAEMON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../daemon')

const PRELUDE = `
import json, sys
sys.path.insert(0, sys.argv[1])
from ppt_results import *
def texts(card):
    return None if card is None else [l[0] for l in card['lines']]
def item(id, status='queued', by='me', **kw):
    ev = {'kind': 'item', 'by': by, 'id': id, 'name': kw.pop('name', 'Mageblood'), 'base': 'Heavy Belt',
          'rarity': 'unique', 'stack': None, 'status': status, 'ahead': None, 'retryAfterSec': None,
          'price': None, 'ref': None, 'cd': None, 'final': status in ('done', 'error')}
    ev.update(kw)
    return ev
def trade(median, low=None, high=None, count=10, currency='chaos', conflict=False):
    return {'source': 'trade', 'currency': currency, 'median': median, 'low': low, 'high': high,
            'count': count, 'ageHours': None, 'conflict': conflict, 'early': False}
`

function py (code) {
  const r = spawnSync('python3', ['-c', PRELUDE + code, DAEMON_DIR], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  assert.equal(r.status, 0, `python3 failed: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

test('a posted item is answered at once and replaced by its price', () => {
  const out = py(`
b = ResultBook('me')
c1 = b.event(item('a', ahead=2), 0)
c2 = b.event(item('a', 'done', price=trade(140, 125, 170, 259, 'divine')), 5)
print(json.dumps({'c1': c1, 'c2': c2, 't1': texts(c1), 't2': texts(c2), 'toast': toast_for(c2)}))
`)
  assert.deepEqual(out.t1, ['Mageblood', 'queued · about 2 ahead'])
  assert.equal(out.c1.title, 'Mageblood')
  assert.equal(out.c1.key, 'item:a')
  assert.equal(out.c1.final, false)
  assert.deepEqual(out.t2, ['Mageblood', '140 div (125–170)', '259 listings'])
  assert.equal(out.c2.final, true)
  assert.equal(out.c2.key, out.c1.key, 'the same card, replaced')
  assert.deepEqual(out.toast, ['Mageblood', '140 div (125–170)\n259 listings'])
})

test('results of another instance are not shown', () => {
  const out = py(`
b = ResultBook('me')
print(json.dumps([b.event(item('a', by='other'), 0), b.event({'kind': 'whisper', 'by': 'me'}, 0), b.event('junk', 0)]))
`)
  assert.deepEqual(out, [null, null, null])
})

test('an item without a result is closed with words, not left at queued', () => {
  const out = py(`
r = {}
b = ResultBook('me')
b.event(item('a'), 0)
r['t119'] = [texts(c) for c in b.tick(119)]
r['t121'] = [texts(c) for c in b.tick(121)]
r['t200'] = [texts(c) for c in b.tick(200)]
b2 = ResultBook('me')
r['posted'] = b2.posted(0, 'ok')
r['p11'] = [texts(c) for c in b2.tick(11)]
b3 = ResultBook('me')
b3.event(item('x'), 0)
b3.posted(0.2, 'ok')
r['before'] = [texts(c) for c in b3.tick(11)]
b4 = ResultBook('me')
b4.posted(0, 'ok'); b4.posted(0.5, 'ok')
b4.event(item('y'), 0.6)
r['two'] = [texts(c) for c in b4.tick(11)]
b5 = ResultBook('me')
b5.event(item('z', 'done', price=trade(30, 22, 45, 14)), 0)
b5.posted(1, 'ok')
r['priced'] = [texts(c) for c in b5.tick(12)]
b6 = ResultBook('me', wait_s=90)
b6.event(item('w'), 0)
r['t90'] = [texts(c) for c in b6.tick(91)]
print(json.dumps(r))
`)
  assert.deepEqual(out.t119, [])
  assert.deepEqual(out.t121, [['Mageblood', 'no result within 2 min — see the browser']])
  assert.deepEqual(out.t200, [], 'closed once')
  assert.equal(out.posted, null, 'with the back channel up the card comes from the feed')
  assert.deepEqual(out.p11, [['Price check', 'sent — no live answer, the price is in the browser']])
  assert.deepEqual(out.before, [], 'the feed event may come before the POST has ended')
  assert.equal(out.two.length, 1, 'two POSTs and one new id: one "no live answer"')
  assert.deepEqual(out.priced, [], 'a card with a price is never replaced by it')
  assert.deepEqual(out.t90, [['Mageblood', 'no result within 90 s — see the browser']])
})

test('a re-post folded into a known card answers its POST: no "no live answer" over it', () => {
  // The double read of one unique: two POSTs, the second folded by the server
  // into the first card; the feed marks that replay with reassert.
  const out = py(`
r = {}
b = ResultBook('me')
b.posted(20, 'ok', name='Headhunter')
b.event(item('h', 'error', name='Headhunter'), 20.1)
b.posted(20.4, 'ok', name='Headhunter')
b.event(item('h', 'error', name='Headhunter', reassert=True), 20.5)
r['after'] = [texts(c) for c in b.tick(31)]
r['open'] = len(b.open_posts)
# the replay may come before poe-price-post.sh has ended, too
b2 = ResultBook('me')
b2.posted(0, 'ok'); b2.event(item('h', 'rate-limited', retryAfterSec=1200), 0.1)
b2.event(item('h', 'rate-limited', retryAfterSec=1200, reassert=True), 0.3)
b2.posted(0.4, 'ok')
r['early'] = [texts(c) for c in b2.tick(11)]
# an ordinary update of a known card redeems nothing
b3 = ResultBook('me')
b3.event(item('h'), 0); b3.posted(0.1, 'ok')
b3.event(item('h', 'searching'), 1)
b3.posted(2, 'ok', name='Doom Grip')
r['update'] = [texts(c) for c in b3.tick(13)]
print(json.dumps(r))
`)
  assert.deepEqual(out.after, [])
  assert.equal(out.open, 0)
  assert.deepEqual(out.early, [])
  assert.deepEqual(out.update, [['Doom Grip', 'sent — no live answer, the price is in the browser']])
})

test('a price holds off "no live answer" only for the item it belongs to', () => {
  const out = py(`
r = {}
b = ResultBook('me')
b.posted(0, 'ok'); b.event(item('a', 'done', price=trade(100, count=10)), 0.1)
b.posted(5, 'ok', name='Headhunter')
r['other'] = [texts(c) for c in b.tick(16)]
b.posted(20, 'ok', name='Mageblood')
b.event(item('a', 'done', price=trade(100, count=10)), 20.2)  # an update of the priced card, not a redeem
r['same'] = [texts(c) for c in b.tick(31)]
b2 = ResultBook('me')
b2.posted(0, 'ok'); b2.event(item('a', 'done', price=trade(100, count=10)), 0.1)
b2.posted(5, 'ok', name='Mageblood')
r['gap'] = [texts(c) for c in b2.gap(6, 'server restarted')]
r['later'] = [texts(c) for c in b2.tick(16)]
print(json.dumps(r))
`)
  assert.deepEqual(out.other, [['Headhunter', 'sent — no live answer, the price is in the browser']],
    'the last card had a price, but of another item: an answer all the same')
  assert.deepEqual(out.same, [], 'the card of this very item shows its price')
  assert.deepEqual(out.gap, [['Mageblood', 'result missed (server restarted) — see the browser']],
    'a restart ends an open POST at once')
  assert.deepEqual(out.later, [])
})

test('a server restart or a gap closes open items as missed', () => {
  const out = py(`
b = ResultBook('me')
b.event(item('a'), 0)
b.event(item('b', name='Headhunter'), 1)
b.event(item('c', 'done', price=trade(5)), 2)
cards = b.gap(3, 'server restarted')
b2 = ResultBook('me')
b2.event(item('a'), 0)
g = b2.gap(1, 'gap')
print(json.dumps({'cards': [texts(c) for c in cards], 'later': [texts(c) for c in b.tick(500)], 'gap': [texts(c) for c in g]}))
`)
  assert.deepEqual(out.cards, [
    ['Mageblood', 'result missed (server restarted) — see the browser'],
    ['Headhunter', 'result missed (server restarted) — see the browser']
  ])
  assert.deepEqual(out.later, [], 'a missed item does not time out as well')
  assert.match(out.gap[0][1], /^result missed \(.+\) — see the browser$/)
})

test('an older server, a local failure and a duplicate still give a visible card', () => {
  const out = py(`
b = ResultBook('me')
r = {}
r['old'] = texts(b.posted(0, 'unsupported', name='Mageblood'))
r['old_title'] = b.posted(0, 'unsupported')['title']
r['off'] = texts(b.posted(0, 'off'))
r['failing'] = texts(b.posted(0, 'failing'))
r['starting'] = texts(b.posted(0, 'starting'))
r['local'] = {k: texts(b.local_failure(k, 'Mageblood')) for k in ('unreadable', 'no-parser', 'unknown-user', 'unreachable', 'failed')}
b2 = ResultBook('me')
r['none'] = texts(b2.same_item('Mageblood'))
r['noname'] = texts(b2.same_item())
done = b2.event(item('a', 'done', price=trade(30, 22, 45, 14)), 0)
b2.event(item('b', 'searching', name='Headhunter'), 1)  # a later card of another item
r['again'] = b2.same_item('Mageblood') == done
r['other'] = texts(b2.same_item('Headhunter'))
b2.posted(2, 'unsupported', name='Tabula Rasa')
r['note'] = texts(b2.same_item('Tabula Rasa'))
print(json.dumps(r))
`)
  assert.deepEqual(out.old, ['Mageblood', 'sent — the price shows in the browser only (the server is older than this daemon)'])
  assert.equal(out.old_title, 'Price check')
  for (const k of ['off', 'failing', 'starting']) assert.match(out[k][1], /^sent — the price shows in the browser only \(.+\)$/)
  assert.deepEqual(out.local.unreadable, ['Mageblood', 'item not readable — listed in the admin view'])
  for (const k of ['no-parser', 'unknown-user', 'unreachable', 'failed']) {
    assert.equal(out.local[k].length, 2, k)
    assert.notEqual(out.local[k][1], out.local.unreadable[1], k)
  }
  assert.deepEqual(out.none, ['Mageblood', 'same item as before — its price is in the browser'],
    'a daemon restarted since the marker was written: still an answer')
  assert.deepEqual(out.noname, ['Price check', 'same item as before — its price is in the browser'])
  assert.equal(out.again, true, "that item's card again, not the last card handed out")
  assert.deepEqual(out.other, ['Headhunter', 'searching…'])
  assert.match(out.note[1], /^sent — the price shows in the browser only/)
})

test('rate limit, error, exchange with stack, ref and money are worded', () => {
  const out = py(`
r = {}
b = ResultBook('me')
r['rl'] = texts(b.event(item('a', 'rate-limited', retryAfterSec=10800), 0))
r['rl20'] = texts(b.event(item('a2', 'rate-limited', retryAfterSec=1200), 0))
r['err'] = texts(b.event(item('b', 'error'), 0))
r['search'] = texts(b.event(item('s', 'searching'), 0))
ex = {'source': 'exchange', 'currency': 'chaos', 'median': 212, 'low': 205, 'high': 220, 'count': None,
      'ageHours': 6, 'conflict': False, 'early': True}
r['ex'] = texts(b.event(item('c', 'queued', name='Exalted Orb', stack=7, price=ex, ahead=0), 0))
r['ninja'] = texts(b.event(item('n', 'done', name='Tabula Rasa', price={'source': 'ninja', 'currency': 'chaos', 'median': 9}), 0))
r['ref_before'] = texts(b.event(item('d', 'searching', ref={'chaos': 85, 'divine': 0.5}), 0))
r['ref_after'] = texts(b.event(item('d', 'done', ref={'chaos': 85, 'divine': 0.5}, price=trade(90, 80, 100, 12, conflict=True)), 1))
r['none'] = texts(b.event(item('e', 'done', price=trade(None, count=0)), 0))
r['money'] = [money(212, 150), money(0.018, None), money(1484, None), money(1484, None, 'de'), money(212, 150, 'de'),
              money(212, None), money(3.5, None), money(140, None, 'en', 'divine'), money(None, None)]
long = 'X' * 80
r['long'] = texts(b.event(item('f', name=long), 0))[0]
b.lang = 'de'
r['de'] = texts(b.event(item('g', 'done', name='Chaos', stack=7, price=dict(ex, early=False, median=1484 / 7)), 0))
r['junk'] = texts(b.event({'kind': 'item', 'by': 'me', 'id': 'h', 'price': {'source': 'trade', 'median': 'x'}, 'stack': 'y', 'ahead': 'z', 'status': 7}, 0))
print(json.dumps(r))
`)
  assert.deepEqual(out.rl, ['Mageblood', 'trade search paused ~3 h (GGG limit)'])
  assert.deepEqual(out.rl20, ['Mageblood', 'trade search paused ~20 min (GGG limit)'])
  assert.deepEqual(out.err, ['Mageblood', 'search failed — see the browser'])
  assert.deepEqual(out.search, ['Mageblood', 'searching…'])
  assert.deepEqual(out.ex, ['Exalted Orb ×7', '212 c each · 1,484 c', 'Currency Exchange · rate 6 h old', 'queued · next'])
  assert.deepEqual(out.ninja, ['Tabula Rasa', '9 c', 'poe.ninja'])
  assert.deepEqual(out.ref_before, ['Mageblood', 'poe.ninja 85 c', 'searching…'])
  assert.deepEqual(out.ref_after, ['Mageblood', '90 c (80–100)', '12 listings · asks disagree', 'poe.ninja 85 c'])
  assert.deepEqual(out.none, ['Mageblood', 'no listings — no price'])
  assert.deepEqual(out.money, ['1.4 div', '0.018 c', '1,484 c', '1.484 c', '1,4 div', '212 c', '3.5 c', '140 div', '?'])
  assert.equal(out.long.length, 48)
  assert.ok(out.long.endsWith('…'))
  assert.deepEqual(out.de.slice(1, 2), ['212 c each · 1.484 c'])
  assert.ok(Array.isArray(out.junk) && out.junk.length >= 1, 'missing or odd fields never raise')
})
