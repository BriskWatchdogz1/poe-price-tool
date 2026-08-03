// backend/v2/networth/config.mjs
// Per-user credentials for the net-worth scan: accountName + POESESSID.
// Source 1: JSON file in the /config volume (default /config/networth-users.json,
//           redirectable locally via POE_NETWORTH_CONFIG; config/ is gitignored).
// Source 2: env POE_SESSID + POE_NETWORTH_ACCOUNT (+ optional POE_NETWORTH_USER,
//           else defaultUser = USERS[0]) — overrides the file for THIS user.
// The values are NEVER logged and never show up in an error message.
import { readFile } from 'node:fs/promises'

export const NETWORTH_CONFIG_DEFAULT = '/config/networth-users.json'

export async function loadNetworthUsers ({
  path = process.env.POE_NETWORTH_CONFIG || NETWORTH_CONFIG_DEFAULT,
  env = process.env,
  defaultUser = null
} = {}) {
  const out = {}
  let raw = null
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    if (e.code !== 'ENOENT') throw e // file exists but unreadable (permissions) -> throw honestly
  }
  if (raw != null) {
    const parsed = JSON.parse(raw) // SyntaxError deliberately propagates
    for (const [user, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.accountName === 'string' && entry.accountName &&
          typeof entry.poesessid === 'string' && entry.poesessid) {
        out[user] = { accountName: entry.accountName, poesessid: entry.poesessid }
      }
    }
  }
  if (env.POE_SESSID && env.POE_NETWORTH_ACCOUNT) {
    const user = env.POE_NETWORTH_USER || defaultUser
    if (user) out[user] = { accountName: env.POE_NETWORTH_ACCOUNT, poesessid: env.POE_SESSID }
  }
  return out
}
