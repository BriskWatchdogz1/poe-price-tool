// backend/v2/networth/stash-pacer.test.mjs
//
// The pace between two stash requests, derived from the limits GGG publishes
// rather than from a constant. What has to hold, and why each one is here:
//
//   1. The MEASURED rule set produces a spacing that honours BOTH windows — the
//      60s one and the 1800s one. The 1800s window is the one the old constant
//      never counted at all.
//   2. With no rules seen (the first request after a start) the constant is what
//      is used. The tool must not need a response before it dares to send one.
//   3. The derivation is NEVER faster than the constant. Any rule set, any
//      share: the constant is the floor. This is the assurance that makes the
//      change unable to increase the request volume in any constellation.
//   4. `Ip` is taken more strictly than `Account` for the same published
//      numbers, because the address is shared with traffic this tool cannot see.
//   5. THE TABLE IS NOT A ONE-WAY STREET. A rule set GGG has stopped publishing
//      stops counting — by policy (a response replaces the set of its own
//      budget) or, as a fallback, by expiry. The whole of this section is
//      written against the dangerous direction: the only thing that may make
//      the tool faster is GGG publishing looser rules, never a lapse of memory.
//   6. THE WINDOW IS BUCKETED, and by how much is in no header. The rate is
//      derived against `windowSec + bucketSec`, which can only lengthen a gap.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStashPacer, minSpacingMs, bucketSecFor } from './stash-pacer.mjs'
import { NUMERIC_SETTINGS_BY_NAME } from '../numeric-settings.mjs'

// The rule set measured on the production deployment, verbatim. Two endpoint
// groups; the pacer honours every rule of both at once, because which counter a
// given request lands in is not knowable from the response.
const MEASURED_GROUP_1 = [
  { rule: 'Account', hits: 30, windowSec: 60, banSec: 60 },
  { rule: 'Account', hits: 100, windowSec: 1800, banSec: 600 },
  { rule: 'Ip', hits: 45, windowSec: 60, banSec: 120 },
  { rule: 'Ip', hits: 180, windowSec: 1800, banSec: 600 }
]
const MEASURED_GROUP_2 = [
  { rule: 'Account', hits: 15, windowSec: 10, banSec: 60 },
  { rule: 'Account', hits: 30, windowSec: 300, banSec: 300 }
]
// The set that arrived on 13.08. at 02:15 UTC on the SAME account and the same
// address as MEASURED_GROUP_1 — stricter throughout, with a two-hour window
// nothing had published before. At 11:28 the same day, group 1 was back.
const MEASURED_STRICT = [
  { rule: 'Ip', hits: 30, windowSec: 60, banSec: 120 },
  { rule: 'Ip', hits: 90, windowSec: 1800, banSec: 600 },
  { rule: 'Ip', hits: 180, windowSec: 7200, banSec: 3600 }
]
const STRICT_MS = 80_666.66666666667 // Ip 180/7200s at 0.5, bucketed window 7260s
const LONGEST_WINDOW_MS = 7_200_000 // the longest window ever observed
const BASE_MS = 1500                 // the constant the pace used to be
const SHARES = { Ip: 0.5, Account: 0.75 }  // the documented defaults
const shareOf = name => (name === 'Account' ? SHARES.Account : SHARES.Ip)

/** A pacer on a clock the test moves by hand — no test waits for real time. */
function pacerAt (t0 = 1_000_000, opts = {}) {
  let t = t0
  const p = createStashPacer({ now: () => t, shareOf, ...opts })
  return { p, advance: ms => { t += ms }, at: () => t }
}

// ---------------------------------------------------------------------------
// 1. The measurement, and both of its windows
// ---------------------------------------------------------------------------

