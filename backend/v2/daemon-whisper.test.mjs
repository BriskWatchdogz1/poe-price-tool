// daemon/ppt_whisper.py — incoming trade whispers from the game's Client.txt,
// and the whisper cards of daemon/ppt_results.py.
//
// Why this lives here: `npm test` covers only backend/v2 (same reason as
// daemon-diag.test.mjs). ppt_whisper.py is standard library only; the log file
// is a file in a temp dir, the clocks are numbers the test moves, and the
// server is a fake pool that records the requests (no curl, no network).
//
// The rules under test: every way a growing log file changes is a named state;
// a private whisper never leaves the machine; the buyer's name never reaches
// the server, the journal or the disk; there is always a card.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DAEMON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../daemon')

const PRELUDE = `
import json, os, sys
sys.path.insert(0, sys.argv[1])
root = sys.argv[2]
from ppt_diag import ThrottledLog
from ppt_link import CurlResult, headers
from ppt_whisper import *
from ppt_results import whisper_card, whisper_toast, whisper_failure_card, whisper_toast_for
P = os.path.join(root, 'Client.txt')
RF = os.path.join(root, 'ppt-whisper-offset.json')
clock = [0.0]          # monotonic, for the Whispers deadlines and the journal
wall = [1.8e9]         # wall time, for the LogTailer's resume file
lines = []
log = ThrottledLog(60, clock=lambda: clock[0], emit=lines.append)
def at(t):
    clock[0] = float(t)
def write(text, mode='a'):
    with open(P, mode, encoding='utf-8', newline='') as fh:
        fh.write(text)
def L(body, name='Abc', marker='@From', tag=''):
    return f'2026/11/03 20:11:46 1234 abcd [INFO Client 77] {marker} {tag}{name}: {body}\\r\\n'
class FakeJob:
    def __init__(self, args, stdin_bytes, timeout_s, tag):
        self.args, self.stdin, self.timeout_s, self.tag = args, stdin_bytes, timeout_s, tag
        self.result = None
    def body(self):
        return json.loads(self.stdin.decode('utf-8'))
class FakePool:
    def __init__(self):
        self.jobs = []
    def start(self, args, stdin_bytes=None, timeout_s=10, tag=None):
        j = FakeJob(args, stdin_bytes, timeout_s, tag)
        self.jobs.append(j)
        return j
def answer(job, status=200, body='', rc=0, timed_out=False, err=''):
    if not isinstance(body, str):
        body = json.dumps(body)
    job.result = CurlResult(rc, status, body, err, timed_out)
TRADE = "Hi, I would like to buy your Tabula Rasa, Simple Robe listed for 12 chaos in Mercenaries (stash tab \\"Sale\\"; position: left 5, top 3)"
def make(pool=None, **kw):
    opts = dict(pool=pool or FakePool(), base_url='http://h:1', hdrs=headers('player1', '9.9.9', 'ab12'),
                log=log, clock=lambda: clock[0], instance='ab12', incoming_markers=['@From', '@Von'],
                trade_prefixes=['Hi, I would like to buy your', "Hi, I'd like to buy your", "Hi, ich möchte '"],
                trade_hints=['buy your', 'kaufen'], poll_s=0.5, resume_file=None,
                wall_clock=lambda: wall[0], config_path='/cfg/config.toml', user='player1')
    opts.update(kw)
    return Whispers(P, **opts)
def texts(card):
    return [l[0] for l in card['lines']]
def run(w, t):
    at(t)
    return w.tick(t)
def entry(verdict='below', **kw):
    e = {'key': 'ab12:w1', 'wid': 'w1', 'label': 'buyer 1', 'at': 0, 'by': 'ab12', 'truncated': False,
         'kind': 'single', 'lang': 'en', 'league': 'Mercenaries', 'tab': 'Sale', 'left': 5, 'top': 3, 'extraLen': 0,
         'item': {'text': 'Tabula Rasa, Simple Robe', 'ref': 'Tabula Rasa', 'base': 'Simple Robe', 'kind': 'unique'},
         'qty': 1, 'asked': {'amount': 100, 'unit': 'chaos', 'chaos': 100, 'chaosEach': 100},
         'market': {'chaosEach': 154, 'chaos': 154, 'source': 'ninja', 'uncertain': None},
         'ratio': 0.65, 'pct': 35, 'verdict': verdict, 'reason': None}
    e.update(kw)
    return e
`

