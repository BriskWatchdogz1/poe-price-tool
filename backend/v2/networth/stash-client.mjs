// backend/v2/networth/stash-client.mjs
// Legacy stash API (POESESSID path): character-window/get-stash-items.
//   ?...&tabs=1                -> tab list ({ numTabs, tabs:[{ n, i, type }] })
//   ?...&tabIndex=N&tabs=0     -> items of one tab ({ items:[...] })
// Rate-limit discipline: GGG communicates limits ONLY via response headers
// (X-Rate-Limit-Rules / X-Rate-Limit-<Rule> "hits:window:ban" /
//  X-Rate-Limit-<Rule>-State / Retry-After on 429). Therefore: strictly
// sequential, parse the headers after EVERY response and derive the pause
// before the next request from them. Repeated 4xx (invalid-request threshold)
// -> abort instead of hammering away. The cookie value never appears in any message.

const STASH_BASE = 'https://www.pathofexile.com/character-window/get-stash-items'
// Browser-like UA — Cloudflare blocks generic agents (precedent:
// BROWSER_UA in server.mjs / userAgent in backend/config.js).
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36'

const CONSECUTIVE_TAB_FAIL_LIMIT = 3

// Newer stash endpoint of the website (same cookie session, no OAuth). Only it
// knows the sub-folders of the folder tabs:
//   GET /api/stash/<league>/<tabId>            -> { stash: { children:[{id,…}] } }
//   GET /api/stash/<league>/<tabId>/<childId>  -> { stash: { items:[…] } }
// Without an ID (/api/stash/<league>) it answers 403 — the tab LIST still
// comes from the old endpoint.
const STASH_V2_BASE = 'https://www.pathofexile.com/api/stash'

// Tab types whose items live exclusively in sub-folders. The old endpoint
// always returns an empty items array for them (measured, not assumed:
// subIndex=0/1 and tabs=1 return a byte-identical items=0, and the tab ID gets
// answered with a 404).
const CHILDED_TAB_TYPES = new Set(['UniqueStash', 'MapStash'])

