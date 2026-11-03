// Incremental per-tab scan core (extracted from server.mjs so it's unit-testable
// with a mocked stash-client — NO GGG requests in tests). Every tab is valued
// and PERSISTED on its own the moment it's done (store.setTab), so an abort in
// the tail never loses the tabs already fetched. All I/O is injected:
//   client   — stash-client ({ listTabs(), fetchTab(index) }), UNCHANGED
//   store    — per-tab networth store (setTab/isFresh/pruneTabs/setMeta/tabList)
//   valuator — { value(desc) } (poe.ninja-backed, cached)
//   normalize— ggg -> descriptor (normalizeItem bound with the items index)
import { aggregate } from './aggregate.mjs'
import { listingOf } from './listing-audit.mjs'

// One GGG stash tab's raw items -> per-tab store object (grouped item rows,
// grouped unpriced list, entry counts). Item-level failures are skipped, exactly
// like the whole-scan behaviour before.
//
// `listed`: the price notes of the priced entries, one per stash entry with its
// cell (listing-audit.mjs, "Listed below market"). Kept from the items this
// read already holds; nothing is fetched for it.
//
// `type`: the stash API's tab type from the tab list (QuadStash, PremiumStash,
// ...; null when the list carried none), so a buyer whisper can say whether
// its tab is a quad tab (listing-audit.mjs quadTabAt).
export async function valueTab ({ items, tab, valuator, normalize, cdRatio, league, accountName }) {
  const entries = []
  const listed = []
  for (const ggg of items) {
    try {
      const desc = normalize(ggg)
      const value = desc.kind === 'skip' ? null : await valuator.value(desc)
      entries.push({ desc, tabIndex: tab.index, tabName: tab.name, value })
      // Its own guard: a failure here must not book the entry a second time
      // as skipped below. The valuation above stands, only the note is lost.
      try {
        const l = desc.kind === 'skip' ? null : listingOf(ggg, desc, value, tab)
        if (l) listed.push(l)
      } catch { /* no listing for this entry */ }
    } catch {
      entries.push({ desc: { kind: 'skip', reason: 'error', name: '?' }, tabIndex: tab.index, tabName: tab.name, value: null })
    }
  }
  // unpricedMax: Infinity — what comes out of here is WRITTEN TO THE STORE, not
  // drawn on a page, and the net-worth recorder reads the stored unpriced names
  // back as its proof that an item without a price is still in the stash. A cap
  // here would put that proof out of reach for exactly the thinly traded items
  // that need it, so the display cap stays where the display is (aggregate.mjs).
  const per = aggregate({ entries, cdRatio, league, accountName, unpricedMax: Infinity })
  // Diagnostics (POE_NETWORTH_DEBUG=1): ONLY here can "the tab came back empty"
  // be told apart from "every item was skipped". Deliberately sits in valueTab
  // and not in scanTabs — the background refresher calls valueTab directly, and
  // scanTabs does not run in production at all. Off by default.
  if (process.env.POE_NETWORTH_DEBUG === '1') {
    const c = per.counts || {}
    const reasons = {}
    for (const e of entries) if (e.desc?.kind === 'skip') reasons[e.desc.reason || '?'] = (reasons[e.desc.reason || '?'] || 0) + 1
    const why = Object.entries(reasons).map(([k, v]) => `${k}=${v}`).join(' ')
    console.log(`[networth:scan] tab "${tab.name}" (index=${tab.index} type=${tab.type ?? '?'}) ` +
      `raw=${items.length} priced=${c.priced ?? 0} unpriced=${c.unpriced ?? 0} skipped=${c.skipped ?? 0}${why ? ` [${why}]` : ''}`)
  }
  return { index: tab.index, name: tab.name, type: tab.type ?? null, items: per.items, unpriced: per.unpriced, counts: per.counts, listed }
}

// Sequential incremental scan. Fresh tabs (valued within ttlMs, unless `force`)
// are skipped and their stored data kept. auth/ratelimit propagate (caller
// aborts + broadcasts a partial snapshot from the store); a single tab's
// fetch failure (rejected/server/timeout) is skipped and the scan continues.
// Returns the live tab list (in-game order).
export async function scanTabs ({
  client, store, valuator, normalize,
  user, league, cdRatio, accountName,
  ttlMs, force = false, now = () => Date.now(), onProgress = () => {}
}) {
  const tabs = await client.listTabs()
  store.pruneTabs(user, tabs.map(t => t.index))
  store.setMeta(user, { accountName, league, cdRatio })

  let done = 0
  for (const tab of tabs) {
    done++
    if (!force && store.isFresh(user, tab.index, ttlMs, now())) {
      onProgress({ phase: 'tab', done, total: tabs.length, tabName: tab.name, cached: true })
      continue
    }
    onProgress({ phase: 'tab', done, total: tabs.length, tabName: tab.name })
    let items
    try {
      items = await client.fetchTab(tab.index, tab)
    } catch (e) {
      if (e?.kind === 'auth' || e?.kind === 'ratelimit') throw e
      continue // individual tab failure -> keep old stored state, carry on
    }
    const tabData = await valueTab({ items, tab, valuator, normalize, cdRatio, league, accountName })
    await store.setTab(user, tab.index, tabData) // persists immediately
  }
  return tabs
}