test('the measured rule set derives a spacing that fits inside BOTH windows', () => {
  const spacing = minSpacingMs([...MEASURED_GROUP_1, ...MEASURED_GROUP_2], { baseMs: BASE_MS, shareOf })
  // Account 100/1800s is the binding rule. Its window is summed in one-minute
  // buckets, so the rate has to hold for 1860s rather than 1800s: 18.6s a
  // request, of which this tool claims three quarters -> 24.8s. Ip 180/1800s
  // asks for 10.33s at half -> 20.7s.
  assert.equal(spacing, 24_800)

  // …and that is what it means, per window: a sequential stream at one request
  // every `spacing` cannot exceed these counts, whatever a folder tab does.
  // Measured against the PUBLISHED window, which is the pessimistic side of the
  // bucket uncertainty and therefore the one worth asserting.
  for (const r of [...MEASURED_GROUP_1, ...MEASURED_GROUP_2]) {
    const ours = (r.windowSec * 1000) / spacing        // most we can send in that window
    assert.ok(ours <= r.hits * shareOf(r.rule) + 1e-9,
      `${r.rule} ${r.hits}/${r.windowSec}s: ${ours.toFixed(1)} requests is past the share we allow ourselves`)
    assert.ok(ours < r.hits, `${r.rule} ${r.hits}/${r.windowSec}s would be exceeded outright`)
  }
})

test('the old constant did NOT fit inside them — the reason this module exists', () => {
  // 1500ms = 40 requests a minute against Ip 45/60s (89% of it), and 1200 in
  // half an hour against Ip 180/1800s. The second one is the window nothing in
  // the tool was counting.
  const perMinute = 60_000 / BASE_MS
  assert.equal(perMinute, 40)
  assert.ok(perMinute / 45 > 0.88, 'the short Ip window was run at ~89%')
  assert.ok((1_800_000 / BASE_MS) > 180 * 6, 'the long Ip window allowed a small fraction of that pace')

  // The one violation that needs no assumption about which counter a request
  // lands in: the map stash's 1+30 requests are sent to the endpoint whose own
  // rules are the group-2 set, and 31 of them inside 46s is past `30/300s`.
  const burstMs = 31 * BASE_MS
  const rule = MEASURED_GROUP_2.find(r => r.windowSec === 300)
  assert.ok(burstMs < rule.windowSec * 1000 && 31 > rule.hits,
    'one folder-tab walk overran a 300s window on its own')
})

test('a folder tab is what fills the long window, and the derived pace is what spreads it', () => {
  // The map stash was measured at 30 sub-tabs, i.e. 1+30 requests inside ONE
  // refresher step.
  const requests = 31
  assert.equal(requests * BASE_MS, 46_500)                 // ~46s: 40 a minute
  const spacing = minSpacingMs(MEASURED_GROUP_1, { baseMs: BASE_MS, shareOf })
  assert.equal(requests * spacing, 768_800)                // ~12.8 min, and inside every window
  assert.ok(requests <= (1_800_000 / spacing), 'one folder tab must fit in the 1800s window on its own')
})

// ---------------------------------------------------------------------------
// 2. No rules seen -> the constant
// ---------------------------------------------------------------------------

test('with no rules seen, the constant is the pace', () => {
  assert.equal(minSpacingMs([], { baseMs: BASE_MS, shareOf }), BASE_MS)
  const { p } = pacerAt()
  assert.equal(p.spacingMs(BASE_MS), BASE_MS)
  // …and the very first request of a process waits for nothing at all: there is
  // no earlier request to be spaced from.
  assert.equal(p.waitMs(BASE_MS), 0)
})

test('a response without rate-limit headers does not unlearn what is known', () => {
  const { p } = pacerAt()
  p.noteRules({ rules: MEASURED_GROUP_1 })
  assert.equal(p.spacingMs(BASE_MS), 24_800)
  p.noteRules({ rules: [] })
  assert.equal(p.spacingMs(BASE_MS), 24_800, 'forgetting the limits is the direction that sends more')
})

test('the two rule sets are honoured together, not one replacing the other', () => {
  const { p } = pacerAt()
  p.noteRules({ rules: MEASURED_GROUP_2 })
  assert.equal(p.spacingMs(BASE_MS), 16_000)                // Account 30/300s at 0.75, bucketed window 360s
  p.noteRules({ rules: MEASURED_GROUP_1 })
  assert.equal(p.spacingMs(BASE_MS), 24_800)
  // Back to a group-2 response — the 1800s rules of group 1 must NOT be dropped,
  // or walking a folder tab would silently undo the pace that limits the walk.
  p.noteRules({ rules: MEASURED_GROUP_2 })
  assert.equal(p.spacingMs(BASE_MS), 24_800)
})

