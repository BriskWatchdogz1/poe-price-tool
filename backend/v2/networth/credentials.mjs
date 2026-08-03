// backend/v2/networth/credentials.mjs
// Write path for /config/networth-users.json — the UI-settings counterpart to
// config.mjs (the read path). One rule above all others: the stored POESESSID
// is NEVER returned, logged, or echoed into an error message. Errors thrown
// here carry only field names and reasons, never values.
//
// Save semantics:
//   - only the addressed user's entry is touched; every other user in the file
//     is carried over byte-identically (parsed+reserialised, values untouched),
//   - an empty poesessid (after trimming) means "keep the stored one" — it is
//     NOT a delete,
//   - the write is atomic (unique tmp file + rename, like every store in this
//     repo) and the file is chmod 600 (it holds session cookies).
import { readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises'

// Reject values that can only be a paste accident: whitespace anywhere (a
// cookie is one token) or control characters (would corrupt the header the
// stash client builds). Deliberately NO length/charset format check — if GGG
// ever changes the cookie format, the field must not become unusable.
const BAD_CHARS = /[\s\u0000-\u001f\u007f]/

export class CredentialsError extends Error {
  constructor (message, { status = 400 } = {}) {
    super(message)
    this.name = 'CredentialsError'
    this.status = status
  }
}

// Validate + normalise one settings submission. Returns { accountName,
// poesessid } where poesessid === null means "keep the stored value".
// Throws CredentialsError with a value-free message on invalid input.
export function validateCredentialInput ({ accountName, poesessid } = {}) {
  const acc = typeof accountName === 'string' ? accountName.trim() : ''
  if (!acc) throw new CredentialsError('accountName is required')
  // Account names are "Name#1234" — printable, no control chars. Spaces are
  // legal in PoE account names, so only control characters are rejected here.
  if (/[\u0000-\u001f\u007f]/.test(acc)) throw new CredentialsError('accountName contains control characters')

  const sess = typeof poesessid === 'string' ? poesessid.trim() : ''
  if (sess === '') return { accountName: acc, poesessid: null } // empty = unchanged
  if (BAD_CHARS.test(sess)) throw new CredentialsError('POESESSID contains whitespace or control characters')
  return { accountName: acc, poesessid: sess }
}

// Merge one user's credentials into the JSON file and write it atomically with
// mode 600. Other users' entries stay untouched. Throws CredentialsError
// (status 500) with an honest, value-free message when the file cannot be
// read or written.
export async function saveNetworthUser ({ path, user, accountName, poesessid }) {
  if (!path) throw new CredentialsError('no credential file path configured', { status: 500 })
  if (!user) throw new CredentialsError('no user given')

  // Load the existing file. ENOENT -> start fresh; any other failure (EACCES,
  // corrupt JSON) is reported honestly instead of silently clobbering the file.
  let data = {}
  try {
    const raw = await readFile(path, 'utf8')
    try {
      data = JSON.parse(raw)
    } catch {
      throw new CredentialsError('credential file exists but is not valid JSON — fix or remove it on the server', { status: 500 })
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new CredentialsError('credential file has an unexpected shape — fix or remove it on the server', { status: 500 })
    }
  } catch (e) {
    if (e instanceof CredentialsError) throw e
    if (e.code !== 'ENOENT') {
      throw new CredentialsError(`credential file is not readable (${e.code || 'error'})`, { status: 500 })
    }
  }

  const existing = data[user]
  const keptSessid = (existing && typeof existing.poesessid === 'string' && existing.poesessid) ? existing.poesessid : null
  const nextSessid = poesessid ?? keptSessid
  if (!nextSessid) {
    // Empty submit for a user who has nothing stored: there is nothing to keep.
    throw new CredentialsError('POESESSID is required — none is stored for this user yet')
  }

  data[user] = { ...existing, accountName, poesessid: nextSessid }

  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    // mode on writeFile only applies to a NEWLY created tmp file; chmod makes
    // 600 unconditional before the rename swaps it into place.
    await chmod(tmpPath, 0o600)
    await rename(tmpPath, path)
  } catch (e) {
    await unlink(tmpPath).catch(() => {})
    throw new CredentialsError(`credential file is not writable (${e.code || 'error'}) — check the /config volume`, { status: 500 })
  }

  return { changedPoesessid: poesessid != null }
}