export function parseRateLimitHeaders (headers) {
  const get = k => (typeof headers?.get === 'function' ? headers.get(k) : headers?.[k]) ?? null
  const rules = []
  const states = []
  const ruleNames = String(get('x-rate-limit-rules') || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const parseTriples = (raw, rule, into) => {
    for (const part of String(raw || '').split(',').map(s => s.trim()).filter(Boolean)) {
      const [hits, windowSec, banSec] = part.split(':').map(Number)
      into.push({ rule, hits, windowSec, banSec })
    }
  }
  for (const rule of ruleNames) {
    parseTriples(get(`x-rate-limit-${rule.toLowerCase()}`), rule, rules)
    parseTriples(get(`x-rate-limit-${rule.toLowerCase()}-state`), rule, states)
  }
  const ra = get('retry-after')
  return { rules, states, retryAfterSec: ra != null && ra !== '' ? Number(ra) : null }
}

// Pause before the next request. Deterministic (unit-testable):
//  - Retry-After set (429)                     -> (N+1)s
//  - any state counter >= limit-1              -> wait out the whole window
//  - any state counter >= 80% of the limit      -> 4x baseMs (slow down noticeably)
//  - otherwise baseMs (base pace, keeps a ~150-tab scan within a few minutes)
export function delayFor (parsed, { baseMs = 1500 } = {}) {
  if (parsed.retryAfterSec != null) return (parsed.retryAfterSec + 1) * 1000
  let delay = baseMs
  for (const st of parsed.states) {
    const rule = parsed.rules.find(r => r.rule === st.rule && r.windowSec === st.windowSec)
    if (!rule || !(rule.hits > 0)) continue
    if (st.hits >= rule.hits - 1) delay = Math.max(delay, st.windowSec * 1000)
    else if (st.hits >= rule.hits * 0.8) delay = Math.max(delay, baseMs * 4)
  }
  return delay
}

export function createStashClient ({
  accountName, poesessid, league, realm = 'pc',
  fetchImpl = fetch, baseDelayMs = 1500, maxRetries = 5, onProgress = () => {},
  requestTimeoutMs = Number(process.env.POE_STASH_TIMEOUT_MS) || 30000
}) {
  if (!accountName || !poesessid) throw new Error('accountName and poesessid are required')
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  let nextDelayMs = 0     // derived from the headers of the LAST response

  function fail (message, kind) {
    const e = new Error(message)
    e.kind = kind
    return e
  }

  // Short, sanitized snippet of an error response body — enough to tell a
  // Cloudflare block ("Just a moment" / "cloudflare") apart from a GGG JSON
  // error. Never contains request headers or the cookie. Best-effort.
  async function bodyHint (r) {
    try {
      const t = (await r.text()) || ''
      if (/cloudflare|just a moment|attention required|cf-ray/i.test(t)) return ' — looks like a Cloudflare block'
      const s = t.replace(/\s+/g, ' ').trim().slice(0, 140)
      return s ? ` — body: ${s}` : ''
    } catch { return '' }
  }

  const MAX_DELAY_MS = 90_000      // never sleep longer than this before a request
  const TIMEOUT_MAX_RETRIES = 2    // stalled/network request -> give up fast (~90s) and skip the tab

  // HARD timeout: AbortController alone does NOT reliably tear down a stalled
  // undici socket (a huge remove-only tab whose body trickles/dies keeps the
  // await pending indefinitely). So race every await against a timeout that
  // ALWAYS rejects -> the scan proceeds even when the abort is ignored. The
  // loser promise's late rejection is swallowed to avoid an unhandled rejection.
  function withTimeout (p, ms, ac) {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { ac.abort() } catch { /* best effort */ }
        reject(Object.assign(new Error(`request timed out after ${ms}ms`), { name: 'TimeoutError' }))
      }, ms)
    })
    p.catch(() => {}) // if the timeout wins, swallow p's later rejection
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
  }

  async function request (params) {
    return requestUrl(`${STASH_BASE}?accountName=${encodeURIComponent(accountName)}` +
      `&realm=${encodeURIComponent(realm)}&league=${encodeURIComponent(league)}&${params}`)
  }

  async function requestUrl (url) {
    for (let attempt = 0; ; attempt++) {
      if (nextDelayMs > 0) await sleep(Math.min(nextDelayMs, MAX_DELAY_MS))
      const ac = new AbortController()
      try {
        const r = await withTimeout(fetchImpl(url, {
          headers: { Cookie: `POESESSID=${poesessid}`, 'User-Agent': BROWSER_UA, Accept: 'application/json' },
          signal: ac.signal
        }), requestTimeoutMs, ac)
        nextDelayMs = delayFor(parseRateLimitHeaders(r.headers), { baseMs: baseDelayMs })
        if (r.status === 429) {
          if (attempt >= maxRetries) throw fail('Rate-limited: retries exhausted, scan aborted', 'ratelimit')
          continue
        }
        if (r.status === 401) {
          // Cookie value deliberately NOT in the message.
          throw fail('POESESSID invalid or expired (HTTP 401) — renew the cookie in networth-users.json', 'auth')
        }
        if (r.status === 403) {
          // 403 = authenticated but forbidden. Usually a wrong accountName (you
          // can only read your OWN stash — try the full name#1234 form) or a
          // Cloudflare block. The body hint tells them apart.
          throw fail(`HTTP 403 (forbidden) — check accountName (must match your account; try the full name#1234 form)${await bodyHint(r)}`, 'auth')
        }
        if (!r.ok) {
          // Other 4xx (400/404/422/…) won't change on retry -> give up
          // immediately instead of hammering GGG. 5xx may be transient -> retry.
          if (r.status < 500) {
            throw fail(`Stash request rejected: HTTP ${r.status}${await bodyHint(r)}`, 'rejected')
          }
          if (attempt >= maxRetries) throw fail(`Stash request failed: HTTP ${r.status}`, 'server')
          continue
        }
        return await withTimeout(r.json(), requestTimeoutMs, ac)
      } catch (e) {
        // Typed fail() errors (auth/ratelimit/rejected/server) are deliberate
        // decisions -> propagate. Timeout/network (no kind) -> transient, but
        // give up FAST so ONE stalled tab skips in ~90s instead of freezing the
        // whole scan (fetchAllTabs then skips this tab).
        if (e?.kind) throw e
        if (attempt >= TIMEOUT_MAX_RETRIES) throw fail(`Stash request failed (network/timeout after ${requestTimeoutMs}ms): ${e?.name || e}`, 'server')
        continue
      }
    }
  }

  // One folder tab: fetch the child list, then every child individually. Goes
  // through the same requestUrl() as everything else, so it inherits header
  // parsing, backoff and timeout. One pass costs 1 + N requests (unique tab:
  // 18) — acceptable, since a tab's turn only comes around every few minutes.
  async function fetchChildedTab (tab) {
    const base = `${STASH_V2_BASE}/${encodeURIComponent(league)}`
    const parent = await requestUrl(`${base}/${encodeURIComponent(tab.id)}`)
    const children = Array.isArray(parent?.stash?.children) ? parent.stash.children : []
    const out = Array.isArray(parent?.stash?.items) ? [...parent.stash.items] : []
    for (const child of children) {
      if (!child?.id) continue
      const j = await requestUrl(`${base}/${encodeURIComponent(tab.id)}/${encodeURIComponent(child.id)}`)
      const items = j?.stash?.items
      if (Array.isArray(items)) out.push(...items)
    }
    if (process.env.POE_NETWORTH_DEBUG === '1') {
      console.log(`[stash-client] folder tab "${tab.name}": ${children.length} sub-tabs, ${out.length} items`)
    }
    return out
  }

  return {
    async listTabs () {
      const j = await request('tabs=1&tabIndex=0')
      const tabs = Array.isArray(j?.tabs) ? j.tabs : []
      if (process.env.POE_NETWORTH_DEBUG === '1') {
        // Index + type only (no tab contents): the type decides whether a tab
        // can return any items over this endpoint at all.
        console.log('[stash-client] tab types: ' +
          tabs.map(t => `${t.i}:${t.type ?? '(no type field)'}`).join(' '))
        // Field names of the tab entries (union, no values): if a tab carries
        // children/subtabs/parent, there is a level below the tab level that
        // we have not been querying at all so far.
        const keys = new Set()
        for (const t of tabs) for (const k of Object.keys(t || {})) keys.add(k)
        console.log(`[stash-client] tab entry fields: ${[...keys].join(',')} (top-level response keys: ${Object.keys(j || {}).join(',')})`)
      }
      // `id` is needed for folder tabs (only the NEWER endpoint knows them).
      return tabs.map(t => ({ index: t.i, name: t.n, type: t.type, id: t.id ?? null }))
    },
    /**
     * Items of one tab. `tab` (the entry from listTabs) is optional and only
     * needed for FOLDER tabs: UniqueStash and MapStash always return an empty
     * items array over the old endpoint — their items sit in sub-folders that
     * do not exist there at all (proven: subIndex is ignored, and it does not
     * know the tab ID). Those go through the newer endpoint of the website,
     * two levels deep, strictly sequential.
     */
    async fetchTab (tabIndex, tab = null) {
      if (tab?.id && CHILDED_TAB_TYPES.has(tab.type)) {
        try {
          return await fetchChildedTab(tab)
        } catch (e) {
          // The newer endpoint is undocumented and can change. auth/ratelimit
          // must propagate (cookie/ban protection), everything else degrades
          // to "tab empty" instead of tearing down the scan.
          if (e?.kind === 'auth' || e?.kind === 'ratelimit') throw e
          console.warn(`[stash-client] folder tab "${tab.name}" not readable (${e?.message || e})`)
          return []
        }
      }
      const j = await request(`tabIndex=${tabIndex}&tabs=0`)
      const items = Array.isArray(j?.items) ? j.items : []
      // Diagnostics (POE_NETWORTH_DEBUG=1): when a tab came back empty, the
      // TOP-LEVEL KEYS of the response show whether GGG puts the items
      // somewhere else (folder tabs) or really returns nothing. Key names and
      // numbers only — no item data, no cookie.
      if (process.env.POE_NETWORTH_DEBUG === '1' && items.length === 0) {
        // For every non-items key: type, entry count and the keys of the FIRST
        // entry. That is enough to tell whether it holds nothing but slot
        // positions (x/y/w/h) or actual items.
        const shape = Object.entries(j || {}).filter(([k]) => k !== 'items').map(([k, v]) => {
          if (v == null || typeof v !== 'object') return `${k}=${typeof v}`
          const keys = Object.keys(v)
          const first = keys.length ? v[keys[0]] : null
          const firstKeys = first && typeof first === 'object' ? Object.keys(first).join('/') : typeof first
          return `${k}[${keys.length}]{${firstKeys}}`
        })
        console.log(`[stash-client] tab ${tabIndex} came back with 0 items — ${shape.join(' ') || '(nothing besides items)'}`)
      }
      return items
    },
    // One-shot experiment (POE_STASH_PROBE=<index>, see server.mjs): folder
    // tabs (UniqueStash/MapStash) return an EMPTY items array and an empty
    // layout over `tabIndex=N&tabs=0` — yet in game there is a level below
    // them (a sub-folder per tier or item class). This probe walks the
    // plausible addressing schemes one after another and logs nothing but
    // response keys and item COUNT per variant. Strictly sequential over the
    // same request() (rate-limit header discipline applies), one pass per
    // start and never again. No item data, no cookie in the log.
    async probeTab (tabIndex) {
      const list = await request('tabs=1&tabIndex=0')
      const entry = (Array.isArray(list?.tabs) ? list.tabs : []).find(t => t.i === tabIndex)
      const id = entry?.id ?? null
      console.log(`[stash-probe] tab ${tabIndex} type=${entry?.type ?? '?'} id=${id ? 'present' : 'absent'}`)
      const variants = [
        ['baseline', `tabIndex=${tabIndex}&tabs=0`],
        ['subIndex=0', `tabIndex=${tabIndex}&tabs=0&subIndex=0`],
        ['subIndex=1', `tabIndex=${tabIndex}&tabs=0&subIndex=1`],
        ['tabs=1', `tabIndex=${tabIndex}&tabs=1`],
        ...(id ? [['tabId', `tabId=${encodeURIComponent(id)}&tabs=0`]] : []),
        ...(id ? [['tabIndex=id', `tabIndex=${encodeURIComponent(id)}&tabs=0`]] : [])
      ]
      for (const [label, params] of variants) {
        try {
          const j = await request(params)
          const n = Array.isArray(j?.items) ? j.items.length : -1
          console.log(`[stash-probe] ${label}: items=${n} keys=${Object.keys(j || {}).join(',')}`)
        } catch (e) {
          console.log(`[stash-probe] ${label}: ${e?.kind || 'error'} — ${e?.message || e}`)
        }
      }
      // Round two: the NEWER stash endpoint of the website (same cookie
      // session, no OAuth). If it returns `children` for folder tabs, that is
      // the way to the sub-folders. Again keys + counts only in the log.
      const alt = [
        ['api/stash/<league>', `https://www.pathofexile.com/api/stash/${encodeURIComponent(league)}`],
        ...(id ? [['api/stash/<league>/<id>', `https://www.pathofexile.com/api/stash/${encodeURIComponent(league)}/${encodeURIComponent(id)}`]] : [])
      ]
      for (const [label, url] of alt) {
        try {
          const r = await fetchImpl(url, {
            headers: { Cookie: `POESESSID=${poesessid}`, 'User-Agent': BROWSER_UA, Accept: 'application/json' }
          })
          if (!r.ok) { console.log(`[stash-probe] ${label}: HTTP ${r.status}`); continue }
          const j = await r.json()
          const stash = j?.stash ?? j
          const kids = Array.isArray(stash?.children) ? stash.children.length : (Array.isArray(j?.stashes) ? `stashes:${j.stashes.length}` : 'none')
          const n = Array.isArray(stash?.items) ? stash.items.length : -1
          console.log(`[stash-probe] ${label}: HTTP 200 keys=${Object.keys(j || {}).join(',')} items=${n} children=${kids}`)
          // Round three: child tabs. Fields of the first child (names only)
          // and both plausible addressings — directly by child ID, and as a
          // path under the parent tab. Two requests, then the question is
          // answered.
          const children = Array.isArray(stash?.children) ? stash.children : []
          if (children.length) {
            console.log(`[stash-probe] child fields: ${Object.keys(children[0] || {}).join(',')}`)
            const childId = children[0]?.id
            const base = `https://www.pathofexile.com/api/stash/${encodeURIComponent(league)}`
            for (const [cl, curl] of [
              ['child direct', `${base}/${encodeURIComponent(childId)}`],
              ['child under parent', `${base}/${encodeURIComponent(id)}/${encodeURIComponent(childId)}`]
            ]) {
              try {
                const cr = await fetchImpl(curl, {
                  headers: { Cookie: `POESESSID=${poesessid}`, 'User-Agent': BROWSER_UA, Accept: 'application/json' }
                })
                if (!cr.ok) { console.log(`[stash-probe] ${cl}: HTTP ${cr.status}`); continue }
                const cj = await cr.json()
                const cs = cj?.stash ?? cj
                console.log(`[stash-probe] ${cl}: HTTP 200 items=${Array.isArray(cs?.items) ? cs.items.length : -1} type=${cs?.type ?? '?'}`)
              } catch (e) {
                console.log(`[stash-probe] ${cl}: error — ${e?.message || e}`)
              }
            }
          }
        } catch (e) {
          console.log(`[stash-probe] ${label}: error — ${e?.message || e}`)
        }
      }
    },
    // Sequential: tab list first, then tab by tab — NEVER in parallel.
    // A flaky tab gets skipped instead of killing the whole scan. auth/ratelimit
    // still abort immediately (cookie/ban protection). Only consecutive 4xx
    // REJECTIONS trip the systemic-abort guard (GGG actively refusing = a real
    // back-off signal). Timeouts / 5xx are individual slow/stalling tabs (each
    // bounded to ~90s, one request at a time) -> skipped freely, so a tail of
    // huge remove-only junk tabs can't abort the run.
    async fetchAllTabs () {
      onProgress({ phase: 'tabs', done: 0, total: 0 })
      const tabs = await this.listTabs()
      const out = []
      const skippedTabs = []
      let consecutiveTabFails = 0
      for (const tab of tabs) {
        onProgress({ phase: 'tab', done: out.length, total: tabs.length, tabName: tab.name })
        try {
          const items = await this.fetchTab(tab.index, tab)
          out.push({ tab, items })
          consecutiveTabFails = 0
        } catch (e) {
          if (e?.kind === 'auth' || e?.kind === 'ratelimit') throw e
          console.warn(`[stash-client] Tab "${tab.name}" skipped (${e?.message || e})`)
          skippedTabs.push(tab.name)
          if (e?.kind === 'rejected') {
            // 4xx refusal in a row = systemic -> abort (ban protection).
            if (++consecutiveTabFails >= CONSECUTIVE_TAB_FAIL_LIMIT) {
              throw fail(`Scan aborted: ${consecutiveTabFails} tabs rejected in a row (last "${tab.name}")`, 'tabfail')
            }
          } else {
            // Timeout / 5xx = a slow tab, not a refusal -> don't count it.
            consecutiveTabFails = 0
          }
        }
      }
      return out
    }
  }
}
