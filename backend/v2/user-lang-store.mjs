// Which client language a user plays in — the part of it the USER decides,
// persisted in the /config volume. `user-langs.mjs` next door parses
// `POE_USER_LANGS`, an environment variable: every change needs shell access
// plus a container restart, the wrong shape for a setting the player owns (the
// same settings page already stores his own POESESSID).
//
// THE FILE BEATS THE ENVIRONMENT. `POE_USER_LANGS` is only the STARTING value
// for a user who has never chosen anything; once an entry exists in this store,
// that entry wins. Otherwise the next deploy would silently revert the user's
// own choice. The env is the seed; the store is the answer.
//
// VALIDATION IS PER ENTRY, NEVER PER PROCESS. `POE_USER_LANGS` is a hard
// startup error (a typo there means items get parsed by the wrong parser). This
// file is written by the running tool and can outlive a change to POE_USERS or
// to the supported languages, so an entry the server cannot honour is taken out
// of force with a warning naming the user, the value and the reason, and that
// user falls back to the env/default value. Broken JSON does not stop the start
// either: the file is moved to `<name>.broken-<timestamp>` (store-file.mjs).
//
// ONLY AN UNSUPPORTED LANGUAGE IS DROPPED: the next set() writes the file
// without it; final by design. Every other entry the server cannot honour
// stays:
//   - A user who is not in POE_USERS is RETAINED (docs/bugs.md B33). Never in
//     force in this process (POE_USERS only changes with a restart); it comes
//     back at the next start with that user in the list (load()), never
//     through unpark().
//   - A supported language whose parser did not come up is PARKED (B32): out of
//     force for now (the user is on his configured value, not on a parser that
//     would answer 503). It comes back at the next start with that parser live
//     (load() reads it, park() keeps it in force), or without a restart when a
//     data update brings the missing data set: engine-instances.mjs reload()
//     retries every instance that is down, and server.mjs (applyAptData, the
//     onAptData handler) then calls unpark(). Every stored language has an
//     instance to retry: the server builds its parser set from the stored
//     choices as well (CONFIGURED_LANGS, BOOT_LANGS).
// set() writes retained and parked entries back with every save, so another
// user's choice cannot erase them. A parked user who chooses again overwrites
// the parked entry; a retained user cannot choose (the server knows only the
// users in POE_USERS).
//
// Shape (/config/user-langs.json):
//   { "player1": "en", "player2": "de" }

import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { jsonErrorSummary } from './json-error.mjs'
import { moveAside } from './store-file.mjs'

export const USER_LANG_STORE_DEFAULT = '/config/user-langs.json'

let tmpCounter = 0

/**
 * createUserLangStore({ path, log, renameImpl, readFileImpl })
 *
 *   load({ users, supported })  -> Map<user, lang> of the entries that SURVIVED
 *                                  validation. Unsupported languages are
 *                                  dropped, entries of users not in `users`
 *                                  are retained for the file (both warned),
 *                                  broken JSON moves the file aside.
 *   park({ isLive })            -> second pass, once the engine instances exist:
 *                                  take every entry whose language has no live
 *                                  parser out of force, but keep it for the
 *                                  file (warned). Returns the parked user names.
 *   unpark({ isLive })          -> put every parked entry whose parser is live
 *                                  now back in force. Returns Map<user, lang>
 *                                  of the entries brought back. Writes nothing:
 *                                  the file still holds them.
 *   entries()                   -> Map<user, lang> in force
 *   parked()                    -> Map<user, lang> parked
 *   retained()                  -> Map<user, lang> of users not in `users`,
 *                                  kept for the file only
 *   set(user, lang)             -> persist one entry (atomic tmp+rename),
 *                                  together with every parked and retained
 *                                  one; replaces an entry of the same user
 *   writable                    -> false when /config is not writable (local
 *                                  run): the store then keeps working in
 *                                  memory and says so, instead of throwing on
 *                                  every save. Identical to the net-worth store.
 *                                  Also false when the file exists but could
 *                                  not be read, or is broken and could not be
 *                                  moved aside: set() must not replace a file
 *                                  whose other entries it never saw.
 */
