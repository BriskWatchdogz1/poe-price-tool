// The server names its own version from package.json and says "unknown" when
// it cannot read one — it never invents a version. VERSION and USER_AGENT are
// what the release check sends to GitHub and shows in the browser; AGENT_BASE
// is the start of every User-Agent the tool sends in its own name.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPackageVersion, VERSION, USER_AGENT, AGENT_BASE, agentBase } from './version.mjs'

function withTempDir (fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'version-test-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('reads the version field of a package.json', () => withTempDir(dir => {
  const file = path.join(dir, 'package.json')
  writeFileSync(file, JSON.stringify({ version: '1.2.3' }))
  assert.equal(readPackageVersion(pathToFileURL(file)), '1.2.3')
}))

test('only an x.y.z version is a version: pre-releases and words are null', () => withTempDir(dir => {
  const file = path.join(dir, 'package.json')
  for (const [v, want] of [['0.2.0-beta', null], ['nightly', null], ['1.2', null], ['', null], ['0.2.0', '0.2.0']]) {
    writeFileSync(file, JSON.stringify({ version: v }))
    assert.equal(readPackageVersion(pathToFileURL(file)), want, v)
  }
}))

test('a missing file is null, not a guess', () => withTempDir(dir => {
  assert.equal(readPackageVersion(pathToFileURL(path.join(dir, 'nope.json'))), null)
}))

test('no version field, a non-string version or non-JSON is null', () => withTempDir(dir => {
  const file = path.join(dir, 'package.json')
  writeFileSync(file, JSON.stringify({ name: 'x' }))
  assert.equal(readPackageVersion(pathToFileURL(file)), null)
  writeFileSync(file, JSON.stringify({ version: 3 }))
  assert.equal(readPackageVersion(pathToFileURL(file)), null)
  writeFileSync(file, 'not json {')
  assert.equal(readPackageVersion(pathToFileURL(file)), null)
}))

test('VERSION is the version of the repository package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version)
})

test('USER_AGENT names the tool and the version', () => {
  assert.match(USER_AGENT, /^poe-price-tool\/\S+ \(release check\)$/)
})

test('AGENT_BASE is the tool name and the version of the repository package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(AGENT_BASE, `poe-price-tool/${pkg.version}`)
})

test('a version that cannot be read makes the agent say unknown, never a guess', () => {
  assert.equal(agentBase(null), 'poe-price-tool/unknown')
  assert.equal(agentBase('1.2.3'), 'poe-price-tool/1.2.3')
  assert.equal(AGENT_BASE, agentBase(VERSION))
})

test('USER_AGENT is AGENT_BASE with the purpose of the release check', () => {
  assert.equal(USER_AGENT, `${AGENT_BASE} (release check)`)
})
