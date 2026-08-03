// Runtime generator for the APT search index files (*.index.bin) — the
// English snapshot only, which is the only language the backend loads
// (engine.mts: ready({ lang: 'en' })).
//
// Why this exists next to renderer/src/assets/make-index-files.mjs: that
// upstream script needs renderer/node_modules (@sindresorhus/fnv1a), iterates
// ALL four language dirs and resolves its paths relative to cwd — none of
// which holds inside the runtime container (renderer/node_modules is not in
// the image, only data/en matters, cwd is /app). The background data
// refresher (data-refresher.mjs) has to regenerate the indices after every
// adopted snapshot, because assets/data reads the ndjson THROUGH these
// offset tables — stale indices would pair new data with old line offsets.
//
// The binary format and ordering mirror make-index-files.mjs exactly:
// Uint32Array rows of [fnv1a32(key), byteOffsetOfLine], sorted ascending by
// hash (stable sort, so hash collisions keep insertion order like upstream).
// apt-index.test.mjs byte-compares this generator's output against the bins
// produced by the upstream script to guard against drift.

const encoder = new TextEncoder()

// FNV-1a, 32 bit, over the UTF-8 bytes — identical to
// @sindresorhus/fnv1a's fnv1a(value, { size: 32 }) (BigInt there, uint32
// arithmetic here; Math.imul + >>>0 is the same mod-2^32 multiply).
export function fnv1a32 (str) {
  const bytes = encoder.encode(str)
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

function toSortedBin (rows) {
  rows.sort((a, b) => a.hash - b.hash)
  const out = new Uint32Array(rows.length * 2)
  for (let i = 0; i < rows.length; i++) {
    out[i * 2 + 0] = rows[i].hash
    out[i * 2 + 1] = rows[i].start
  }
  return out
}

/**
 * Builds all four index buffers from the raw ndjson TEXT (not parsed rows —
 * the offsets are byte offsets into exactly this text, which assets/data
 * later slices at). IMPORTANT (upstream parity): offsets are computed on the
 * string the same way upstream does (String.prototype.indexOf), i.e. they are
 * UTF-16 code-unit offsets — assets/data reads the file back as a JS string
 * and slices with the same semantics, so this is correct as long as both
 * sides agree (they do; do not "fix" this to byte offsets).
 *
 * Returns { 'stats-ref.index.bin': Uint32Array, 'stats-matcher.index.bin': …,
 *           'items-name.index.bin': …, 'items-ref.index.bin': … }.
 */
export function buildIndexBins ({ itemsNdjson, statsNdjson }) {
  const statsByRef = []
  const matchers = []
  {
    let start = 0
    while (start !== statsNdjson.length) {
      const end = statsNdjson.indexOf('\n', start)
      const statOrGroup = JSON.parse(statsNdjson.slice(start, end))
      const stats = ('stats' in statOrGroup) ? statOrGroup.stats : [statOrGroup]
      for (const stat of stats) {
        statsByRef.push({ start, hash: fnv1a32(stat.ref) })
        for (const matcher of stat.matchers) {
          matchers.push({ start, hash: fnv1a32(matcher.advanced ?? matcher.string) })
        }
      }
      start = end + 1
    }
  }

  const items = []
  {
    let start = 0
    const seen = new Set()
    while (start !== itemsNdjson.length) {
      const end = itemsNdjson.indexOf('\n', start)
      const item = JSON.parse(itemsNdjson.slice(start, end))
      const key = `${item.namespace}::${item.refName}`
      if (!seen.has(key)) {
        seen.add(key)
        items.push({
          hashName: fnv1a32(`${item.namespace}::${item.name}`),
          hashRefName: fnv1a32(`${item.namespace}::${item.refName}`),
          start
        })
      }
      start = end + 1
    }
  }

  return {
    'stats-ref.index.bin': toSortedBin(statsByRef),
    'stats-matcher.index.bin': toSortedBin(matchers),
    'items-name.index.bin': toSortedBin(items.map(r => ({ hash: r.hashName, start: r.start }))),
    'items-ref.index.bin': toSortedBin(items.map(r => ({ hash: r.hashRefName, start: r.start })))
  }
}
