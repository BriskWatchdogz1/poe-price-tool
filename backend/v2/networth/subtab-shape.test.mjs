// backend/v2/networth/subtab-shape.test.mjs
// The one line that says what GGG's folder-tab children are. It decides
// nothing, so what is tested is what it SHOWS — and that it cannot be made to
// spam the log, leak a credential or forge a line with foreign text.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { noteSubTabShape, resetSubTabShapeLog } from './subtab-shape.mjs'

beforeEach(() => resetSubTabShapeLog())

const collector = () => { const lines = []; return { lines, log: { log: m => lines.push(m) } } }
const MAPS = { index: 2, name: 'Maps', type: 'MapStash' }

/** The parent response as the walk has it in hand: the whole parsed body. */
const parentWith = (children, stash = {}) => ({ stash: { ...stash, children } })

// The production shape, from the log line in docs/bugs.md B19: page numbers for
// names, one type for all of them, and a metadata field whose CONTENT was the
// thing nobody had ever seen.
test('the measured shape: child count, field union, names, types and the metadata CONTENT', () => {
  const { lines, log } = collector()
  const children = [
    { id: 'a1', parent: 'P', name: '1', type: 'MapStash', metadata: { folder: true, colour: 'ff0000' } },
    { id: 'a2', parent: 'P', name: '2', type: 'MapStash', metadata: { folder: true } }
  ]
  noteSubTabShape(MAPS, parentWith(children), log)

  assert.equal(lines.length, 1, 'one line, not one per child')
  const line = lines[0]
  assert.match(line, /folder tab "Maps" \(MapStash\) sub-tab shape as GGG returns it, once per process/)
  assert.match(line, /2 children/)
  assert.match(line, /entry fields: id,parent,name,type,metadata/)
  assert.match(line, /"1" type=MapStash/)
  assert.match(line, /"2" type=MapStash/)
  // The point of the whole exercise: the content, not just the field name.
  assert.match(line, /metadata=\{"folder":true,"colour":"ff0000"\}/)
})

test('an id is named as a field but never printed — it addresses somebody\'s stash', () => {
  const { lines, log } = collector()
  noteSubTabShape(MAPS, parentWith([{ id: 'SECRET-TAB-ID', parent: 'PARENT-ID', name: '1' }]), log)
  assert.match(lines[0], /entry fields: id,parent,name/)
  assert.ok(!lines[0].includes('SECRET-TAB-ID'), 'a child id must not be in the log')
  assert.ok(!lines[0].includes('PARENT-ID'), 'nor the parent handle')
})

// The field that answers the open question may not be one this file knows the
// name of, so anything that is not an id and not shown elsewhere is printed by
// value. Nothing has to be predicted in advance.
test('an unforeseen field — a folder or sort key — shows up by value on its own', () => {
  const { lines, log } = collector()
  noteSubTabShape(MAPS, parentWith([
    { id: 'a', name: '1', type: 'MapStash', folder: 'Unique Maps', sortOrder: 3, isPage: false }
  ]), log)
  assert.match(lines[0], /folder=Unique Maps/)
  assert.match(lines[0], /sortOrder=3/)
  assert.match(lines[0], /isPage=false/)
})

test('the parent side is reported too: its response keys, its fields and its metadata', () => {
  const { lines, log } = collector()
  const parent = { stash: { id: 'P', type: 'MapStash', metadata: { layout: 'pages' }, children: [{ id: 'a' }] } }
  noteSubTabShape(MAPS, parent, log)
  assert.match(lines[0], /parent response keys: stash/)
  assert.match(lines[0], /parent stash fields: id,type,metadata,children/)
  assert.match(lines[0], /parent metadata: \{"layout":"pages"\}/)
})

test('a missing metadata is stated as missing, not as an empty object', () => {
  const { lines, log } = collector()
  noteSubTabShape(MAPS, parentWith([{ id: 'a', name: '', type: 'UniqueStash' }]), log)
  assert.match(lines[0], /metadata=\(none\)/)
  assert.match(lines[0], /parent metadata: \(none\)/)
  assert.match(lines[0], /"" type=UniqueStash/, 'an empty name is a name and prints as one')
})

// FOREIGN DATA, treated as foreign data. Same expression as /config-view.
test('a key that could name a credential is redacted, at any depth and in an array', () => {
  const { lines, log } = collector()
  noteSubTabShape(MAPS, parentWith([{
    id: 'a',
    name: '1',
    metadata: { poesessid: 'COOKIEVALUE', nested: { apiToken: 'TOKENVALUE' }, list: [{ password: 'PWVALUE' }] },
    accountName: 'ACCOUNTVALUE'
  }]), log)
  const line = lines[0]
  for (const secret of ['COOKIEVALUE', 'TOKENVALUE', 'PWVALUE', 'ACCOUNTVALUE']) {
    assert.ok(!line.includes(secret), `${secret} must not reach the log`)
  }
  assert.match(line, /\[redacted\]/)
})

