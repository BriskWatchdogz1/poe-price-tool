import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadBaseNames } from './base-names.mjs'

// --- Fixture: small representative slice, mirrors real base-names.json shape
// (metadataId -> name). Written to a temp file so loadBaseNames exercises the
// real readFile+JSON.parse path.
const FIXTURE = {
  'Metadata/Items/Currency/CurrencyRerollRare': 'Chaos Orb',
  'Metadata/Items/Currency/CurrencyModValues': 'Divine Orb',
  'Metadata/Items/Currency/CurrencyEssenceGreed7': 'Deafening Essence of Greed',
  'Metadata/Items/Currency/Mushrune12': 'Golden Oil',
  'Metadata/Items/Scarabs/ScarabBreach1': 'Rusted Breach Scarab',
  'Metadata/Items/DivinationCards/DivinationCardTheDoctor': 'The Doctor',
}

async function withFixture (fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'base-names-test-'))
  const file = path.join(dir, 'base-names.json')
  await writeFile(file, JSON.stringify(FIXTURE))
  try {
    return await fn(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('byId: straight metadataId -> name lookups', async () => {
  await withFixture(async file => {
    const { byId } = await loadBaseNames(file)
    assert.equal(byId.get('Metadata/Items/Currency/CurrencyRerollRare'), 'Chaos Orb')
    assert.equal(byId.get('Metadata/Items/Currency/CurrencyModValues'), 'Divine Orb')
    assert.equal(byId.get('Metadata/Items/Currency/CurrencyEssenceGreed7'), 'Deafening Essence of Greed')
    assert.equal(byId.get('Metadata/Items/Currency/Mushrune12'), 'Golden Oil')
    assert.equal(byId.get('Metadata/Items/Scarabs/ScarabBreach1'), 'Rusted Breach Scarab')
    assert.equal(byId.get('Metadata/Items/DivinationCards/DivinationCardTheDoctor'), 'The Doctor')
  })
})

test('byName reverse map is gone: only byId gets loaded', async () => {
  await withFixture(async file => {
    const result = await loadBaseNames(file)
    assert.ok(result.byId instanceof Map)
    assert.equal(result.byName, undefined)
  })
})
