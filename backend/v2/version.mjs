// The installed version of this tool: the "version" field of the root
// package.json (the runtime image carries it, see Dockerfile). Read once at
// import time. `null` means "could not be read" and is shown as "unknown" —
// a made-up version would be worse than none.
import { readFileSync } from 'node:fs'

// Only x.y.z (optional leading v) counts as a version; a pre-release or any
// other string is "unknown", the same shape the release comparison accepts.
const VERSION_SHAPE = /^v?\d+\.\d+\.\d+$/

export function readPackageVersion (url = new URL('../../package.json', import.meta.url)) {
  try {
    const version = JSON.parse(readFileSync(url, 'utf8'))?.version
    return typeof version === 'string' && VERSION_SHAPE.test(version) ? version : null
  } catch {
    return null
  }
}

export const VERSION = readPackageVersion()

// GitHub rejects requests without a User-Agent.
export const USER_AGENT = `poe-price-tool/${VERSION ?? 'unknown'} (release check)`