export function createUserLangStore ({
  path = process.env.POE_USER_LANG_STORE || USER_LANG_STORE_DEFAULT,
  log = console,
  // Test seams only: how the broken file is moved aside (store-file.mjs), and
  // how the file is read (a permission error without needing chmod or root).
  renameImpl = rename,
  readFileImpl = readFile
} = {}) {
  const held = new Map()
  const parkedEntries = new Map()
  // Users not in POE_USERS (B33): written back, never in force.
  const retainedEntries = new Map()
  const store = {
    path,
    writable: true,

    async load ({ users = [], supported = [] } = {}) {
      held.clear()
      parkedEntries.clear()
      retainedEntries.clear()
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
        raw = await readFileImpl(path, 'utf8')
      } catch (e) {
        // No file yet is the normal first start. Any other error means a file
        // is there whose entries this process never saw (EACCES, EISDIR, EIO):
        // writing the next choice over it would drop every other user's
        // language without a word. So the store stops writing, as it does for a
        // broken file that cannot be moved aside.
        if (e.code !== 'ENOENT') {
          store.writable = false
          log.warn?.(`[user-langs] could not read ${path} (${e.code || e.message}) — starting from POE_USER_LANGS only and not writing over it; fix or remove it and restart`)
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
        //
        // A timestamped name, so a second broken file never replaces the first.
        // A file that cannot be moved is left alone AND the store stops writing:
        // otherwise the next set() would replace it, which is the silent loss
        // this branch exists to prevent.
        const why = jsonErrorSummary(e)
        try {
          const broken = await moveAside(path, { label: 'broken', renameImpl })
          log.warn?.(`[user-langs] ${path} is not usable (${why}) — moved to ${broken}, starting from POE_USER_LANGS only`)
        } catch (e2) {
          store.writable = false
          log.warn?.(`[user-langs] ${path} is not usable (${why}) and could not be moved aside (${e2.code || e2.message}) — starting from POE_USER_LANGS only and not writing over it; fix or remove it and restart`)
        }
        return new Map(held)
      }

      const userSet = new Set(users)
      for (const [user, lang] of Object.entries(parsed)) {
        // The language first: an unsupported one is dropped whoever it
        // belongs to, since no start of this release can honour it.
        if (typeof lang !== 'string' || !supported.includes(lang)) {
          log.warn?.(`[user-langs] dropping stored language "${lang}" for "${user}": not a supported language (${supported.join(', ')}) — falling back to the configured value`)
          continue
        }
        if (!userSet.has(user)) {
          log.warn?.(`[user-langs] keeping stored language "${lang}" for "${user}" out of force: not in POE_USERS (${users.join(', ')}) — the choice stays in ${path} and applies again at a start with "${user}" back in POE_USERS`)
          retainedEntries.set(user, lang)
          continue
        }
        held.set(user, lang)
      }
      return new Map(held)
    },

    park ({ isLive } = {}) {
      const parked = []
      for (const [user, lang] of [...held]) {
        if (!isLive(lang)) {
          log.warn?.(`[user-langs] parking stored language "${lang}" for "${user}": no parser is loaded for it — using the configured value for now; the choice stays in ${path} and applies again once a "${lang}" parser is live (a data update that brings its data set, or a restart)`)
          held.delete(user)
          parkedEntries.set(user, lang)
          parked.push(user)
        }
      }
      return parked
    },

    unpark ({ isLive } = {}) {
      const back = new Map()
      for (const [user, lang] of [...parkedEntries]) {
        if (isLive(lang)) {
          log.log?.(`[user-langs] a "${lang}" parser is live now — "${user}" is back on his stored choice`)
          parkedEntries.delete(user)
          held.set(user, lang)
          back.set(user, lang)
        }
      }
      return back
    },

    entries () { return new Map(held) },

    parked () { return new Map(parkedEntries) },

    retained () { return new Map(retainedEntries) },

    async set (user, lang) {
      // Parked and retained entries are written back: they are a choice that
      // waits for its parser or for its user, not one that was taken back. The
      // user's own new value replaces his parked or retained one.
      const next = new Map([...retainedEntries, ...parkedEntries, ...held])
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
      parkedEntries.delete(user)
      retainedEntries.delete(user)
      held.set(user, lang)
      return store.writable
    }
  }
  return store
}