// ---------------------------------------------------------------------------
// 3. Never faster than the constant
// ---------------------------------------------------------------------------

test('no rule set and no share can derive a spacing below the constant', () => {
  const generous = () => 1
  const absurd = () => 1000            // a share nothing would ever be set to
  for (const rules of [
    MEASURED_GROUP_1,
    MEASURED_GROUP_2,
    [{ rule: 'Ip', hits: 10_000, windowSec: 1, banSec: 60 }],   // an enormous allowance
    [{ rule: 'Account', hits: 0, windowSec: 60, banSec: 60 }],  // malformed: no hits
    [{ rule: 'Ip', hits: 5, windowSec: 0, banSec: 60 }],        // malformed: no window
    [{}], [null]
  ]) {
    for (const s of [shareOf, generous, absurd]) {
      assert.ok(minSpacingMs(rules, { baseMs: BASE_MS, shareOf: s }) >= BASE_MS,
        'the constant is the floor, under every rule set and every share')
    }
  }
})

test('a share the reader would never hand out still cannot speed the tool up', () => {
  // env-number.mjs refuses anything above 1, but the floor is what the
  // assurance rests on — not the range check two modules away.
  const { p } = pacerAt(0, { shareOf: () => 1000 })
  p.noteRules({ rules: MEASURED_GROUP_1 })
  assert.equal(p.spacingMs(BASE_MS), BASE_MS)
})

// ---------------------------------------------------------------------------
// 4. Ip is taken more strictly than Account
// ---------------------------------------------------------------------------

test('the same published numbers under `Ip` derive a longer spacing than under `Account`', () => {
  const numbers = { hits: 100, windowSec: 1800, banSec: 600 }
  const ip = minSpacingMs([{ rule: 'Ip', ...numbers }], { baseMs: BASE_MS, shareOf })
  const account = minSpacingMs([{ rule: 'Account', ...numbers }], { baseMs: BASE_MS, shareOf })
  assert.ok(ip > account, 'the address is shared with traffic this tool cannot see')
})

test('the shares are the ones in numeric-settings.mjs, and they are read live', () => {
  // Everything above injects its shares. This is the one test that uses the
  // production path — the pacer with no shareOf of its own — so that the two
  // settings are proven to be wired to something and not merely documented.
  const names = ['POE_STASH_IP_BUDGET_SHARE', 'POE_STASH_ACCOUNT_BUDGET_SHARE']
  const saved = names.map(n => [n, process.env[n]])
  try {
    for (const [n] of saved) delete process.env[n]
    const p = createStashPacer({ now: () => 0 })       // no shareOf -> the table
    p.noteRules({ rules: [{ rule: 'Ip', hits: 180, windowSec: 1800, banSec: 600 }] })
    assert.equal(p.spacingMs(BASE_MS), 20_666.666666666668, 'Ip 180/1800s at the default share of 0.5')
    p.reset()
    p.noteRules({ rules: [{ rule: 'Account', hits: 100, windowSec: 1800, banSec: 600 }] })
    assert.equal(p.spacingMs(BASE_MS), 24_800, 'Account 100/1800s at the default share of 0.75')
    // Tightening the dial lengthens the pace, and does so on the next request
    // rather than on the next restart.
    process.env.POE_STASH_ACCOUNT_BUDGET_SHARE = '0.5'
    assert.equal(p.spacingMs(BASE_MS), 37_200)
  } finally {
    for (const [n, v] of saved) { if (v == null) delete process.env[n]; else process.env[n] = v }
  }
})

test('a rule name this code has never seen is treated as an address budget', () => {
  const numbers = { hits: 100, windowSec: 1800, banSec: 600 }
  assert.equal(
    minSpacingMs([{ rule: 'Something-New', ...numbers }], { baseMs: BASE_MS, shareOf }),
    minSpacingMs([{ rule: 'Ip', ...numbers }], { baseMs: BASE_MS, shareOf })
  )
})

// ---------------------------------------------------------------------------
// The waiting itself: measured from the last request, across clients and ticks
// ---------------------------------------------------------------------------

