// Which user plays in which client language — configuration, never a guess.
//
// The tool already routes by identity: the daemon sends `X-User` on POST /item,
// the browser carries the cookie `ppt_user`. The language rides on exactly that
// identity, so both transports are covered by one mapping and neither needs a
// new field.
//
// Format (env POE_USER_LANGS), mirroring POE_USERS:
//
//   POE_USER_LANGS=bob:de              # bob plays a German client
//   POE_USER_LANGS=bob:de,alice:en     # spelled out for both
//
// Everything not listed falls back to POE_LANG_DEFAULT (default `en`), so an
// unset variable means "as before, English for everyone" — no behaviour change
// for existing installs.
//
// A typo is a HARD startup error, not a warning. Getting the language wrong
// does not fail loudly by itself: the item text would be handed to the wrong
// parser and come back as an unparsable line or, worse, a plausible but wrong
// item. The same stance the item route already takes for an unknown `X-User`
// (400, never silently routed to the first user).

export const DEFAULT_LANG = 'en'

// Languages the tool can actually parse: a language needs its own
// client_strings.js plus a data/<lang> set in the snapshot. Adding one here
// without those two is a promise the engine cannot keep.
export const SUPPORTED_LANGS = ['en', 'de']

/**
 * parseUserLangs({ spec, users, defaultLang }) -> Map<user, lang>
 *
 * Throws on anything malformed: an entry without `user:lang`, an unknown user,
 * an unsupported language, or a user listed twice.
 */
export function parseUserLangs ({ spec, users = [], defaultLang = DEFAULT_LANG } = {}) {
  if (!SUPPORTED_LANGS.includes(defaultLang)) {
    throw new Error(`POE_LANG_DEFAULT: unsupported language "${defaultLang}" (supported: ${SUPPORTED_LANGS.join(', ')})`)
  }
  const byUser = new Map(users.map(u => [u, defaultLang]))
  const seen = new Set()

  for (const raw of String(spec || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const idx = raw.indexOf(':')
    if (idx <= 0 || idx === raw.length - 1) {
      throw new Error(`POE_USER_LANGS: "${raw}" is not a "user:lang" pair (example: POE_USER_LANGS=${users[0] || 'player1'}:de)`)
    }
    const user = raw.slice(0, idx).trim()
    const lang = raw.slice(idx + 1).trim()
    if (!byUser.has(user)) {
      throw new Error(`POE_USER_LANGS: unknown user "${user}" — valid users (POE_USERS): ${users.join(', ')}`)
    }
    if (!SUPPORTED_LANGS.includes(lang)) {
      throw new Error(`POE_USER_LANGS: unsupported language "${lang}" for user "${user}" (supported: ${SUPPORTED_LANGS.join(', ')})`)
    }
    if (seen.has(user)) {
      throw new Error(`POE_USER_LANGS: user "${user}" is listed twice`)
    }
    seen.add(user)
    byUser.set(user, lang)
  }
  return byUser
}

/** The distinct languages a user list needs, primary language first. */
export function languagesOf (byUser, defaultLang = DEFAULT_LANG) {
  return [...new Set([defaultLang, ...byUser.values()])]
}

/**
 * configuredLanguages(env) -> the languages this INSTALLATION has to serve.
 *
 * Same configuration, read where the user list itself is irrelevant and only
 * the set of languages matters: the data refresher has to make sure a data set
 * exists for every language somebody plays in, but it does not care who that
 * somebody is. Reading it here rather than being handed it keeps the refresher
 * usable without a change in server.mjs — the server may still pass an explicit
 * list, which then wins.
 *
 * Deliberately tolerant: a malformed POE_USER_LANGS has already ended the
 * startup in parseUserLangs() long before anything calls this, so re-reporting
 * it here would only add a second, worse error message.
 */
export function configuredLanguages (env = process.env) {
  const langs = new Set()
  const fallback = env.POE_LANG_DEFAULT || DEFAULT_LANG
  if (SUPPORTED_LANGS.includes(fallback)) langs.add(fallback)
  for (const raw of String(env.POE_USER_LANGS || '').split(',')) {
    const lang = raw.split(':')[1]?.trim()
    if (lang && SUPPORTED_LANGS.includes(lang)) langs.add(lang)
  }
  return [...langs]
}
