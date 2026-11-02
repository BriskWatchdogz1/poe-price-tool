// Which client language a user plays in — the part of it the USER decides,
// persisted in the /config volume.
//
// `user-langs.mjs` next door parses `POE_USER_LANGS`. That is an environment
// variable, so every change to it needs somebody with shell access plus a
// container restart. For the one setting whose owner is obviously the player
// himself, that is the wrong shape: he is looking at a settings page that
// already lets him store his own POESESSID, and the language he plays in is not
// more privileged than that.
//
// THE FILE BEATS THE ENVIRONMENT. `POE_USER_LANGS` keeps working, but only as
// the STARTING value for a user who has never chosen anything. Once an entry
// exists in this store, that entry wins.
//
//   Why round that way: if the environment won, the operator would silently
//   overwrite the user's own choice on the next deploy — a setting that
//   quietly reverts is worse than one that never existed, because the user
//   changes it, sees it work, and finds it back on the old value a week later
//   with nothing to blame. The env is the seed; the store is the answer.
//
// VALIDATION IS PER ENTRY, NEVER PER PROCESS. `POE_USER_LANGS` is a hard
// startup error for a good reason (a typo there means items get parsed by the
// wrong parser). This file is different: it is written by the running tool, it
// can survive a change to POE_USERS or to the set of installed language data,
// and a stale entry in it must not stop the server from coming up. So a bad
// entry is DROPPED with a warning naming the user, the value and the reason,
// and that user falls back to the env/default value. Broken JSON does not stop
// the start either: the file is moved to `<name>.broken` and the server starts
// without it.
//
// Shape (/config/user-langs.json):
//   { "player1": "en", "player2": "de" }

import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { jsonErrorSummary } from './json-error.mjs'

export const USER_LANG_STORE_DEFAULT = '/config/user-langs.json'

let tmpCounter = 0

/**
 * createUserLangStore({ path, log })
 *
 *   load({ users, supported })  -> Map<user, lang> of the entries that SURVIVED
 *                                  validation. Unknown users and unsupported
 *                                  languages are dropped (warned), broken JSON
 *                                  moves the file aside.
 *   prune({ isLive })           -> second pass, once the engine instances exist:
 *                                  drop every entry whose language has no live
 *                                  parser. Returns the dropped user names.
 *   entries()                   -> Map<user, lang> currently held
 *   set(user, lang)             -> persist one entry (atomic tmp+rename)
 *   writable                    -> false when /config is not writable (local
 *                                  run): the store then keeps working in
 *                                  memory and says so, instead of throwing on
 *                                  every save. Identical to the net-worth store.
 */
export function createUserLangStore ({
  path = process.env.POE_USER_LANG_STORE || USER_LANG_STORE_DEFAULT,
  log = console
} = {}) {
  const held = new Map()
  const store = {
    path,
    writable: true,

    async load ({ users = [], supported = [] } = {}) {
      held.clear()
      // Same guard the net-worth store gets in server.mjs: a local run without
      // a /config volume means "persistence off", not "the feature is broken".
      // The switch then works for the lifetime of the process and says so
      // (`persisted: false` on the endpoint) instead of throwing on save.
      try {
        await mkdir(dirname(path), { recursive: true })
      } catch (e) {
        store.writable = false
        log.warn?.(`[user-langs] ${dirname(path)} is not writable (${e.code || e.message}) — a language chosen in the browser applies immediately but will not survive a restart`)
      }
      let raw
      try {
        raw = await readFile(path, 'utf8')
      } catch (e) {
        if (e.code !== 'ENOENT') {
          log.warn?.(`[user-langs] could not read ${path} (${e.code || e.message}) — starting from POE_USER_LANGS only`)
        }
        return new Map(held)
      }
      let parsed
      try {
        parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
      } catch (e) {
        // Never a hard stop: this store is a convenience, and a corrupt file
        // must not keep the tool down. Moved aside so the next save starts
        // clean AND the old content is still there to look at.
        //
        // The parser's message is SUMMARISED, not quoted: V8 puts an excerpt of
        // the file into it, and this file sits in the same /config directory as
        // the session cookies. Nothing published or logged from here repeats
        // the content of a file it failed to read (json-error.mjs).
        const broken = `${path}.broken`
        const why = jsonErrorSummary(e)
        try {
          await rename(path, broken)
          log.warn?.(`[user-langs] ${path} is not usable (${why}) — moved to ${broken}, starting from POE_USER_LANGS only`)
        } catch (e2) {
          log.warn?.(`[user-langs] ${path} is not usable (${why}) and could not be moved aside (${e2.code || e2.message}) — ignoring it`)
        }
        return new Map(held)
      }

      const userSet = new Set(users)
      for (const [user, lang] of Object.entries(parsed)) {
        if (!userSet.has(user)) {
          log.warn?.(`[user-langs] dropping stored language "${lang}" for "${user}": not in POE_USERS (${users.join(', ')})`)
          continue
        }
        if (typeof lang !== 'string' || !supported.includes(lang)) {
          log.warn?.(`[user-langs] dropping stored language "${lang}" for "${user}": not a supported language (${supported.join(', ')}) — falling back to the configured value`)
          continue
        }
        held.set(user, lang)
      }
      return new Map(held)
    },

    prune ({ isLive } = {}) {
      const dropped = []
      for (const [user, lang] of [...held]) {
        if (!isLive(lang)) {
          log.warn?.(`[user-langs] dropping stored language "${lang}" for "${user}": no parser is loaded for it — falling back to the configured value`)
          held.delete(user)
          dropped.push(user)
        }
      }
      return dropped
    },

    entries () { return new Map(held) },

    async set (user, lang) {
      const next = new Map(held)
      next.set(user, lang)
      if (store.writable) {
        const values = Object.fromEntries([...next].sort(([a], [b]) => a.localeCompare(b)))
        const tmpPath = `${path}.${process.pid}.${++tmpCounter}.tmp`
        try {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(tmpPath, JSON.stringify(values, null, 2) + '\n', 'utf8')
          await rename(tmpPath, path)
        } catch (err) {
          await unlink(tmpPath).catch(() => {})
          throw err
        }
      }
      held.set(user, lang)
      return store.writable
    }
  }
  return store
}