test('the wait is what is LEFT of the spacing, so an ordinary tick pays nothing', () => {
  const { p, advance } = pacerAt()
  p.noteRules({ rules: MEASURED_GROUP_1 })
  p.noteRequest()
  assert.equal(p.waitMs(BASE_MS), 24_800, 'straight after a request: the whole spacing')
  advance(10_000)
  assert.equal(p.waitMs(BASE_MS), 14_800)
  advance(20_000)
  assert.equal(p.waitMs(BASE_MS), 0, '30s between two ticks already covers the derived spacing')
})

test('the reactive brake survives the client that was told about it', () => {
  // delayFor() answers a nearly-full window with "wait out the window". That
  // must not be discarded with the client at the end of the tick, or the next
  // tick opens by sending into it.
  const { p, advance } = pacerAt()
  p.noteBrake(60_000)
  advance(30_000)
  assert.equal(p.waitMs(BASE_MS), 30_000, 'half the brake is still owed a tick later')
  advance(30_000)
  assert.equal(p.waitMs(BASE_MS), 0)
})

test('reset forgets everything, and only tests use it', () => {
  const { p } = pacerAt()
  p.noteRules({ rules: MEASURED_GROUP_1 })
  p.noteRequest()
  p.noteBrake(60_000)
  p.reset()
  assert.deepEqual(p.knownRules(), [])
  assert.equal(p.spacingMs(BASE_MS), BASE_MS)
  assert.equal(p.waitMs(BASE_MS), 0)
})

test('a server varying its windows per response cannot grow the rule table without bound', () => {
  const { p } = pacerAt()
  for (let i = 1; i <= 500; i++) p.noteRules({ rules: [{ rule: 'Ip', hits: 100, windowSec: i, banSec: 60 }] })
  assert.ok(p.knownRules().length <= 20, 'the rule table is bounded like the rule-set log is')
})

test('…and neither can one varying its POLICY name per response', () => {
  const { p } = pacerAt()
  for (let i = 1; i <= 500; i++) p.noteRules({ policy: `p${i}`, rules: MEASURED_GROUP_1 })
  assert.ok(p.knownRules().length <= 20, 'the policy is part of the key, so it has to be part of the bound')
})

// ---------------------------------------------------------------------------
// 5. The table is not a one-way street
//
// THE DEFECT. Keyed on `rule:window` alone, nothing was ever removed. The
// production log has the cost of that in it: the strict set of 13.08. 02:15
// derives an 80s spacing, and the tool was still holding to 80s at 11:28 —
// hours after GGG had gone back to the set that asks for 24s — with no way back
// short of restarting the process. Every test below is written against the
// direction that makes that dangerous: the tool may only ever speed up because
// GGG published looser rules.
// ---------------------------------------------------------------------------

test('a policy that publishes a new set REPLACES its own — the 02:15/11:28 case', () => {
  const { p, advance } = pacerAt()
  p.noteRules({ policy: 'stash', rules: MEASURED_STRICT })
  assert.equal(p.spacingMs(BASE_MS), STRICT_MS, 'the strict set is honoured while GGG publishes it')
  advance(9 * 60 * 60 * 1000)                    // 02:15 -> 11:28, well inside the TTL
  p.noteRules({ policy: 'stash', rules: MEASURED_GROUP_1 })
  assert.equal(p.spacingMs(BASE_MS), 24_800,
    'GGG stopped publishing Ip 180/7200s, so it stops counting — this is the fix')
  assert.ok(!p.knownRules().some(r => r.windowSec === 7200), 'the withdrawn rule is gone, not merely outvoted')
})

