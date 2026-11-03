// The second sentence under "No items in the queue" on the Price Check page:
// when the last item from this player's hotkey daemon arrived (shell.js,
// `daemonHintText`, fed by the `daemon-status` message).
//
// Same approach as release-status-line.test.mjs: i18n.js and shell.js are
// evaluated in a vm, and the function is called with the message and a clock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = p => fileURLToPath(new URL(p, import.meta.url))

async function loadShell () {
  const ctx = vm.createContext({
    window: {},
    localStorage: undefined,
    document: {
      getElementById: () => null,
      createElement: () => ({ dataset: {}, appendChild () {} }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      readyState: 'complete',
      documentElement: null,
      title: '',
      cookie: ''
    },
    fetch: async () => { throw new Error('no network in this test') },
    setInterval: () => 0,
    clearTimeout: () => {},
    setTimeout: () => 0
  })
  vm.runInContext(await readFile(here('i18n.js'), 'utf8'), ctx, { filename: 'i18n.js' })
  vm.runInContext(await readFile(here('shell.js'), 'utf8'), ctx, { filename: 'shell.js' })
  return { Shell: ctx.window.Shell, I18n: ctx.window.I18n }
}

const MIN = 60 * 1000
const HOUR = 60 * MIN

/** The hint for an item that arrived `ageMs` ago, on clocks that agree. */
const hintFor = (Shell, ageMs, outcome = 'card') =>
  Shell.daemonHintText({ lastItemAt: 1e9 - ageMs, outcome, now: 1e9, receivedAt: 1e9 }, 1e9)

test('no item since the server started is said in words', async () => {
  const { Shell } = await loadShell()
  const text = Shell.daemonHintText({ lastItemAt: null, outcome: null, now: 1000, receivedAt: 1000 }, 1000)
  assert.match(text, /No item has arrived from your hotkey daemon/)
  assert.match(text, /selftest\.sh/)
})

test('the age is counted on the server clock, not the browser clock', async () => {
  const { Shell } = await loadShell()
  // The browser clock is hours behind the server's; five minutes have passed
  // since the message arrived, and the item was two minutes old by then.
  const text = Shell.daemonHintText({ lastItemAt: 10_000_000 - 2 * MIN, outcome: 'card', now: 10_000_000, receivedAt: 500 }, 500 + 5 * MIN)
  assert.match(text, /7 minutes ago/)
})

test('under a minute, one minute, hours and days pick the right words', async () => {
  const { Shell } = await loadShell()
  assert.match(hintFor(Shell, 30 * 1000), /less than a minute ago/)
  const one = hintFor(Shell, 61 * 1000)
  assert.match(one, /: 1 minute ago/)
  assert.doesNotMatch(one, /minutes/)
  assert.match(hintFor(Shell, 3 * HOUR), /3 hours ago/)
  assert.match(hintFor(Shell, 72 * HOUR), /3 days ago/)
})

test('a refused item is not reported as a card', async () => {
  const { Shell } = await loadShell()
  assert.match(hintFor(Shell, 2 * MIN, 'parse-failed'), /could not be read/)
  assert.match(hintFor(Shell, 2 * MIN, 'no-parser'), /no data set/)
  assert.match(hintFor(Shell, 2 * MIN, 'xyz'), /Last item from your hotkey daemon/, 'an outcome from a newer server reads like a card')
})

test('German puts the age in the dative after vor', async () => {
  const { Shell, I18n } = await loadShell()
  I18n.setLang('de')
  assert.match(hintFor(Shell, 48 * HOUR), /vor 2 Tagen/)
  assert.match(hintFor(Shell, 61 * 1000), /vor einer Minute/)
})

test('an older or foreign message says nothing and does not throw', async () => {
  const { Shell } = await loadShell()
  assert.equal(Shell.daemonHintText(null, 0), '')
  assert.equal(Shell.daemonHintText({ type: 'daemon-status' }, 0), '')
})

// ---- the daemon block of `daemon-status` (POST /daemon/heartbeat) -----------
// What does not work on the player's machine, said in the browser too
// (daemonFeatureText, Price Check status line), and which version the daemon
// runs next to the latest release (daemonVersionText, settings page).

test('a feature that does not work is named, the working ones are not', async () => {
  const { Shell } = await loadShell()
  assert.equal(Shell.daemonFeatureText(null), '', 'no heartbeat yet: nothing to say')
  assert.equal(Shell.daemonFeatureText(undefined), '')
  assert.equal(Shell.daemonFeatureText({ version: '1.0.0', features: { downlink: 'ok', notify: 'off', overlay: 'starting', x: 'unknown' } }), '')
  const text = Shell.daemonFeatureText({ version: '1.0.0', features: { downlink: 'failing', notify: 'missing', overlay: 'no-qt' } })
  assert.match(text, /^Your hotkey daemon \(1\.0\.0\): /)
  assert.match(text, /overlay — no PySide6/)
  assert.match(text, /notification — notify-send missing/)
  assert.match(text, /back channel — failing/)
  assert.match(Shell.daemonFeatureText({ version: '1.0.0', features: { overlay: 'no-focus-check' } }), /overlay — /)
  assert.match(Shell.daemonFeatureText({ version: '1.0.0', features: { overlay: 'wrong-platform' } }), /overlay — /)
  assert.match(Shell.daemonFeatureText({ version: '1.0.0', features: { overlay: 'some-new-state' } }), /overlay — some-new-state/,
    'a state this page has no words for appears as it came')
  assert.match(Shell.daemonFeatureText({ version: '1.0.0', features: { whispers: 'failing' } }), /whispers — failing/,
    'so does a feature it does not know')
  assert.match(Shell.daemonFeatureText({ features: { overlay: 'no-qt' } }), /\(unknown\)/)
  assert.match(Shell.daemonFeatureText({ version: '1.0.0', instances: 1, features: { overlay: 'no-qt' } }), /no PySide6/)
  assert.equal(Shell.daemonFeatureText({ version: '1.0.0', presence: 'unknown', instances: 0, features: { overlay: 'no-qt' } }), '',
    'a daemon that went quiet: its last features are not a current fault')
})

test('the game detection is named when it cannot tell, and is quiet when it works or is off', async () => {
  const { Shell, I18n } = await loadShell()
  assert.equal(Shell.daemonFeatureText({ version: '1.0.0', features: { game: 'ok' } }), '')
  assert.equal(Shell.daemonFeatureText({ version: '1.0.0', features: { game: 'off' } }), '')
  assert.match(Shell.daemonFeatureText({ version: '1.0.0', features: { game: 'never-seen' } }),
    /game detection — the game window has not been seen yet/)
  assert.match(Shell.daemonFeatureText({ version: '1.0.0', features: { game: 'no-xdotool' } }), /game detection — xdotool missing/)
  for (const state of ['no-xdotool', 'no-display', 'timeout', 'error', 'never-seen']) {
    assert.ok(I18n.STRINGS.de[`pc.daemonFeature.game.${state}`], `de has game.${state}`)
  }
})

test('whispers the server could not read are counted in the same line', async () => {
  const { Shell, I18n } = await loadShell()
  assert.equal(Shell.daemonFeatureText(null, 0), '')
  assert.equal(Shell.daemonFeatureText(null, 1), 'Your hotkey daemon (unknown): 1 whisper not recognised',
    'a count since the server started, also before a heartbeat')
  const both = Shell.daemonFeatureText({ version: '1.0.0', features: { whispers: 'missing' } }, 3)
  assert.match(both, /whispers — log file not found/)
  assert.match(both, /3 whispers not recognised/)
  I18n.setLang('de')
  assert.match(Shell.daemonFeatureText({ version: '1.0.0', features: { whispers: 'unsupported' } }, 2),
    /Whisper — von diesem Server nicht angeboten; 2 Whisper nicht erkannt/)
})

test('the feature line is German on a German page', async () => {
  const { Shell, I18n } = await loadShell()
  I18n.setLang('de')
  const text = Shell.daemonFeatureText({ version: '1.0.0', features: { overlay: 'no-qt', notify: 'missing' } })
  assert.match(text, /^Dein Hotkey-Daemon \(1\.0\.0\): /)
  assert.match(text, /Overlay — kein PySide6/)
})

test('the daemon version is shown next to the latest release, and a daemon behind it says how to update', async () => {
  const { Shell, I18n } = await loadShell()
  assert.match(Shell.daemonVersionText(null, null), /has not reported a version/)
  const rel = { latest: { version: '0.4.0', tag: 'v0.4.0' } }
  assert.equal(Shell.daemonVersionText({ version: '0.4.0' }, rel), 'Your hotkey daemon: 0.4.0')
  assert.equal(Shell.daemonVersionText({ version: '0.5.0' }, rel), 'Your hotkey daemon: 0.5.0', 'newer than the release is not behind')
  const behind = Shell.daemonVersionText({ version: '0.3.9' }, rel)
  assert.match(behind, /^Your hotkey daemon: 0\.3\.9/)
  assert.match(behind, /the latest release is 0\.4\.0/)
  assert.match(behind, /git pull/)
  assert.equal(Shell.daemonVersionText({ version: 'unknown' }, rel), 'Your hotkey daemon: unknown', 'no version, no comparison')
  assert.equal(Shell.daemonVersionText({ version: '0.3.0-dev' }, rel), 'Your hotkey daemon: 0.3.0-dev', 'the same strict rule as the release check')
  assert.equal(Shell.daemonVersionText({ version: '0.3.0' }, null), 'Your hotkey daemon: 0.3.0', 'no release known yet')
  const quiet = Shell.daemonVersionText({ version: '0.3.9', instances: 0 }, rel)
  assert.match(quiet, /the latest release is 0\.4\.0/, 'still compared')
  assert.match(quiet, /That is its last report/)
  assert.doesNotMatch(Shell.daemonVersionText({ version: '0.4.0', instances: 1 }, rel), /last report/)
  I18n.setLang('de')
  assert.match(Shell.daemonVersionText({ version: '0.3.9' }, rel), /^Dein Hotkey-Daemon: 0\.3\.9/)
  assert.match(Shell.daemonVersionText({ version: '0.4.0', instances: 0 }, rel), /^Dein Hotkey-Daemon: 0\.4\.0 Das ist seine letzte Meldung/)
})