function py (code, { asRoot = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ppt-whisper-'))
  try {
    const r = spawnSync('python3', ['-c', PRELUDE + code, DAEMON_DIR, root], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    })
    assert.equal(r.status, 0, `python3 failed: ${r.stderr}`)
    return JSON.parse(r.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// --- the tailer -------------------------------------------------------------

test('the tailer starts at the end and returns only what is appended', () => {
  const out = py(`
write(L('old 1') + L('old 2') + L('old 3'), 'w')
t = LogTailer(P, clock=lambda: wall[0])
r1 = t.poll()
write(L('hello'))
r2 = t.poll()
print(json.dumps({'r1': r1, 'r2': r2, 'started': t.started}))
`)
  assert.deepEqual(out.r1, ['tailing', [], 0, null])
  assert.equal(out.r2[0], 'tailing')
  assert.deepEqual(out.r2[1], ['2026/11/03 20:11:46 1234 abcd [INFO Client 77] @From Abc: hello'], 'exactly the new line, CR stripped')
  assert.equal(out.started, 'end')
})

test('a line split across two polls is returned once and whole', () => {
  const out = py(`
write('', 'w')
t = LogTailer(P, clock=lambda: wall[0])
t.poll()
write('abc')
a = t.poll()[1]
write('def\\r\\n')
b = t.poll()[1]
c = t.poll()[1]
print(json.dumps([a, b, c]))
`)
  assert.deepEqual(out, [[], ['abcdef'], []])
})

test('a truncated file is read again from the start, a replaced one from its start, a huge new one from its end', () => {
  const out = py(`
r = {}
write('x' * 499 + '\\n', 'w')
t = LogTailer(P, clock=lambda: wall[0], fresh_max=1000)
t.poll()
r['offset'] = t.offset
write('short line\\n', 'w')
r['truncated'] = t.poll()
os.rename(P, P + '.1')
write('first\\nsecond\\n', 'w')
r['replaced'] = t.poll()
os.rename(P, P + '.2')
write('y' * 1000 + '\\n', 'w')
r['huge'] = t.poll()
write('after\\n')
r['after'] = t.poll()
print(json.dumps(r))
`)
  assert.equal(out.offset, 500)
  assert.deepEqual(out.truncated, ['tailing', ['short line'], 0, 'reread'])
  assert.deepEqual(out.replaced, ['tailing', ['first', 'second'], 0, 'reopened'])
  assert.deepEqual(out.huge, ['tailing', [], 0, 'reopened'], 'larger than fresh_max: from its end')
  assert.deepEqual(out.after, ['tailing', ['after'], 0, null])
})

test('a missing or unreadable file is a state, and its return is noticed', () => {
  const out = py(`
r = {}
w = make()
for i in range(100):
    run(w, i * 0.5)
r['missing'] = w.state()
r['missing_lines'] = list(lines)
write('', 'w')
run(w, 60)
r['back'] = w.state()
r['back_lines'] = lines[len(r['missing_lines']):]
# a 70 KB line is dropped and counted; the next line still arrives
write(L('x' * 70000))
run(w, 61)
write(L(TRADE))
run(w, 62)
r['dropped_lines'] = [l for l in lines if '64 KB' in l]
r['posts'] = len(w.pool.jobs)
r['root'] = os.geteuid() == 0
if not r['root']:
    os.chmod(P, 0)
    del lines[:]
    w2 = make()
    run(w2, 70)
    r['unreadable'] = w2.state()
    r['unreadable_lines'] = list(lines)
    os.chmod(P, 0o644)
os.remove(P); os.mkdir(P)
del lines[:]
w3 = make()
run(w3, 80)
r['dir'] = w3.state()
r['dir_lines'] = list(lines)
print(json.dumps(r))
`)
  assert.equal(out.missing, 'missing')
  assert.equal(out.missing_lines.length, 1, out.missing_lines.join('\n'))
  assert.match(out.missing_lines[0], /Whispers are not read: .*Client\.txt does not exist\. Next: set client_log in \[whispers\] of \/cfg\/config\.toml/)
  assert.match(out.missing_lines[0], /selftest\.sh lists the ones it finds/)
  assert.equal(out.back, 'ok')
  assert.equal(out.back_lines.length, 1, out.back_lines.join('\n'))
  assert.match(out.back_lines[0], /Whispers are read again from .*Client\.txt\./)
  assert.equal(out.dropped_lines.length, 1)
  assert.match(out.dropped_lines[0], /longer than 64 KB was skipped/)
  assert.equal(out.posts, 1, 'the line after the long one arrives')
  if (!out.root) {
    assert.equal(out.unreadable, 'unreadable')
    assert.equal(out.unreadable_lines.length, 1)
    assert.match(out.unreadable_lines[0], /cannot be opened .*Next: check its permissions/)
  }
  assert.equal(out.dir, 'not-a-file')
  assert.match(out.dir_lines[0], /is not a file\. Next: point client_log at logs\/Client\.txt itself/)
})

test('a short fault on the same file goes on where it stopped, never from 0 again', () => {
  const out = py(`
r = {}
write(''.join(L('old %d' % i) for i in range(50)), 'w')
t = LogTailer(P, clock=lambda: wall[0])
t.poll()
ino = os.stat(P).st_ino
# gone for one poll (renamed away and back): the same inode returns
write('2026/11/03 20:11:46 1234 abcd [INFO Client 77] @From Abc: part')
t.poll()
os.rename(P, P + '.x')
r['gone'] = t.poll()[0]
os.rename(P + '.x', P)
write(' of it\\r\\n' + L('new 1'))
r['back'] = t.poll()
r['started'] = t.started
r['same_ino'] = os.stat(P).st_ino == ino
r['root'] = os.geteuid() == 0
if not r['root']:
    # unreadable for one poll (the directory), then readable again
    os.chmod(root, 0)
    r['unreadable'] = t.poll()[0]
    os.chmod(root, 0o700)
    write(L('new 2'))
    r['back2'] = t.poll()[1]
    # unreadable, and the same file got shorter meanwhile: read again from 0
    os.chmod(root, 0)
    t.poll()
    os.chmod(root, 0o700)
    write('short\\n', 'w')
    r['shorter'] = t.poll()
# a file that got shorter but is still larger than fresh_max: from its end
P2 = os.path.join(root, 'big.txt')
with open(P2, 'w') as fh: fh.write('x' * 499 + '\\n')
t2 = LogTailer(P2, clock=lambda: wall[0], fresh_max=100)
t2.poll()
with open(P2, 'w') as fh: fh.write('y' * 299 + '\\n')
r['big_reread'] = t2.poll()
r['big_started'] = t2.started
with open(P2, 'a') as fh: fh.write('after\\n')
r['big_after'] = t2.poll()[1]
print(json.dumps(r))
`)
  assert.equal(out.gone, 'missing')
  assert.ok(out.same_ino)
  assert.equal(out.back[1].length, 2, 'only what came after the fault; none of the 50 old lines')
  assert.match(out.back[1][0], /\] @From Abc: part of it$/, 'the line cut by the fault comes whole')
  assert.match(out.back[1][1], /\] @From Abc: new 1$/)
  assert.equal(out.back[3], null)
  assert.equal(out.started, 'continue')
  if (!out.root) {
    assert.equal(out.unreadable, 'unreadable')
    assert.equal(out.back2.length, 1)
    assert.match(out.back2[0], /new 2$/)
    assert.deepEqual(out.shorter, ['tailing', ['short'], 0, 'reread'])
  }
  assert.deepEqual(out.big_reread, ['tailing', [], 0, 'reread'])
  assert.equal(out.big_started, 'end')
  assert.deepEqual(out.big_after, ['after'])
})

test('a whisper is not posted again after a short fault, and the journal says it once', () => {
  const out = py(`
r = {}
write('', 'w')
w = make()
run(w, 0)
for i in range(3):
    write(L(TRADE.replace('12 chaos', f'{i + 20} chaos'), name='Buyer%d' % i))
run(w, 1)
r['posts'] = len(w.pool.jobs)
del lines[:]
os.rename(P, P + '.x')
run(w, 2)
os.rename(P + '.x', P)
run(w, 200)
r['after'] = len(w.pool.jobs)
r['lines'] = list(lines)
print(json.dumps(r))
`)
  assert.equal(out.posts, 3)
  assert.equal(out.after, 3, 'the three whispers are not posted again')
  assert.equal(out.lines.length, 2, out.lines.join('\n'))
  assert.match(out.lines[0], /does not exist/)
  assert.match(out.lines[1], /Whispers are read again from/)
})

test('a path whose inode keeps changing is read on as one file, with few journal lines', () => {
  const out = py(`
r = {}
body = [L('start')]
write(''.join(body), 'w')
t = LogTailer(P, clock=lambda: wall[0], churn_n=5, churn_s=60)
w = make(tailer=t)
run(w, 0)
del lines[:]
def replace(text):
    tmp = P + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as fh:
        fh.write(text)
    os.replace(tmp, P)
delivered = []
for i in range(8):
    body.append(L('line %d' % i))
    replace(''.join(body))
    wall[0] += 1
    st, got, dr, note = t.poll()
    delivered.append(len(got))
    w._note(st, note, dr)
r['delivered'] = delivered
r['churning'] = t.churning
r['lines'] = list(lines)
# 10 min later, calm again: the next replacement gets its line, with the count
wall[0] += 700
at(700)
body.append(L('late'))
replace(''.join(body))
st, got, dr, note = t.poll()
w._note(st, note, dr)
r['late_churning'] = t.churning
r['late_delivered'] = len(got)
r['late_lines'] = lines[len(r['lines']):]
print(json.dumps(r))
`)
  // the first 4 replacements read the small file from 0; from the 5th change
  // within a minute the file counts as one, and only the new line comes
  assert.deepEqual(out.delivered, [2, 3, 4, 5, 1, 1, 1, 1])
  assert.equal(out.churning, true)
  const replaced = out.lines.filter(l => /was replaced/.test(l))
  assert.equal(replaced.length, 1, out.lines.join('\n'))
  assert.equal(out.lines.filter(l => /keeps getting a new inode/.test(l)).length, 1)
  assert.equal(out.late_churning, false)
  assert.equal(out.late_delivered, 10, 'calm again: a replaced small file is read from 0')
  assert.equal(out.late_lines.length, 1, out.late_lines.join('\n'))
  assert.match(out.late_lines[0], /was replaced, reading the new file \(7 more time\(s\) since the last such line\)/)
})

test('reads are bounded per poll, and a restart resumes only on the same recent file', () => {
  const out = py(`
r = {}
write('', 'w')
t = LogTailer(P, clock=lambda: wall[0], resume_file=RF)
t.poll()
write(('z' * 1023 + '\\n') * 1024)
got, reads, polls = 0, [], 0
while polls < 10:
    before = t.offset
    st, ls, dr, note = t.poll()
    polls += 1
    reads.append(t.offset - before)
    got += len(ls)
    if got >= 1024: break
r['polls'] = polls; r['max_read'] = max(reads); r['got'] = got
r['save'] = t.save()
write('one more\\n')
t2 = LogTailer(P, clock=lambda: wall[0], resume_file=RF)
r['resumed'] = t2.poll()[1]
r['started'] = t2.started
# poll() saves a changed position itself, at most every save_every_s (wall time)
def saved():
    with open(RF) as fh: return json.load(fh)
r['first'] = saved()['offset']
write('two\\n'); wall[0] += 10; t2.poll()
r['after10'] = saved()['offset']
wall[0] += 21; t2.poll()
r['after31'] = saved()
r['size'] = os.path.getsize(P)
mt = os.stat(RF).st_mtime_ns
wall[0] += 40; t2.poll()
r['unchanged_rewritten'] = os.stat(RF).st_mtime_ns != mt or saved()['at'] != r['after31']['at']
r['wall'] = wall[0] - 40
r['no_text'] = 'one more' not in open(RF).read()
# another inode, or a stand older than 600 s: from the end
t2.save()
os.rename(P, P + '.old'); write(open(P + '.old').read(), 'w'); write('new inode\\n')
t3 = LogTailer(P, clock=lambda: wall[0], resume_file=RF)
r['inode'] = [t3.poll()[1], t3.started]
t3.save(); write('late\\n'); wall[0] += 601
t4 = LogTailer(P, clock=lambda: wall[0], resume_file=RF)
r['old'] = [t4.poll()[1], t4.started]
print(json.dumps(r))
`)
  assert.equal(out.got, 1024)
  assert.equal(out.polls, 4, '1 MB at 256 KB a poll')
  assert.ok(out.max_read <= 262144, `read ${out.max_read} bytes in one poll`)
  assert.equal(out.save, null)
  assert.deepEqual(out.resumed, ['one more'])
  assert.equal(out.started, 'resume')
  assert.equal(out.after10, out.first, 'not written again within save_every_s')
  assert.equal(out.after31.offset, out.size, 'written by poll() itself after save_every_s')
  assert.equal(out.after31.at, out.wall, '`at` is wall time')
  assert.equal(out.unchanged_rewritten, false, 'an unchanged position is not written again')
  assert.equal(out.no_text, true)
  assert.deepEqual(out.inode, [[], 'end'])
  assert.deepEqual(out.old, [[], 'end'])
})

// --- reading a line ---------------------------------------------------------

test('incoming whispers are found with and without a guild tag, outgoing ones are not', () => {
  const out = py(`
M = ['@From', '@Von']
strip = lambda s: s.rstrip('\\r\\n')
print(json.dumps([
    parse_line(strip(L('Hi, I would like …', tag='<GLD> ')), M),
    parse_line(strip(L('Hi, I would like …')), M),
    parse_line(strip(L('Hi', marker='@To')), M),
    parse_line(strip(L('Hi', marker='@An')), M),
    parse_line(strip(L('Hallo', marker='@Von')), M),
    parse_line('2026/11/03 20:11:46 1234 abcd [INFO Client 77] : You have entered Hideout.', M),
    parse_line('@From Abc: not a log line', M),
]))
`)
  assert.deepEqual(out[0], ['Abc', 'Hi, I would like …'])
  assert.deepEqual(out[1], ['Abc', 'Hi, I would like …'])
  assert.equal(out[2], null)
  assert.equal(out[3], null)
  assert.deepEqual(out[4], ['Abc', 'Hallo'])
  assert.equal(out[5], null)
  assert.equal(out[6], null)
})

test('private chat stays on the machine, and a near-template is only counted', () => {
  const out = py(`
r = {}
write('', 'w')
w = make()
run(w, 0)
del lines[:]  # the start line
write(L('see you later', name='Qwzname'))
write(L('Hi, ich möchte dich was fragen', name='Qwzname'))
write(L('hey can I buy your belt', name='Qwzname'))
run(w, 1)
r['posts'] = len(w.pool.jobs)
r['hints'] = w.hints
r['lines_now'] = list(lines)
run(w, 3600)
r['lines_3600'] = list(lines)
run(w, 3602)
r['lines_hour'] = list(lines)
# the same trade whisper five times in 10 s: one POST, four repeats
for i in range(5):
    write(L(TRADE, name='Qwzname')); run(w, 4000 + i * 2)
r['same'] = len(w.pool.jobs)
r['repeats'] = w.recs['w1']['repeats']
# 40 different ones in a minute: 30 POSTs, one line about the rest
del lines[:]
for i in range(40):
    write(L(TRADE.replace('12 chaos', f'{i + 100} chaos'), name='Buyer%d' % i)); run(w, 5000 + i)
r['many'] = len(w.pool.jobs) - r['same']
r['many_lines'] = list(lines)
print(json.dumps(r))
`)
  assert.equal(out.posts, 0, 'no private whisper is sent')
  assert.equal(out.hints, 1, 'only "buy your" looked like a trade offer')
  assert.deepEqual(out.lines_now, [])
  assert.deepEqual(out.lines_3600, [], 'not before an hour')
  assert.equal(out.lines_hour.length, 1)
  assert.match(out.lines_hour[0], /1 whisper\(s\) that looked like trade offers did not start like a trade-site template and stayed on this PC/)
  assert.match(out.lines_hour[0], /add its first words to trade_prefixes in \/cfg\/config\.toml/)
  assert.doesNotMatch(out.lines_hour[0], /Qwzname|belt/)
  assert.equal(out.same, 1)
  assert.equal(out.repeats, 4)
  assert.equal(out.many, 30)
  assert.equal(out.many_lines.length, 1, out.many_lines.join('\n'))
  assert.match(out.many_lines[0], /More than 30 trade whispers in a minute/)
  assert.doesNotMatch(out.many_lines[0], /Buyer\d/)
})

test("the buyer's name never reaches the server, the journal or the disk", () => {
  const out = py(`
r = {}
write('', 'w')
w = make(resume_file=RF)
run(w, 0)
write(L(TRADE, name='Zxqvname'))
run(w, 1)
job = w.pool.jobs[0]
r['body'] = job.body()
r['wire'] = job.stdin.decode('utf-8') + ' '.join(job.args)
r['tag'] = job.tag
answer(job, rc=7, err='curl: (7) Failed to connect')
cards = run(w, 2)
r['fail_card'] = [texts(c) for c, t in cards]
r['fail_toast'] = [t for c, t in cards]
w.tailer.save()
r['disk'] = open(RF).read()
r['journal'] = list(lines)
e = entry(label='buyer 1')
r['toast'] = whisper_toast(e)
r['card'] = texts(whisper_card(e, name='Zxqvname'))
print(json.dumps(r))
`)
  assert.equal(out.body.label, 'buyer 1')
  assert.equal(out.body.wid, 'w1')
  assert.equal(out.body.v, 1)
  assert.equal(out.tag, 'whisper')
  assert.doesNotMatch(out.wire, /Zxqvname/, 'not in the body, not in the headers')
  assert.ok(out.journal.length >= 1)
  assert.doesNotMatch(out.journal.join('\n'), /Zxqvname/)
  assert.match(out.journal.join('\n'), /Whisper w1 \(buyer 1\) not checked/)
  assert.doesNotMatch(out.disk, /Zxqvname/)
  assert.doesNotMatch(JSON.stringify(out.toast), /Zxqvname/)
  assert.match(out.toast[0], /buyer 1/)
  assert.equal(out.card[0], 'Whisper from Zxqvname', 'only the overlay card names the buyer')
  assert.deepEqual(out.fail_card[0].slice(1), ['whisper not checked: server not reachable', 'see the journal'])
  assert.equal(out.fail_toast[0][0], 'Whisper from buyer 1')
  assert.doesNotMatch(JSON.stringify(out.fail_toast), /Zxqvname/)
})

test('each buyer keeps one pseudonym for the run; the name reaches the notification only when asked', () => {
  const out = py(`
r = {}
write('', 'w')
w = make()
run(w, 0)
write(L(TRADE, name='Zxqalpha'))
write(L(TRADE.replace('12 chaos', '13 chaos'), name='Zxqbeta'))
run(w, 1)
write(L(TRADE.replace('12 chaos', '14 chaos'), name='Zxqalpha'))
run(w, 2)
r['labels'] = [j.body()['label'] for j in w.pool.jobs]
r['wire'] = ' '.join(j.stdin.decode('utf-8') for j in w.pool.jobs)
p = Pseudonyms(keep=2)
r['keep2'] = [p.label('a'), p.label('b'), p.label('c'), p.label('a'), p.label('c')]
for show in (False, True):
    w2 = make(toast_shows_name=show)
    run(w2, 10)
    write(L(TRADE.replace('12 chaos', '15 chaos' if show else '16 chaos'), name='Zxqgamma'))
    run(w2, 11)
    job = w2.pool.jobs[0]
    answer(job, 200, {'v': 1, 'entry': entry('below', label='buyer 1')})
    cards = run(w2, 12)
    r['toast_%s' % str(show).lower()] = [t for c, t in cards]
    r['card_%s' % str(show).lower()] = [texts(c) for c, t in cards]
    r['post_%s' % str(show).lower()] = job.stdin.decode('utf-8')
print(json.dumps(r))
`)
  assert.deepEqual(out.labels, ['buyer 1', 'buyer 2', 'buyer 1'], 'two buyers, two numbers; the first keeps his')
  assert.doesNotMatch(out.wire, /Zxq/)
  assert.deepEqual(out.keep2, ['buyer 1', 'buyer 2', 'buyer 3', 'buyer 4', 'buyer 3'],
    'keep=2: the oldest name is forgotten and gets a new number when it comes back')
  assert.equal(out.toast_false[0][0], 'Whisper from buyer 1')
  assert.doesNotMatch(JSON.stringify(out.toast_false), /Zxqgamma/)
  assert.equal(out.toast_true[0][0], 'Whisper from Zxqgamma', 'toast_shows_name = true: the name in the notification')
  assert.equal(out.card_true[0][0], 'Whisper from Zxqgamma')
  assert.doesNotMatch(out.post_true, /Zxqgamma/, 'never in the POST')
  assert.doesNotMatch(out.post_false, /Zxqgamma/)
})

test('the text is cut the way the server counts: bytes after JSON escaping, UTF-16 units', () => {
  const out = py(`
r = {}
write('', 'w')
w = make()
run(w, 0)
write(L('Hi, I would like to buy your X ' + chr(34) * 900 + chr(0x1F600) * 600))
write(L('Hi, I would like to buy your Y ' + chr(1) * 1000))
write(L('Hi, I would like to buy your Z ' + chr(0x1F600) * 1000))
run(w, 1)
r['posts'] = [(len(j.stdin), j.stdin.decode('utf-8')) for j in w.pool.jobs]
r['short'] = cut_body('Hi')
print(json.dumps(r))
`)
  assert.equal(out.posts.length, 3)
  for (const [bytes, wire] of out.posts) {
    const body = JSON.parse(wire)
    assert.ok(bytes <= 3500 + 200, `the POST is ${bytes} bytes`)
    assert.ok(Buffer.byteLength(JSON.stringify(body.body), 'utf8') - 2 <= 3500)
    assert.ok(body.body.length <= 1500, `${body.body.length} UTF-16 units`)
    assert.equal(body.truncated, true)
    assert.doesNotMatch(body.body, /[\uD800-\uDBFF]$/, 'no half of an emoji at the end')
  }
  assert.deepEqual(out.short, ['Hi', false])
})

test('a server without the route keeps the daemon running and says so once', () => {
  const out = py(`
r = {}
write('', 'w')
w = make()
run(w, 0)
del lines[:]  # the start line
write(L(TRADE, name='Zxqvname'))
run(w, 1)
answer(w.pool.jobs[0], 405, 'Method not allowed')
r['card'] = [texts(c) for c, t in run(w, 2)]
r['state'] = w.state()
write(L(TRADE.replace('12', '13'), name='Zxqvname'))
r['second'] = [texts(c) for c, t in run(w, 3)]
r['posts_while_unsupported'] = len(w.pool.jobs)
r['lines'] = list(lines)
write(L(TRADE.replace('12', '14'), name='Zxqvname'))
run(w, 603)
r['recheck_posts'] = len(w.pool.jobs)
answer(w.pool.jobs[-1], 200, {'v': 1, 'entry': entry(wid='w3', key='ab12:w3', label='buyer 1')})
run(w, 604)
r['back'] = w.state()
r['back_lines'] = lines[len(r['lines']):]
# 413, 429 and nothing at all: a card and one journal line each
del lines[:]
fails = []
for i, (status, body, rc) in enumerate([(413, '{"error":"body too large"}', 0),
                                        (429, '{"error":"too-many-whispers"}', 0), (None, '', 7)]):
    write(L(TRADE.replace('12', str(20 + i)), name='Zxqvname'))
    run(w, 700 + i * 2)
    answer(w.pool.jobs[-1], status, body, rc=rc, err='curl: (7) Failed' if rc else '')
    fails.append([texts(c) for c, t in run(w, 701 + i * 2)])
r['fails'] = fails
r['fail_lines'] = list(lines)
# a 45 KB whisper of 3-byte characters is cut before it is sent
write(L(TRADE + ' ' + '€' * 15000, name='Zxqvname'))
run(w, 800)
long = w.pool.jobs[-1]
r['long_bytes'] = len(long.stdin)
r['long_body'] = long.body()
print(json.dumps(r))
`)
  assert.deepEqual(out.card[0].slice(1), ['whisper seen — this server cannot check whispers yet'])
  assert.equal(out.card[0].length, 2, 'no tab line: the daemon does not read templates')
  assert.equal(out.state, 'unsupported')
  assert.deepEqual(out.second[0].slice(1), ['whisper seen — this server cannot check whispers yet'])
  assert.equal(out.posts_while_unsupported, 1, 'not asked again before 10 min')
  assert.equal(out.lines.length, 1, out.lines.join('\n'))
  assert.match(out.lines[0], /has no \/daemon\/whisper \(HTTP 405\): it is older than this daemon/)
  assert.equal(out.recheck_posts, 2, 'asked again after 600 s')
  assert.equal(out.back, 'ok')
  assert.match(out.back_lines.join('\n'), /Whisper check is offered by the backend now/)
  assert.equal(out.fails[0][0][1], 'whisper not checked: too long for the server')
  assert.equal(out.fails[1][0][1], 'whisper not checked: too many whispers this minute')
  assert.equal(out.fails[2][0][1], 'whisper not checked: server not reachable')
  assert.equal(out.fail_lines.length, 3, out.fail_lines.join('\n'))
  assert.doesNotMatch(out.fail_lines.join('\n'), /Zxqvname/)
  assert.ok(out.long_bytes <= 3500 + 200, `the POST body is ${out.long_bytes} bytes`)
  assert.ok(Buffer.byteLength(out.long_body.body, 'utf8') <= 3500)
  assert.ok(out.long_body.body.length <= 1500)
  assert.equal(out.long_body.truncated, true)
  assert.match(out.long_body.body, /€/)
  assert.ok(out.long_bytes < 3500 + 100, 'sent as UTF-8, not as \\u escapes (6 bytes each)')
})

test('a pending verdict is replaced by the feed event with the same wid, or closed with words', () => {
  const out = py(`
r = {}
write('', 'w')
w = make()
run(w, 0)
write(L(TRADE, name='Zxqvname'))
run(w, 1)
answer(w.pool.jobs[0], 200, {'v': 1, 'entry': entry('pending')})
r['pending'] = [texts(c) for c, t in run(w, 2)]
ev = {'kind': 'whisper', 'by': 'ab12', 'wid': 'w1', 'entry': entry('below')}
r['final'] = [texts(c) for c in [c for c, t in w.event(ev, 3)]]
r['again'] = w.event(ev, 4)
r['other'] = w.event({**ev, 'by': 'zz99', 'entry': entry('fair')}, 5)
r['late_pending'] = w.event({**ev, 'entry': entry('pending')}, 6)
# a pending one that never gets its result
write(L(TRADE.replace('12', '13'), name='Zxqvname'))
run(w, 10)
answer(w.pool.jobs[1], 200, {'v': 1, 'entry': entry('pending', wid='w2', key='ab12:w2')})
run(w, 11)
r['t130'] = [texts(c) for c, t in run(w, 130)]
r['t132'] = [texts(c) for c, t in run(w, 132)]
w90 = make(result_wait_s=90)
run(w90, 200)
write(L(TRADE.replace('12', '14'), name='Zxqvname'))
run(w90, 201)
answer(w90.pool.jobs[0], 200, {'v': 1, 'entry': entry('pending')})
run(w90, 202)
r['t90'] = [texts(c) for c, t in run(w90, 293)]
# the same final entry as the answer and as a feed event: one card
write(L(TRADE.replace('12', '15'), name='Zxqvname'))
run(w, 300)
fin = entry('fair', wid='w3', key='ab12:w3')
w.event({'kind': 'whisper', 'by': 'ab12', 'wid': 'w3', 'entry': fin}, 300.5)
answer(w.pool.jobs[2], 200, {'v': 1, 'entry': fin})
r['dup'] = run(w, 301)
print(json.dumps(r))
`)
  assert.equal(out.pending[0][2], 'checking the market…')
  assert.match(out.final[0][2], /— 35 % below market$/)
  assert.deepEqual(out.again, [], 'the same verdict again is no new card')
  assert.deepEqual(out.other, [], "another daemon's entry with the same wid is ignored")
  assert.deepEqual(out.late_pending, [], 'a final card never falls back to pending')
  assert.deepEqual(out.t130, [])
  assert.equal(out.t132[0][2], 'no market check within 2 min')
  assert.equal(out.t90[0][2], 'no market check within 90 s')
  assert.deepEqual(out.dup, [])
})

// --- the stash cell frame -----------------------------------------------------
// ppt_stash_grid.Highlighter asks for the whispers with a stash position,
// newest first; the buyer's name is not among what it gets.

test('the whispers with a stash position are handed out newest first, without the name', () => {
  const out = py(`
write('', 'w')
w = make()
run(w, 0)
r = {'none': w.positions()}
write(L(TRADE, name='Zxqvname'))
write(L(TRADE.replace('left 5', 'left 14'), name='Otherbuyer'))
write(L("Hi, I'd like to buy your 10 Orb of Alchemy for my 1 Divine Orb in Mercenaries", name='Bulkbuyer'))
run(w, 1)
r['before_answer'] = w.positions()
answer(w.pool.jobs[0], 200, {'v': 1, 'entry': entry('below')})
answer(w.pool.jobs[1], 200, {'v': 1, 'entry': entry('pending', wid='w2', key='ab12:w2', left=14, quad=True)})
answer(w.pool.jobs[2], 200, {'v': 1, 'entry': entry('fair', wid='w3', key='ab12:w3', kind='bulk', tab=None, left=None, top=None)})
run(w, 2)
r['all'] = w.positions()
print(json.dumps(r))
`)
  assert.deepEqual(out.none, [])
  assert.deepEqual(out.before_answer, [], 'the position is the server\'s reading of the template')
  assert.deepEqual(out.all, [
    { wid: 'w2', label: 'buyer 2', tab: 'Sale', left: 14, top: 3, quad: true },
    { wid: 'w1', label: 'buyer 1', tab: 'Sale', left: 5, top: 3, quad: null }
  ], 'a pending one has its position already; a bulk whisper names none')
  assert.doesNotMatch(JSON.stringify(out), /Zxqvname|Otherbuyer|Bulkbuyer/)
})

// --- the cards --------------------------------------------------------------

test('whisper cards say your price against the market, and why when there is no verdict', () => {
  const out = py(`
r = {}
r['below'] = texts(whisper_card(entry('below'), name='Abc'))
r['fair'] = texts(whisper_card(entry('fair', pct=3)))
r['above'] = whisper_card(entry('above', pct=20))['lines'][2]
r['divine'] = texts(whisper_card(entry('below', asked={'amount': 1, 'unit': 'divine', 'chaos': 150, 'chaosEach': 150},
                                       market={'chaosEach': 165, 'chaos': 165, 'source': 'ninja', 'uncertain': None}, pct=9)))[2]
bulk = entry('fair', kind='bulk', qty=10, tab=None, left=None, top=None, extraLen=5,
             item={'text': 'Orb of Alchemy', 'ref': 'Orb of Alchemy', 'base': None, 'kind': 'fungible'},
             asked={'amount': 1, 'unit': 'Divine Orb', 'chaos': 150, 'chaosEach': 15},
             market={'chaosEach': 16, 'chaos': 160, 'source': 'faustus', 'uncertain': None}, pct=6)
r['bulk'] = texts(whisper_card(bulk, note='20c?'))
r['stack'] = texts(whisper_card(entry('not-compared', reason='stack-unknown', item={'text': 'Orb of Alchemy', 'kind': 'fungible'},
                                      asked={'amount': 1, 'unit': 'chaos', 'chaos': 1, 'chaosEach': 1},
                                      market={'chaosEach': 0.149, 'chaos': 0.149, 'source': 'ninja', 'uncertain': None})))[1:3]
stack_entry = lambda **kw: entry('not-compared', reason='stack-unknown', item={'text': 'Orb of Alchemy', 'kind': 'fungible'},
                                 asked=kw.get('asked', {'amount': 100, 'unit': 'chaos', 'chaos': 100, 'chaosEach': 100}),
                                 market={'chaosEach': 0.4, 'chaos': 0.4, 'source': 'faustus', 'uncertain': None},
                                 stack=kw.get('stack'))
r['stack_sync'] = whisper_card(stack_entry(stack={'size': 20, 'from': 'sync', 'chaosEach': 5}))['lines'][2]
r['stack_div'] = texts(whisper_card(stack_entry(asked={'amount': 1, 'unit': 'divine', 'chaos': 150, 'chaosEach': 150},
                                                stack={'size': 20, 'from': 'whisper', 'chaosEach': 7.5})))[1:3]
# A dear stack in divine stays under the overlay's 80-character cut (it also elides to its width).
r['stack_long'] = texts(whisper_card(stack_entry(asked={'amount': 12.5, 'unit': 'divine', 'chaos': 2500, 'chaosEach': 2500},
                                                 stack={'size': 5000, 'from': 'sync', 'chaosEach': 0.5})))[2:3]
r['stack_de'] = texts(whisper_card(stack_entry(asked={'amount': 1.5, 'unit': 'chaos', 'chaos': 1.5, 'chaosEach': 1.5},
                                               stack={'size': 3, 'from': 'sync', 'chaosEach': 0.5}), lang='de'))[2]
r['stack_odd'] = [texts(whisper_card(stack_entry(stack=odd)))[2] for odd in ({'size': 'x'}, {'size': 20}, 'junk', [], {'size': 1, 'chaosEach': 100})]
r['stack_nochaos'] = texts(whisper_card(stack_entry(asked={'amount': 3, 'unit': 'banana', 'chaos': None, 'chaosEach': None},
                                                   stack={'size': 20, 'from': 'sync', 'chaosEach': None})))[1:3]
r['stack_toast'] = whisper_toast(stack_entry(stack={'size': 20, 'from': 'sync', 'chaosEach': 5}))
# What would stop a verdict travels with the readings: on the item line, next
# to the listed price, and the readings line turns to a warning.
stack_caveat = lambda c, **kw: dict(stack_entry(**kw), caveat=c)
r['stack_rate'] = whisper_card(stack_caveat('rate-unknown', asked={'amount': 1, 'unit': 'divine', 'chaos': 150, 'chaosEach': 150},
                                            stack={'size': 20, 'from': 'sync', 'chaosEach': 7.5}))['lines'][1:3]
r['stack_thin'] = whisper_card(stack_caveat('uncertain-price'))['lines'][1:3]
r['stack_newer'] = texts(whisper_card(stack_caveat('<odd>' * 20)))[1]
r['stack_nocaveat'] = whisper_card(stack_caveat(None))['lines'][1:3]
r['stack_rate_toast'] = whisper_toast(stack_caveat('rate-unknown'))[1]
# Below the card's three decimals a reading is no 0.
r['stack_tiny'] = texts(whisper_card(stack_entry(asked={'amount': 1, 'unit': 'chaos', 'chaos': 1, 'chaosEach': 1},
                                                 stack={'size': 5000, 'from': 'whisper', 'chaosEach': 0.0002})))[2]
r['stack_tiny_de'] = texts(whisper_card(stack_entry(asked={'amount': 1, 'unit': 'chaos', 'chaos': 1, 'chaosEach': 1},
                                                    stack={'size': 5000, 'from': 'whisper', 'chaosEach': 0.0002}), lang='de'))[2]
r['stack_small'] = texts(whisper_card(stack_entry(asked={'amount': 1, 'unit': 'chaos', 'chaos': 1, 'chaosEach': 1},
                                                  stack={'size': 40, 'from': 'whisper', 'chaosEach': 0.025})))[2]
r['rare'] = whisper_card(entry('not-compared', reason='rare', market=None))['lines'][2]
r['league'] = whisper_card(entry('not-compared', reason='other-league', league='Standard', market=None))['lines'][2]
r['unpriced'] = texts(whisper_card(entry('not-compared', kind='unpriced-listing', reason='unpriced-listing', asked=None)))[2]
r['unparsed'] = texts(whisper_card({'wid': 'w4', 'label': 'buyer 2', 'verdict': 'unparsed'}))
r['pending_final'] = [whisper_card(entry('pending'))['final'], whisper_card(entry('fair'))['final']]
r['key'] = whisper_card(entry('fair'))['key']
r['de'] = texts(whisper_card(entry('below', asked={'amount': 1.5, 'unit': 'chaos', 'chaos': 1.5, 'chaosEach': 1.5},
                                    market={'chaosEach': 2.5, 'chaos': 2.5, 'source': 'ninja', 'uncertain': None}), lang='de'))[2]
evil = entry('fair', item={'text': '<img src=x onerror=alert(1)>', 'kind': 'unique'}, tab='"><b>x</b>')
card = whisper_card(evil)
r['evil'] = texts(card)
from ppt_display import Notifier
n = Notifier(log, which=lambda p: '/bin/true')
r['evil_args'] = n.args(*whisper_toast_for(card))
r['fail'] = texts(whisper_failure_card('w5', 'buyer 3', 'unreachable-28', name='Abc'))
print(json.dumps(r))
`)
  assert.deepEqual(out.below, ['Whisper from Abc', 'Tabula Rasa, Simple Robe', 'your 100 chaos · market 154 c — 35 % below market', 'tab "Sale" · left 5, top 3'])
  assert.equal(out.fair[0], 'Whisper from buyer 1', 'without a name: the label')
  assert.match(out.fair[2], /— fair$/)
  assert.deepEqual(out.above, ['your 100 chaos · market 154 c — 20 % above market', 'good'])
  assert.equal(out.divine, 'your 1 divine · market 1.1 divine — 9 % below market', 'the market in the listing\'s unit')
  assert.deepEqual(out.bulk.slice(1), ['10 × Orb of Alchemy for 1 Divine Orb', 'your 0.1 Divine Orb each · market 0.107 Divine Orb each — fair', 'note: 20c?'])
  // A single whisper for a stackable: both readings of 'listed for', no
  // verdict. The listed price stands on the item line, so the readings fit the
  // overlay's width.
  assert.deepEqual(out.stack, ['Orb of Alchemy for 1 chaos', '1 c each · market 0.149 c each — stack size unknown'])
  assert.deepEqual(out.stack_sync, ['100 c each, or 5 c each as a stack of 20 (last sync) · market 0.4 c each', 'muted'],
    'a size from the sync says so: that stack may have changed since')
  assert.deepEqual(out.stack_div, ['Orb of Alchemy for 1 divine', '150 c each, or 7.5 c each as a stack of 20 · market 0.4 c each'])
  assert.equal(out.stack_de, '1,5 c each, or 0,5 c each as a stack of 3 (last sync) · market 0,4 c each')
  assert.deepEqual(out.stack_rate, [['Orb of Alchemy for 1 divine · C:D rate unknown', 'name'],
    ['150 c each, or 7.5 c each as a stack of 20 (last sync) · market 0.4 c each', 'warn']])
  assert.deepEqual(out.stack_thin, [['Orb of Alchemy for 100 chaos · price uncertain', 'name'],
    ['100 c each · market 0.4 c each — stack size unknown', 'warn']])
  assert.ok(out.stack_newer.startsWith('Orb of Alchemy for 100 chaos · <odd>'), out.stack_newer)
  assert.ok(out.stack_newer.length <= 80, out.stack_newer)
  assert.deepEqual(out.stack_nocaveat, [['Orb of Alchemy for 100 chaos', 'name'], ['100 c each · market 0.4 c each — stack size unknown', 'muted']])
  assert.equal(out.stack_rate_toast, 'Orb of Alchemy for 100 chaos · C:D rate unknown\n100 c each · market 0.4 c each — stack size unknown\ntab "Sale" · left 5, top 3',
    'the notification carries the caveat too')
  assert.equal(out.stack_tiny, '1 c each, or <0.001 c each as a stack of 5,000 · market 0.4 c each', 'never "0 c each"')
  assert.equal(out.stack_tiny_de, '1 c each, or <0,001 c each as a stack of 5.000 · market 0,4 c each')
  assert.equal(out.stack_small, '1 c each, or 0.025 c each as a stack of 40 · market 0.4 c each')
  for (const t of out.stack_odd) assert.equal(t, '100 c each · market 0.4 c each — stack size unknown', t)
  assert.deepEqual(out.stack_nochaos, ['Orb of Alchemy', 'your 3 banana · market 0.4 c each, per unit or per stack unknown — not compared'],
    'without a chaos value of the listed price: the plain reason line')
  assert.equal(out.stack_toast[1], 'Orb of Alchemy for 100 chaos\n100 c each, or 5 c each as a stack of 20 (last sync) · market 0.4 c each\ntab "Sale" · left 5, top 3', 'the notification says the same')
  assert.ok(out.stack_long.every(t => t.length <= 80), out.stack_long.join(' | '))
  assert.deepEqual(out.rare, ['your 100 chaos · rare, no market price — not compared', 'muted'])
  assert.deepEqual(out.league, ['your 100 chaos · listed in Standard, not your league — not compared', 'warn'])
  assert.equal(out.unpriced, 'not listed with a price · market 154 c — not compared')
  assert.deepEqual(out.unparsed, ['Whisper from buyer 2', 'whisper not recognised — see the browser'])
  assert.deepEqual(out.pending_final, [false, true])
  assert.equal(out.key, 'whisper:w1')
  assert.equal(out.de, 'your 1,5 chaos · market 2,5 c — 35 % below market')
  assert.equal(out.evil[1], '<img src=x onerror=alert(1)>', 'the overlay line is the literal text')
  assert.equal(out.evil[3], 'tab ""><b>x</b>" · left 5, top 3')
  assert.ok(out.evil_args.some(a => a.includes('&lt;img')), out.evil_args.join(' | '))
  assert.ok(!out.evil_args.some(a => a.includes('<img') || a.includes('<b>')))
  assert.deepEqual(out.fail, ['Whisper from Abc', 'whisper not checked: no answer in time', 'see the journal'])
})