test('replacing one policy leaves every other policy standing', () => {
  // The property the union was built for, and the one the fix must not cost:
  // a folder tab is walked entirely on the second endpoint, so if its responses
  // could drop the first endpoint's 1800s windows, the walk would be paced by
  // the very rules that do not measure it.
  const { p } = pacerAt()
  p.noteRules({ policy: 'stash', rules: MEASURED_GROUP_1 })
  p.noteRules({ policy: 'stash-folder', rules: MEASURED_GROUP_2 })
  assert.equal(p.spacingMs(BASE_MS), 24_800)
  // 31 responses from the folder endpoint, one per sub-tab of the map stash.
  for (let i = 0; i < 31; i++) p.noteRules({ policy: 'stash-folder', rules: MEASURED_GROUP_2 })
  assert.equal(p.spacingMs(BASE_MS), 24_800, 'the 1800s windows the walk fills are still counted')
  assert.ok(p.knownRules().some(r => r.windowSec === 1800))
})

test('a response with NO policy header never replaces anything', () => {
  // A missing header must not be able to make two endpoints look like one
  // budget. Without a policy the table stays the union it always was — the
  // conservative reading, and the pre-existing behaviour unchanged.
  const { p } = pacerAt()
  p.noteRules({ rules: MEASURED_STRICT })
  assert.equal(p.spacingMs(BASE_MS), STRICT_MS)
  p.noteRules({ rules: MEASURED_GROUP_1 })
  assert.equal(p.spacingMs(BASE_MS), STRICT_MS,
    'nothing says these are the same budget, so both are honoured and the stricter binds')
})

test('a policy answering with no rules at all does not wipe what it published before', () => {
  const { p } = pacerAt()
  p.noteRules({ policy: 'stash', rules: MEASURED_STRICT })
  p.noteRules({ policy: 'stash', rules: [] })
  p.noteRules({ policy: 'stash', rules: [{ rule: 'Ip', hits: 0, windowSec: 0 }] })
  assert.equal(p.spacingMs(BASE_MS), STRICT_MS,
    'a header that is missing is not GGG saying the budget is gone')
})

test('a rule set that KEEPS arriving never expires, however long the tool runs', () => {
  // The one thing expiry must never do. A week of ticks, re-publishing the
  // strict set each time: the pace must not move by a millisecond.
  const { p, advance } = pacerAt(0, { ruleTtlMs: () => 6 * 60 * 60 * 1000 })
  p.noteRules({ policy: 'stash', rules: MEASURED_STRICT })
  for (let i = 0; i < 7 * 24 * 60; i++) {         // one response a minute for a week
    advance(60_000)
    p.noteRules({ policy: 'stash', rules: MEASURED_STRICT })
    assert.equal(p.spacingMs(BASE_MS), STRICT_MS)
  }
  assert.equal(p.knownRules().length, MEASURED_STRICT.length)
})

test('a policy nobody asks again expires — after the TTL, and not one tick before', () => {
  const ttl = 6 * 60 * 60 * 1000
  const { p, advance } = pacerAt(0, { ruleTtlMs: () => ttl })
  p.noteRules({ policy: 'stash', rules: MEASURED_STRICT })
  advance(ttl)
  assert.equal(p.spacingMs(BASE_MS), STRICT_MS, 'at the TTL exactly it is still counted')
  advance(1)
  assert.equal(p.spacingMs(BASE_MS), BASE_MS, 'past it, and with nothing else known, the floor is what is left')
  assert.deepEqual(p.knownRules(), [])
})

test('expiry can never come before a rule\'s OWN window, whatever the dial says', () => {
  // The arithmetic floor under the setting: a request of ours can still be
  // inside a window of length W for W after it went out, and a rule is only
  // published in the answer to a request. So a set younger than its own longest
  // window may still be counting us, and no configured TTL may drop it.
  const { p, advance } = pacerAt(0, { ruleTtlMs: () => 1 })
  p.noteRules({ policy: 'stash', rules: MEASURED_STRICT })
  advance(LONGEST_WINDOW_MS)
  assert.equal(p.spacingMs(BASE_MS), STRICT_MS, 'the 7200s rule is kept for its own 7200s')
  advance(1)
  assert.deepEqual(p.knownRules(), [], 'and no longer than it has to be')
})

