// sparkSvg() from app.js: rising/falling color and the invert flag of the rail
// rows. app.js is a classic <script> (not a module), so the function is cut out
// of the file and evaluated on its own — exactly the source that also runs in
// the browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const src = await readFile(new URL('./app.js', import.meta.url), 'utf8')
const start = src.indexOf('function sparkSvg (')
assert.ok(start >= 0, 'sparkSvg not found in app.js')
const end = src.indexOf('\n}\n', start)
assert.ok(end > start, 'end of sparkSvg not found')
// eslint-disable-next-line no-new-func
const sparkSvg = new Function(`${src.slice(start, end + 2)}\nreturn sparkSvg`)()

const cls = (html) => html.match(/class="nspark (\w+)"/)?.[1] ?? null

test('rising series = green, falling series = red', () => {
  assert.equal(cls(sparkSvg([1, 2, 3])), 'up')
  assert.equal(cls(sparkSvg([3, 2, 1])), 'dn')
  // A tie still counts as "did not fall".
  assert.equal(cls(sparkSvg([2, 5, 2])), 'up')
})

test('invert flips the class (lifeforce rows: more per Chaos = bad)', () => {
  assert.equal(cls(sparkSvg([1, 2, 3], true)), 'dn')
  assert.equal(cls(sparkSvg([3, 2, 1], true)), 'up')
  // An explicit false behaves like no flag at all.
  assert.equal(cls(sparkSvg([1, 2, 3], false)), 'up')
})

test('without the flag the old behaviour stands (item card, poe.ninja reference)', () => {
  assert.equal(sparkSvg([1, 2, 3]), sparkSvg([1, 2, 3], false))
})

test('fewer than 2 points -> no line at all', () => {
  assert.equal(sparkSvg([]), '')
  assert.equal(sparkSvg([5]), '')
  assert.equal(sparkSvg(null), '')
  assert.equal(sparkSvg(undefined, true), '')
  assert.equal(sparkSvg('no series'), '')
})

test('points span the full width and height', () => {
  const html = sparkSvg([0, 10])
  assert.match(html, /points="0\.0,16\.0 66\.0,0\.0"/)
})
