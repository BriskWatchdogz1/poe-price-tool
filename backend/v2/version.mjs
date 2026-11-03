// The installed version of this tool: the "version" field of the root
// package.json (the runtime image carries it, see Dockerfile). Read once at
// import time. `null` means "could not be read" and is shown as "unknown" —
// a made-up version would be worse than none. Also the start of every
// User-Agent the tool sends in its own name (AGENT_BASE below).
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

// The one source of the tool's own User-Agent: name and installed version
// (agentBase(null) says "unknown", see VERSION above).
// Every request that names the tool starts with it and appends its purpose in
// parentheses (ninja.mjs, trade-stats.mjs, data-refresher.mjs,
// lang-data-gen.mjs, networth/faustus.mjs and the two CLIs
// apt-data-update.mjs and base-names-gen.mjs). The trade searches and stash
// reads are the exception: they send a browser-like agent
// (shims/ipc-host.mjs, networth/stash-client.mjs).
export function agentBase (version) {
  return `poe-price-tool/${version ?? 'unknown'}`
}

export const AGENT_BASE = agentBase(VERSION)

// The release check's agent. GitHub rejects requests without a User-Agent.
export const USER_AGENT = `${AGENT_BASE} (release check)`