test('the rules of one policy expire without taking another policy with them', () => {
  const ttl = 6 * 60 * 60 * 1000
  const { p, advance } = pacerAt(0, { ruleTtlMs: () => ttl })
  p.noteRules({ policy: 'stash', rules: MEASURED_STRICT })
  for (let i = 0; i <= 12; i++) {                 // the other policy keeps answering
    advance(ttl / 12)
    p.noteRules({ policy: 'stash-folder', rules: MEASURED_GROUP_2 })
  }
  assert.equal(p.spacingMs(BASE_MS), 16_000, 'only the abandoned policy was forgotten')
  assert.ok(p.knownRules().every(r => r.policy === 'stash-folder'))
})

test('expiry cannot derive anything below the constant either', () => {
  const { p, advance } = pacerAt(0, { ruleTtlMs: () => 1000 })
  p.noteRules({ policy: 'stash', rules: MEASURED_GROUP_1 })
  advance(1_800_001)
  assert.equal(p.spacingMs(BASE_MS), BASE_MS)
  assert.equal(p.waitMs(BASE_MS), 0, 'nothing sent yet — but the floor is what the next request pays')
  p.noteRequest()
  assert.equal(p.waitMs(BASE_MS), BASE_MS, 'the old constant, never less')
})

test('the TTL is the one in numeric-settings.mjs, and it is read live', () => {
  // The production path, like the shares test above: the setting is proven to
  // be wired to something rather than merely documented.
  const name = 'POE_STASH_RULE_TTL_MS'
  const saved = process.env[name]
  try {
    delete process.env[name]
    const spec = NUMERIC_SETTINGS_BY_NAME.get(name)
    assert.equal(spec.fallback, 6 * 60 * 60 * 1000, 'six hours: three times the longest window observed')
    assert.equal(spec.min, LONGEST_WINDOW_MS, 'the floor is Ip 180/7200s, the longest window GGG has published here')
    assert.equal(spec.zero, false, 'zero would forget every rule on the spot')
    assert.equal(spec.max, undefined, 'the dangerous direction is DOWN, so there is no ceiling')

    let t = 0
    const p = createStashPacer({ now: () => t, shareOf })   // no ruleTtlMs -> the table
    p.noteRules({ policy: 'stash', rules: [{ rule: 'Ip', hits: 180, windowSec: 1800, banSec: 600 }] })
    t += spec.fallback
    assert.equal(p.spacingMs(BASE_MS), 20_666.666666666668, 'still counted at six hours')
    t += 1
    assert.equal(p.spacingMs(BASE_MS), BASE_MS, 'and dropped past it')

    // Lengthening the dial keeps a set alive longer, on the next request rather
    // than on the next restart.
    process.env[name] = String(12 * 60 * 60 * 1000)
    const q = createStashPacer({ now: () => t, shareOf })
    q.noteRules({ policy: 'stash', rules: [{ rule: 'Ip', hits: 180, windowSec: 1800, banSec: 600 }] })
    t += 7 * 60 * 60 * 1000
    assert.equal(q.spacingMs(BASE_MS), 20_666.666666666668)
  } finally {
    if (saved == null) delete process.env[name]; else process.env[name] = saved
  }
})

test('a refused TTL falls back UP to the default, never down', () => {
  // env-number.mjs's rule, checked here because for THIS setting the fallback
  // direction is the safety property: a typo must not shorten the memory.
  const name = 'POE_STASH_RULE_TTL_MS'
  const saved = process.env[name]
  const spec = NUMERIC_SETTINGS_BY_NAME.get(name)
  try {
    for (const bad of ['0', '-1', 'none', '60000', String(LONGEST_WINDOW_MS - 1)]) {
      process.env[name] = bad
      let t = 0
      const p = createStashPacer({ now: () => t, shareOf })
      p.noteRules({ policy: 'stash', rules: [{ rule: 'Ip', hits: 180, windowSec: 1800, banSec: 600 }] })
      t += spec.fallback
      assert.equal(p.spacingMs(BASE_MS), 20_666.666666666668, `${name}=${bad} must not shorten how long a rule counts`)
    }
  } finally {
    if (saved == null) delete process.env[name]; else process.env[name] = saved
  }
})