test('control characters in foreign text cannot forge a log line', () => {
  const { lines, log } = collector()
  const CTRL = String.fromCharCode(7)
  noteSubTabShape(MAPS, parentWith([
    { id: 'a', name: `x\ny\r[stash-client] fake`, type: `A${CTRL}B`, metadata: { note: 'p\nq' } }
  ]), log)
  assert.equal(lines.length, 1, 'one line — a newline in the data must not become two')
  assert.ok(!/[\u0000-\u001f\u007f]/.test(lines[0]), 'no control character survives into the line')
  assert.match(lines[0], /"x y \[stash-client\] fake"/, 'the text is kept, defanged')
})

test('one absurd response cannot fill the log: children, values and depth are all capped', () => {
  const { lines, log } = collector()
  const children = Array.from({ length: 500 }, (_, i) => ({
    id: `c${i}`, name: String(i), type: 'MapStash', metadata: { blob: 'x'.repeat(5000) }
  }))
  noteSubTabShape(MAPS, parentWith(children), log)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /500 children/, 'the COUNT is always honest, however much is elided')
  assert.match(lines[0], /\(cut\)|more/)
  assert.ok(lines[0].length < 6000, `the line is bounded (was ${lines[0].length})`)
})

test('a deeply nested metadata is elided rather than walked forever', () => {
  const { lines, log } = collector()
  let deep = { end: 'bottom' }
  for (let i = 0; i < 40; i++) deep = { down: deep }
  noteSubTabShape(MAPS, parentWith([{ id: 'a', name: '1', metadata: deep }]), log)
  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes('bottom'))
})

test('a cycle in the response does not throw', () => {
  const { lines, log } = collector()
  const meta = { self: null }
  meta.self = meta
  noteSubTabShape(MAPS, parentWith([{ id: 'a', name: '1', metadata: meta }]), log)
  assert.equal(lines.length, 1)
})

// ONCE PER FOLDER TAB PER PROCESS. The refresher reaches the map stash every
// lap and the server builds a fresh client every tick, so anything weaker than
// module memory is a line every couple of hours, forever, for an answer that
// does not change.
test('once per folder tab per process, and a second tab still gets its own line', () => {
  const { lines, log } = collector()
  const p = parentWith([{ id: 'a', name: '1' }])
  noteSubTabShape(MAPS, p, log)
  noteSubTabShape(MAPS, p, log)
  noteSubTabShape(MAPS, p, log)
  assert.equal(lines.length, 1)
  noteSubTabShape({ index: 16, name: 'UNIQUE', type: 'UniqueStash' }, p, log)
  assert.equal(lines.length, 2)
  resetSubTabShapeLog()
  noteSubTabShape(MAPS, p, log)
  assert.equal(lines.length, 3, 'the reset is what lets a test see the line at all')
})

test('a tab list of pathological length cannot make it log without end', () => {
  const { lines, log } = collector()
  const p = parentWith([{ id: 'a', name: '1' }])
  for (let i = 0; i < 200; i++) noteSubTabShape({ index: i, name: `T${i}`, type: 'MapStash' }, p, log)
  assert.ok(lines.length <= 20, `at most one shape per tab, bounded (was ${lines.length})`)
})

test('a response with no children at all is still one honest line', () => {
  const { lines, log } = collector()
  noteSubTabShape(MAPS, { stash: {} }, log)
  assert.match(lines[0], /0 children/)
  assert.match(lines[0], /entry fields: \(none\)/)
  noteSubTabShape({ index: 3, name: 'X', type: 'MapStash' }, null, log)
  assert.match(lines[1], /0 children/)
})

test('it returns nothing and takes no decision — observation only', () => {
  const { log } = collector()
  assert.equal(noteSubTabShape(MAPS, parentWith([{ id: 'a', name: '1' }]), log), undefined)
})

test('a log without a log() method is not a crash', () => {
  resetSubTabShapeLog()
  assert.doesNotThrow(() => noteSubTabShape(MAPS, parentWith([{ id: 'a' }]), {}))
  resetSubTabShapeLog()
  assert.doesNotThrow(() => noteSubTabShape(MAPS, parentWith([{ id: 'a' }]), null))
})