// ---------------------------------------------------------------------------
// 6. The resolution of a window — the number that is in no header
//
// GGG buckets incoming requests rather than counting them at the instant they
// arrive, and says so nowhere: "That particular policy has a resolution of 5
// seconds, which means that it buckets incoming requests in 5 second intervals.
// To be safe you'd have to add 5 more seconds rather than 2. This isn't exposed
// anywhere for you to have known." (GGG support, to gerwaric/acquisition.)
//
// So a rate is derived against `windowSec + bucketSec`. Every test here is about
// the direction: the surcharge may only ever LENGTHEN a gap.
// ---------------------------------------------------------------------------

test('the bucket is added to the WINDOW, and the surcharge is what that arithmetic gives', () => {
  const one = r => minSpacingMs([r], { baseMs: BASE_MS, shareOf })
  // Short limit, 5s bucket: 45 hits per 60s becomes 45 per 65s.
  assert.equal(one({ rule: 'Ip', hits: 45, windowSec: 60 }), (65_000) / (45 * 0.5))
  // Sustained limit, 60s bucket: 100 per 1800s becomes 100 per 1860s.
  assert.equal(one({ rule: 'Account', hits: 100, windowSec: 1800 }), (1_860_000) / (100 * 0.75))
})

test('which bucket applies is derived from the long one, not declared separately', () => {
  // A window no longer than the sustained limit's own bucket cannot be a
  // sustained limit. Every window in every set observed so far falls on the
  // side it should.
  assert.equal(bucketSecFor(10), 5)
  assert.equal(bucketSecFor(60), 5)
  assert.equal(bucketSecFor(61), 60)
  assert.equal(bucketSecFor(300), 60)
  assert.equal(bucketSecFor(1800), 60)
  assert.equal(bucketSecFor(7200), 60)
})

test('the surcharge only ever lengthens the pace, on every rule set measured', () => {
  const unbucketed = { bucketSecOf: () => 0 }
  for (const rules of [MEASURED_GROUP_1, MEASURED_GROUP_2, MEASURED_STRICT,
    [...MEASURED_GROUP_1, ...MEASURED_GROUP_2]]) {
    const plain = minSpacingMs(rules, { baseMs: BASE_MS, shareOf, ...unbucketed })
    const bucketed = minSpacingMs(rules, { baseMs: BASE_MS, shareOf })
    assert.ok(bucketed > plain, 'a resolution nobody publishes cannot be a reason to send faster')
  }
  // …and it is a surcharge, not a new regime: 3.3% on the measured set.
  const before = minSpacingMs(MEASURED_GROUP_1, { baseMs: BASE_MS, shareOf, ...unbucketed })
  const after = minSpacingMs(MEASURED_GROUP_1, { baseMs: BASE_MS, shareOf })
  assert.ok(after / before < 1.05, `the surcharge is ${(after / before).toFixed(3)}x, not a slowdown of its own`)
})

test('the constant is still the floor under the bucketed derivation', () => {
  const generous = [{ rule: 'Ip', hits: 10_000, windowSec: 1 }]
  assert.equal(minSpacingMs(generous, { baseMs: BASE_MS, shareOf }), BASE_MS)
})

test('the bucket sizes are the ones in numeric-settings.mjs, and they may only grow', () => {
  const rows = [
    ['POE_STASH_BUCKET_SHORT_SEC', 5],
    ['POE_STASH_BUCKET_LONG_SEC', 60]
  ]
  for (const [name, expected] of rows) {
    const spec = NUMERIC_SETTINGS_BY_NAME.get(name)
    assert.equal(spec.fallback, expected, `${name} changed its default`)
    assert.equal(spec.min, expected, 'the floor IS the documented default: this dial may only lengthen a wait')
    assert.equal(spec.zero, false, 'zero is "the limiter has no resolution", which GGG explicitly corrected')
    assert.equal(spec.max, undefined)
  }
  const saved = process.env.POE_STASH_BUCKET_LONG_SEC
  try {
    process.env.POE_STASH_BUCKET_LONG_SEC = '120'
    assert.equal(bucketSecFor(1800), 120, 'read live, like every other dial in this derivation')
    assert.equal(bucketSecFor(90), 5, 'and the split moves with it')
  } finally {
    if (saved == null) delete process.env.POE_STASH_BUCKET_LONG_SEC
    else process.env.POE_STASH_BUCKET_LONG_SEC = saved
  }
})
