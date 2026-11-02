/* Frontend i18n — one string table per language, no framework, no build step.
 *
 * WHY A CLASSIC SCRIPT: index.html loads app.js as a classic script, the other
 * two pages load their page script as a module. Module scripts are deferred and
 * would therefore run AFTER app.js — a module i18n could not serve all three.
 * So this file is a classic script that publishes `window.I18n` and is loaded
 * first on every page. Node tests evaluate it in a `vm` context (see
 * i18n-coverage.test.mjs); nothing here touches the DOM at load time.
 *
 * HOW A PAGE LEARNS ITS LANGUAGE — no new transport, no new source of truth.
 * The mapping user -> language is configuration (POE_USER_LANGS, see
 * user-langs.mjs) and the server already ships it: GET /users answers
 * `{ users, appName, langs }`. The browser knows WHICH user it is from the same
 * `ppt_user` cookie it already uses for the WebSocket room. So:
 *
 *   1. At load, synchronously: read the cookie, look up the language this
 *      browser resolved for that user LAST time (localStorage). That is a
 *      cache of the server's answer, never an independent setting — it exists
 *      only so the page does not paint English for one frame before /users
 *      comes back.
 *   2. When /users answers, the page calls I18n.setLang(langs[user]). That is
 *      the authority; a stale cache is corrected there and re-rendered.
 *
 * A language is therefore never hardcoded and never guessed from the browser's
 * Accept-Language: a user who plays a German client wants a German page even on
 * an English system, and that fact lives in the server's configuration.
 */
'use strict'

window.I18n = (() => {
  const DEFAULT_LANG = 'en'
  const LANG_CACHE_PREFIX = 'ppt_lang.'

  // ---- string tables -------------------------------------------------------
  // Every user-visible text on every page. A key missing from ONE language is a
  // hard test failure (i18n-coverage.test.mjs, stage (a) of acceptance
  // criterion 6) — the tables must stay the same shape, or the next feature
  // tears holes into the German page without anything going red.
  //
  // Game vocabulary stays as the client names it (Divine, Chaos, Stash, Delve);
  // everything the tool invented itself gets a plain German word.
  const STRINGS = {
    en: {
      // ---- shell: rail, nav, titles -------------------------------------
      'app.subtitle': 'Path of Exile',
      'nav.pricecheck': 'Price Check',
      'nav.networth': 'Net Worth',
      'nav.history': 'History',
      'nav.settings': 'Settings',
      'nav.switchUser': 'Switch user',
      'rail.league': 'League',
      'rail.leagueAria': 'Active league',
      'rail.cdCap': 'Chaos → Divine',
      'rail.cdUnit': 'chaos / div',
      'rail.cdOneDivine': '1 Divine',
      'rail.cdChaos': 'Chaos',
      'rail.cdLive': 'live ratio',
      'rail.cdTrendFallback': 'live',
      // M2 data-freshness note (shell.js)
      'shell.ageHours': '{n} hours',
      'shell.ageDays': '{n} days',
      'shell.syncExpired': 'Background sync is paused: the stored POESESSID has expired. Renew it on the settings page.',
      'shell.dataStale': 'Data auto-update: no successful check of {list} — the tool keeps running with the data it has.',
      'shell.dataStaleSource': '{source} for {age}',
      'shell.dataStaleReason': 'Last attempt for {source} failed: {reason}',
      'shell.dataWarning': 'Note on {source}: {warning}',
      'shell.dataAdvice.unreachable': 'The other side did not answer — nothing to do here, the next check tries again on its own.',
      'shell.dataAdvice.rejected': 'An answer arrived and this tool refused it. That does not fix itself: see the admin area on the settings page and the container log.',
      'shell.dataAdvice.incompatible': 'The data format has moved past this build — update the container (settings page, admin area, "Update to a newer version").',
      'shell.releaseNewer': 'poe-price-tool {latest} is out; this server runs {installed}. See the settings page.',
      // ---- connection pill ------------------------------------------------
      'conn.connecting': 'connecting…',
      'conn.live': 'live',
      'conn.reconnecting': 'reconnecting…',
      'conn.offline': 'offline',
      // ---- identity gate ----------------------------------------------------
      'idgate.title': 'Who are you?',
      'idgate.hintCards': 'Used only for routing (your own cards & league). No password.',
      'idgate.hintLeague': 'Used only for routing (your own league). No password.',

      // ---- Price Check page --------------------------------------------------
      'pc.heading': 'Checked items',
      'pc.active': '{n} active',
      'pc.note': 'searches run on demand only',
      'pc.clearAll': 'Clear all',
      'pc.empty': 'No items in the queue. Price-check something in-game.',
      'pc.hint_html': 'Hover an item in-game and press <kbd>your hotkey</kbd> to price-check. Open a card to pick mods, then <kbd>Search</kbd>.',
      // price block
      'pc.price.queued': 'queued',
      'pc.price.inQueue': 'in queue',
      'pc.price.searching': 'searching…',
      'pc.price.priority': 'priority',
      'pc.price.rateLimited': 'rate-limited',
      'pc.price.searchesPaused': 'searches paused',
      'pc.price.noPrice': 'no price',
      'pc.price.tryAgain': 'try again',
      'pc.price.noData': 'no data',
      'pc.price.marketValue': 'market value',
      'pc.price.dataPoints': '{n} data pts',
      'pc.price.bulk': 'bulk',
      'pc.price.sellers': '{n} sellers',
      'pc.price.listings': 'listings',
      'pc.price.listingsN': '{n} listings',
      'pc.price.medianTitle': 'Median — the typical price, unmoved by outliers',
      'pc.price.tradeAsk': 'Trade-Ask: {value}',
      'pc.price.tradeAskTitle': 'What sellers are ASKING on the trade site — the cheapest offers this search fetched, not a price anything sold at',
      'pc.price.tradeOnly': 'TRADE',
      'pc.price.tradeOnlyTitle': 'No Currency Exchange rate for this item, so the price is the trade site\'s own offers — asking prices, listed one by one below',
      'pc.price.exchangeAge': 'rate is {n} h old',
      'pc.price.exchangeAgeTitle': 'The Currency Exchange publishes one digest per hour, and this item last traded in an hour that old — so this rate describes that hour, not the market right now. The in-game window can differ. Shown only when the rate is older than this tool can avoid; past a limit it is dropped for a poe.ninja price instead.',
      'pc.price.exchangeRange': 'that hour {low}–{high} c',
      'pc.price.exchangeRangeTitle': 'Low and high of the ONE exchange hour this rate comes from — not the span of the hours searched. The rate above is that hour\'s volume-weighted average.',
      'pc.price.conflictOver': 'The trade site asks well below this rate (see Trade-Ask). One of the two is off — check before valuing the item at this number.',
      'pc.price.conflictUnder': 'Even the cheapest trade ask is several times this rate (see Trade-Ask). The rate may be stale or from a thin hour — check before selling at this number.',
      'pc.price.conflictMark': ' — asks disagree',
      // trade / ninja buttons
      'pc.openNinja': 'Open Ninja ↗',
      'pc.openNinjaTitle': 'Open this item on poe.ninja',
      'pc.openNinjaNone': 'Priced via poe.ninja — no trade search was run',
      'pc.openTrade': 'Open Trade ↗',
      'pc.openTradeNone': 'No trade search yet',
      'pc.openTradeTitle': 'Open this search on pathofexile.com/trade',
      // listings
      'pc.listings.more': '+ {n} more',
      'pc.listings.less': '− show less',
      // card
      'pc.card.dismiss': 'Dismiss',
      'pc.card.corrupted': 'Corrupted',
      'pc.card.matchMods': 'Match mods',
      'pc.card.tier': 'Tier {n}',
      // mod editor
      'pc.ed.lead_html': 'Tick the mods to require and set each roll range (min–max). <b>Nothing runs until you hit Search.</b>',
      'pc.ed.topTier': 'T2+',
      'pc.ed.topTierTitle': 'Tick only the mods that rolled tier 1 or 2',
      'pc.ed.allMods': 'All mods',
      'pc.ed.allModsTitle': 'Tick every mod — click again to untick all',
      'pc.ed.corrupted': 'Corrupted',
      'pc.ed.corruptAny': 'any',
      'pc.ed.corruptYes': 'yes',
      'pc.ed.corruptNo': 'no',
      'pc.ed.modOne': 'mod',
      'pc.ed.modOther': 'mods',
      'pc.ed.search': 'Search',
      'pc.ed.searching': 'Searching…',
      'pc.ed.refreshes': 'refreshes prices',
      'pc.ed.reset': '↺ Reset',
      'pc.ed.resetTitle': "Reset ranges & ticks to this item's defaults",
      'pc.ed.notSearchable': 'not searchable',
      'pc.ed.notSearchableTitle': 'Not in the vendored trade data — add it manually via Open Trade',
      'pc.ed.fractured': 'fractured',
      'pc.ed.min': 'Minimum',
      'pc.ed.max': 'Maximum',
      // mod groups
      'pc.group.links': 'Sockets',
      'pc.group.unknown': 'Not searchable',
      'pc.group.implicit': 'Implicit',
      'pc.group.fractured': 'Fractured',
      'pc.group.prefix': 'Prefixes',
      'pc.group.suffix': 'Suffixes',
      'pc.group.explicit': 'Explicit',
      'pc.group.crafted': 'Crafted',
      // rarities (card subline)
      'rarity.normal': 'Normal',
      'rarity.magic': 'Magic',
      'rarity.rare': 'Rare',
      'rarity.unique': 'Unique',
      'rarity.currency': 'Currency',
      'rarity.gem': 'Gem',
      'rarity.divination': 'Divination',
      // rate-limit banner
      'rate.soft': 'Trade API rate limit almost exhausted — searches may pause shortly.',
      'rate.defaultMessage': "GGG's trade API rate-limited the app — searches are paused.",
      'rate.retryIn': ' Retry in {wait}.',
      'rate.waitSec': '~{n}s',
      'rate.waitMin': '~{n}m',
      'rate.waitHour': '~{n}h',
      'rate.waitHourMin': '~{h}h {m}m',
      // currency reference rail
      'ref.currency': 'Currency',
      'ref.lifeforce': 'Lifeforce — Selling',
      'ref.beasts': 'Beasts',
      'ref.title': 'Reference',
      'ref.noData': 'no data',
      'ref.noSource': 'No value, so no source: no trustworthy sell-side data for this row',
      'ref.valueFrom': 'Value from {source}{when}',
      'ref.updatedAt': ' · updated {time}',
      'ref.updateUnknown': ' · update time unknown',
      'ref.footUpdated': 'updated {time}',
      'ref.footUnknown': 'time unknown',

      // ---- Net Worth page -----------------------------------------------------
      'nw.heading': 'Net Worth',
      'nw.syncSettings': 'Sync settings',
      'nw.building': 'Building your snapshot in the background — this fills in automatically.',
      'nw.toHistory': 'History →',
      'nw.overview': 'Overview — by category',
      'nw.viewList': 'List',
      'nw.viewGrouped': 'Grouped',
      'nw.stashHighlight': 'Stash Highlight',
      'nw.stashHighlightTitle': 'Turns the visible selection into a search string for the in-game stash search field',
      'nw.hlAria': 'Search string for the stash search field',
      'nw.hlCopy': 'Copy',
      'nw.hlCopied': 'copied',
      'nw.hlCtrlC': 'Ctrl+C',
      'nw.hlMaxBefore': 'max',
      'nw.hlMaxAfter': 'chars',
      'nw.hlMeta': '{used}/{total} items · {len}/{max} chars',
      'nw.hlNothing': 'nothing selected — adjust the filters',
      'nw.hlDropped': '{n} no longer fit:',
      'nw.hlOvermatch': 'unavoidably matches similar items too:',
      'nw.hlWordGuard': 'why the field ran out: {n} fragments are longer than the name list alone would need, because the shorter ones are everyday English words — the stash search reads the flavour text too.',
      'nw.historySection': 'History',
      'nw.historyRow': '{when} — {div} div ({chaos}c) · {league}',
      // rail: tab picker
      'nw.searchPlaceholder': 'Search item…',
      'nw.threshLabel': 'Hide items worth less than',
      'nw.threshOff': 'Off',
      'nw.threshDiv': '1 div',
      'nw.stashTabs': 'Stash tabs',
      'nw.selAll': 'All',
      'nw.selNone': 'None',
      'nw.selValued': 'Only w/ value',
      'nw.selValuedTitle': 'Select only tabs that contain priced items above the threshold',
      'nw.resetOrder': 'Reset order',
      'nw.autosyncTitle': "A background refresher syncs one stash tab at a time, staying under GGG's rate limit.",
      'nw.autosyncStarting': 'syncing in background',
      'nw.autosync': '{recent}/{total} tabs synced in the last {windowMins} min · oldest tab synced {mins} min ago',
      'nw.sideCount': '{on}/{total}',
      'nw.sideIgnored': ' · {n} ignored',
      'nw.noTabs': 'No tabs with priced items yet.',
      'nw.tabCounts': '{priced} priced · {unpriced} unpriced · {skipped} skipped',
      'nw.tabNothingArrived': 'nothing arrived from this tab',
      'nw.tabHintOn': 'counted. Click to exclude.',
      'nw.tabHintOff': 'excluded, but All / None / Only w/ value may switch it back on. Click to ignore it permanently.',
      'nw.tabHintIgnored': 'permanently ignored — All / None / Only w/ value leave it alone. Click to count it again.',
      'nw.tabFallback': 'Tab #{n}',
      'nw.tabFallbackPlain': 'Tab',
      // table
      'nw.colItem': 'Item',
      'nw.colTab': 'Tab',
      'nw.colQty': 'Qty',
      'nw.colEach': 'Each',
      'nw.colTotal': 'Total',
      // Which feed produced the price. The value itself is data (`faustus`,
      // `exchange:DivinationCard`, `item:UniqueMap`, …) and is NOT translated:
      // it is the identifier the store, the price-guard log and
      // docs/pricing-logic.md all use, and a report is only worth as much as
      // the name it can quote.
      'nw.colSource': 'Source',
      'nw.noMatch': 'No items match the current filters.',
      'nw.nothingPriced': 'nothing priced yet',
      'nw.groupCount': '{items} items · {pcs} pcs',
      'nw.stat_html': '<b>{n}</b> items shown · <b>{value}</b>',
      'nw.statHidden': '{n} hidden below threshold',
      'nw.tradeTitle': 'Open on pathofexile.com/trade',
      // Same unit vocabulary as nw.groupCount above: "pcs" is a piece count,
      // which is exactly what the ×N on every row below the line adds up to.
      // The line used to state stash ENTRIES over a list of PIECES and call
      // both "items".
      'nw.unpriced': '{pcs} pcs unpriced across {names} {nameWord} (not counted)',
      'nw.unpricedNameOne': 'name',
      'nw.unpricedNameOther': 'names',
      // Said out loud rather than folded into the number above: the row list is
      // capped at 100 names (UNPRICED_MAX in aggregate.mjs).
      'nw.unpricedMore': ' · {n} pcs not listed',
      'nw.unpricedRow': '{name} ×{n} ({kind})',
      // categories
      'kind.stackable': 'Currency & Stackables',
      'kind.unique': 'Uniques',
      'kind.divcard': 'Divination Cards',
      'kind.beast': 'Beasts',
      'kind.incubator': 'Incubators',
      'kind.vial': 'Vials',
      'kind.gem': 'Gems',
      'kind.corpse': 'Corpses',
      'kind.all': 'All',
      // sync status + settings dialog
      'nw.syncExpired': 'POESESSID expired — background sync paused. Open settings to renew.',
      'nw.syncCooldown': 'Rate-limited by GGG — sync resumes at {at}.',
      // A 429 pauses the refresher for EVERY configured user, because nothing
      // in GGG's answer says whether the limit was counted per session or per
      // address. This is the bystander's wording; the other user is not named.
      'nw.syncCooldownOther': 'Another user was rate-limited by GGG — syncing pauses for everyone until {at}.',
      // The OTHER reason the sync can be on hold, and not the same one: GGG has
      // blocked this app on the trade API. A ban reaches the whole address, so
      // the stash reads stop with it. Nothing to fix here — it lifts by itself.
      'nw.syncTradeBan': 'The GGG trade API has blocked this app — stash syncing pauses with it until {at}.',
      'nw.syncSoon': 'soon',
      'nw.syncMissing': 'No credentials configured — open settings to add them.',
      'nw.setState.unknown': 'Background sync: state unknown.',
      'nw.setState.expired': 'Background sync is paused — the stored POESESSID has expired. Paste a new one below.',
      'nw.setState.cooldown': 'Background sync is rate-limited by GGG and resumes at {at}. Credentials are fine.',
      'nw.setState.cooldownOther': 'Background sync is paused until {at}: GGG rate-limited another configured user and the refresher backs off for all of them. Your credentials are fine.',
      'nw.setState.tradeBan': 'Background sync is paused until {at}: the GGG trade API has blocked this app, and a block reaches the whole address — so the stash reads stop with it. Your credentials are fine, and there is nothing to change here.',
      'nw.setState.missing': 'No credentials configured for this user yet. Enter account name and POESESSID to start syncing.',
      'nw.setState.ok': 'Background sync is running.',
      'nw.setLoading': 'Loading…',
      'nw.setAccount': 'Account name',
      'nw.setSessid': 'POESESSID',
      'nw.setSessidPh': 'leave empty to keep the stored one',
      'nw.setSave': 'Save',
      'nw.setNote': 'The stored POESESSID is never shown here — not even masked. To renew it, paste a new one; leaving the field empty keeps the stored value. Saving takes effect on the next background sync tick, no restart needed.',
      'nw.setHint': 'Heads-up: this value is {n} characters — POESESSID cookies are usually 32. Saving is still allowed.',
      'nw.saveFailedHttp': 'Saving failed (HTTP {status}).',
      'nw.saveFailedNet': 'Saving failed — server not reachable.',

      // ---- History page --------------------------------------------------------
      'hi.heading': 'History',
      'hi.rangeAria': 'Time range',
      'hi.chartAria': 'Net worth over time',
      'hi.collecting': 'Collecting data…',
      'hi.whatMoved': 'What moved',
      'hi.window': 'This window',
      'hi.covRange': 'Range',
      'hi.covRecorded': 'Recorded',
      'hi.covEvents': 'Events',
      'hi.covNet': 'Net change',
      'hi.covRate': 'C:D rate',
      'hi.covRateVal': '{from} → {to} ({pct}%)',
      'hi.rateLine': 'Chaos per divine in this window — own scale',
      'hi.unitInfoAria': 'How the divine figures are calculated',
      // Visible label on the button. Kept a literal part of the aria sentence
      // above, so the accessible name contains the visible one (WCAG 2.5.3).
      'hi.unitInfoBtn': 'Divine figures',
      // Third sentence came from the rail note that used to repeat this one
      // permanently: it is the only thing that note said on its own.
      'hi.unitInfo': 'Every point is converted with the C:D rate it had at that moment, never with today’s — that is why the past stops changing once it is recorded. It also means the curve can fall while your stash is untouched: when the divine gets more expensive, the same items are worth fewer of them, and the other way round. A window whose chaos total rose can therefore still come out as a net loss, when the rate rose faster than the stash did. The pale line is that rate, so you can tell the two apart — your stash, or the market.',
      'hi.minLabel': 'Count as an event from',
      'hi.minAll': 'everything recorded',
      'hi.minDiv05': '0.5 div',
      'hi.minDiv1': '1 div',
      'hi.minDiv3': '3 div',
      'hi.minDiv10': '10 div',
      'hi.covNote': 'Events are stock movements — what came in and what went out. Price moves are in the curve, not in the list.',
      'hi.evNoneInWindow': 'Nothing came in or went out in this window. The curve still moves with prices.',
      'hi.evNoneRecorded': 'No history recorded yet for this window.',
      'hi.evBarAll': 'everything recorded',
      'hi.evBarFrom': 'from {n} div',
      'hi.evNote': '{n} {word} · stock movements only · {bar}',
      'hi.eventOne': 'event',
      'hi.eventOther': 'events',
      'hi.headSum_html': 'now <b>{now}</b> · stock moved {moved}',
      'hi.agoSec': '{n}s ago',
      'hi.agoMin': '{n} min ago',
      'hi.agoHour': '{n}h ago',
      'hi.spanMin': '{n} min',
      'hi.spanHour': '{n}h',

      // ---- Settings page ---------------------------------------------------------
      // The tool had no settings page; the net-worth sync credentials (a dialog
      // until now) and the admin view share this one.
      'set.heading': 'Settings',
      'set.saved': 'saved',
      // ---- Settings: the user's own client language ---------------------------
      // The lead text is the point of the whole section: a wrong value here does
      // not misprice an item, it makes the item disappear without a word.
      'lang.title': 'Client language',
      'lang.lead': 'Pick the language your game client runs in — the language of the item text you copy. This is not a setting for the language of this website; the pages follow it, but that is a side effect. Get it wrong and your item is not priced wrongly, it is not recognised at all: no card turns up here, and the game itself tells you nothing.',
      'lang.label': 'Language of your game client',
      'lang.onlyOne': 'This server has loaded only one language, so there is nothing to switch to. A second one has to be generated on the server first.',
      'lang.notPersisted': 'This server cannot write to its /config volume: your choice works right now, but it is forgotten the next time the server restarts.',
      'lang.failedHttp': 'The language could not be changed (HTTP {status}).',
      'lang.failedNet': 'The language could not be changed — server not reachable.',
      'lang.name.en': 'English',
      'lang.name.de': 'German',
      'set.adminTitle': 'Admin area',
      'set.adminLead': 'For whoever runs the server: the settings this installation can change while it is running, a restart button, and what the tool could not do — texts it failed to parse, mod lines it could not resolve, and how far a localized data set has fallen behind English. Nothing here is needed to play.',
      'set.adminGateNote': 'One plaintext password from a file on the server (default: admin). This is a partition, not a security mechanism — it keeps the ordinary user out of a view that is none of their business.',
      'set.adminPassword': 'Admin password',
      'set.adminOpen': 'Open',
      'set.adminClose': 'Close',
      'set.adminReload': 'Reload',
      'set.adminWrong': 'Wrong password.',
      'set.adminFailedHttp': 'The admin view could not be loaded (HTTP {status}).',
      'set.adminFailedNet': 'The admin view could not be loaded — server not reachable.',
      // ---- Admin: the gap list ------------------------------------------------
      'adm.gapsTitle': 'Gaps the tool found by itself',
      'adm.gapsNote': 'Collected while price-checking, grouped by language and sorted by frequency. Held in memory only: the list starts empty after a restart, and it is a page you have to open — the tool sends nothing on its own.',
      'adm.parse': 'Failed parses',
      'adm.parseNote': 'The engine refused the clipboard text. No card ever reached the browser.',
      'adm.unknownMod': 'Unresolved mod lines',
      'adm.unknownModNote': 'The item parsed, but this line matched neither the vendored data set nor GGG’s stat catalogue. The card shows it read-only and the search ignores it — so the price is the price of a different item.',
      'adm.none': 'Nothing recorded.',
      'adm.langSection': 'Language: {lang}',
      'adm.colCount': 'Count',
      'adm.colText': 'Text',
      'adm.colReason': 'Reason',
      'adm.colLast': 'Last seen',
      'adm.sample': 'Triggering text',
      'adm.dropped': '{n} rarer entries were dropped — the list is capped at {max} per kind.',
      // ---- Admin: the dataset offset -------------------------------------------
      'adm.skewTitle': 'Dataset offset between the languages',
      'adm.skewNote': 'Every row measures a localized data set against {base}, which is the yardstick because the localized set is built as a copy of it. A row turns into a warning above {pct}.',
      'adm.skewOk': 'No offset above the threshold.',
      'adm.skewWarn': '{lang} is running behind {base}.',
      'adm.skewAbsent': 'No data set for {lang} at all — items in this language cannot be parsed.',
      'adm.skewBaseAbsent': 'The {base} data set could not be read — no comparison is possible.',
      'adm.skewExtra': '{n} entries exist only in {lang} and have no {base} counterpart. Under the way the set is built that number should be zero.',
      'adm.metric.items': 'Item names',
      'adm.metric.stats': 'Stat entries',
      'adm.metric.matchers': 'Stats without a matcher',
      'adm.metric.advanced': 'Extended mod descriptions',
      'adm.metricRow': '{missing} of {base} missing ({pct})',
      'adm.langsConfigured': 'Configured: {list}',
      'adm.langsLive': 'Live parse instances: {list}',
      // ---- Admin: where the localized set came from ----------------------------
      'adm.buildTitle': 'Where the localized set comes from',
      'adm.buildNote': 'Read from the data set the container is serving right now. Empty numbers mean the set predates this bookkeeping — not that nothing was translated.',
      'adm.buildNoLangs': 'This installation generates no data set of its own — English comes from upstream.',
      'adm.buildAbsent': 'There is no data set for {lang} yet, so there is nothing it could have come from.',
      'adm.buildNoRun': 'This set was built before the run numbers were recorded. The next run fills them in.',
      'adm.buildUnknown': 'unknown',
      'adm.buildFirstBuild': 'first build, no previous set',
      'adm.buildAt': 'Generated',
      'adm.buildPatch': 'From game patch',
      'adm.buildCovered': 'Stats with a matcher',
      'adm.buildCoveredValue': '{covered} of {base} — {gap} have none',
      'adm.buildRegressed': 'Lost against the previous set',
      'adm.buildRegressedValue': '{n} of {base}',
      'adm.buildNewGaps': 'Newly without a matcher (the previous set had none either)',
      'adm.buildItems': 'Item names',
      'adm.buildItemsValue': '{translated} of {base} translated, {kept} kept English',
      'adm.buildUnknownNamespace': 'The item namespace {namespace} has no name source at all — its {n} entries stay English, and no other number on this page shows it.',
      'adm.stringsOk': 'The display texts of {lang} carry the same {n} keys as the English set.',
      'adm.stringsMissing': 'The English display texts have {n} key(s) that {lang} does not: {keys}. Any of them the parser reads is missing in that language. These files are hand written and ship with the image, so this is closed by a container update, not by a data refresh.',
      'adm.stringsExtra': '{lang} has {n} key(s) the English set no longer has: {keys}. Left over from an older upstream — nothing reads them any more.',
      'adm.stringsUnreadable': 'The display texts of {lang} could not be read ({why}), so the two sets were not compared.',
      'adm.stringsAt': 'Compared when the English set was last adopted, {at}.',
      // ---- Admin: the server settings (GET /config-view) -----------------------
      'cfg.title': 'Server settings',
      'cfg.note': 'The settings this installation can change while it is running. They are written to a file in the /config volume, and that file wins over the values the container was started with. Nothing secret can be set or read here.',
      'cfg.path': 'Stored in {path}',
      'cfg.groupLive': 'Takes effect immediately',
      'cfg.groupRestart': 'Needs a restart',
      'cfg.trafficTitle': 'How often this tool asks other people’s servers',
      'cfg.trafficNote': 'These decide how much traffic the background jobs send to the trade API, to poe.ninja, to GGG’s exchange feed and to the data sources. They stand apart because turning one of them up is a different kind of change from renaming the header: the trade API answers a request rate it dislikes with a rate limit, and this tool has been banned twice for what came after one. The defaults are the values it is known to run well on, and each row says which direction adds requests.',
      'cfg.trafficLower': 'Lower values send more requests.',
      'cfg.trafficHigher': 'Higher values send more requests.',
      'cfg.trafficOffMore': 'Switching this off sends more requests.',
      'cfg.trafficOnMore': 'Switching this on sends more requests.',
      'cfg.colSetting': 'Setting',
      'cfg.colValue': 'Value',
      'cfg.colSource': 'Where the value comes from',
      'cfg.source.override': 'set here, on this page',
      'cfg.source.env': 'from the server’s compose file',
      'cfg.source.default': 'built-in default',
      'cfg.defaultIs': 'default: {value}',
      'cfg.defaultUnset': 'not set by default',
      'cfg.boolOn': 'on',
      'cfg.boolOff': 'off',
      'cfg.shadowsEnv': 'This wins over the compose file, which says {value} here. Editing compose changes nothing for this setting until the value on this page is reset.',
      'cfg.invalid': 'The stored file holds a value for this setting that is not allowed, so it does nothing — the value shown is the one actually in force. {why}',
      'cfg.rowPending': 'saved — in effect after a restart',
      'cfg.pending': 'Some settings are saved but not in effect yet. They need a restart.',
      'cfg.reset': 'Reset',
      'cfg.resetTitle': 'Remove the value set here and fall back to the compose file or the built-in default',
      'cfg.saved': 'saved',
      'cfg.saveFailed': 'Not saved: {error}',
      'cfg.saveFailedNet': 'Not saved — server not reachable.',
      'cfg.quarantineTitle': 'The saved settings were thrown out',
      'cfg.quarantineBody': 'Several starts in a row with the settings from this page did not come up, so they were moved aside to {path} and are NOT in effect — the server is running on its compose file and its built-in defaults. Look at that file before putting any of it back.',
      'cfg.problemsTitle': 'Problems with the settings file',
      'cfg.pwDefaultTitle': 'The admin password is still the default one',
      'cfg.pwDefaultBody': 'It is printed in this tool’s public repository, and it is what stands between anyone on this network and the restart button below, the settings the next start reads, and this diagnostic view. Change it in the password file on the server (POE_ADMIN_PASSWORD_FILE, by default /config/admin-password) — one plaintext line, in effect on the next click, no restart needed.',
      'cfg.restartTitle': 'Restart',
      'cfg.restartBtn': 'Restart now',
      'cfg.checkNowTitle': 'Check the data sources',
      'cfg.checkNowBtn': 'Check now',
      'cfg.checkNowNote': 'The data sources are checked once a day, so a setting saved here — the patch version above all — normally takes until the next check to show any effect. This runs that check straight away, which is how you find out whether a repair worked instead of waiting for it. It is not free: it asks for the patch version, re-fetches every upstream file, and rebuilds the localized data set if anything is out of date, which downloads game data from the patch CDN. So it stays shut for a while afterwards (POE_DATA_CHECK_NOW_COOLDOWN_MS above).',
      'cfg.checkNowRunning': 'Checking…',
      'cfg.checkNowDone': 'Check finished — the status line above is up to date.',
      'cfg.checkNowBusy': 'A check is already running. Its result appears in the status line by itself.',
      'cfg.checkNowCooldown': 'A check ran a moment ago. Possible again in {sec} seconds.',
      'cfg.checkNowFailed': 'The server could not be reached.',
      'cfg.checkNowFailedHttp': 'The server refused the check (HTTP {status}).',
      'cfg.restartNote': 'The container stops and its supervisor starts it again — normally back in about {sec} seconds, provided the container has a restart policy. Everything running at that moment is cut off: the background stash sync, any search in flight, and every open page has to reconnect.',
      'cfg.restartConfirm': 'Restart the server now? Running stash syncs and searches are cut off, and every open page loses its connection for a moment. It only comes back by itself if this container was started with a restart policy (restart: unless-stopped in the shipped docker-compose.yml). Without one the tool stays off until somebody starts it again on the host — and this page will not be there to undo it.',
      'cfg.restarting': 'Restarting — waiting for the server to answer again…',
      'cfg.restartBack': 'The server is back.',
      'cfg.restartGone': 'The server has not answered for {sec} seconds. The likeliest reason is that nothing started it again: a container without a restart policy stays down. Start it on the host (docker compose up -d, or however this installation is started) and give it restart: unless-stopped so the button works next time.',
      'cfg.restartGoneEarlier': 'An earlier restart from this page did not come back on its own — somebody had to start the tool again. That means this container has no restart policy; add restart: unless-stopped, or expect to start it by hand every time this button is used.',
      'cfg.restartFailedHttp': 'The restart could not be triggered (HTTP {status}).',
      'cfg.restartFailedNet': 'The restart could not be triggered — server not reachable.',
      'cfg.runtimeTitle': 'Everything else this server runs with',
      'cfg.runtimeNote': 'Read-only. These come from the compose file or are facts about the running process, and none of them can be changed here. The list exists so that nobody has to open a shell on the server to look them up.',
      'cfg.failedHttp': 'The server settings could not be loaded (HTTP {status}).',
      'cfg.failedNet': 'The server settings could not be loaded — server not reachable.',

      // ---- the update button (host-update.mjs + deploy/host-update.sh) ----------
      'upd.title': 'Update to a newer version',
      'upd.note': 'Pulls the newest code on the server and rebuilds the container. This needs a small script on the host — the tool cannot do it by itself, and deliberately has no access to the host’s Docker daemon.',
      'upd.btn': 'Update now',
      'upd.build': 'This container was built from commit {commit}.',
      'upd.buildUnknown': 'This container does not know which commit it was built from: the build was not told. Pass BUILD_COMMIT when building (see docs/admin.md) and the next image can answer it.',
      'upd.notInstalled': 'No update script is set up on the host, so there is nothing to press this button for. Install deploy/host-update.sh from the repository on the machine that runs Docker and let it run every few minutes (Unraid User Scripts, cron or a systemd timer) — docs/admin.md, "Update button". The tool cannot tell an updater that was never installed from one that was removed, so it says nothing about which of the two this is.',
      'upd.installedAt': 'The host’s update script last reported in at {at}.',
      'upd.stuck': 'The update script on the host is stuck, and nothing will be updated until somebody clears it. A run that never finished has been holding its lock since {at} — longer than a build can take, so that run itself is gone (a reboot in the middle of one does this). Clear it on the host: it is the empty update.lock directory in the script’s work directory, next to the config directory. docs/admin.md, "Update button", spells it out.',
      'upd.stuckNoTime': 'The update script on the host is stuck, and nothing will be updated until somebody clears it. A run that never finished is holding its lock — longer than a build can take, so that run itself is gone (a reboot in the middle of one does this). Clear it on the host: it is the empty update.lock directory in the script’s work directory, next to the config directory. docs/admin.md, "Update button", spells it out.',
      'upd.outNote': 'Output from the host. Lines that name something which could be a credential are dropped, and credentials inside a URL are masked — but that is a filter, not a guarantee: a bare token on a line that names nothing passes straight through it. Read this as text that could still hold one.',
      'upd.confirm': 'Update now? The host pulls the newest code and rebuilds the image. That takes considerably longer than a restart — several minutes — and the tool is gone for part of it: running stash syncs and searches are cut off and every open page loses its connection. Nothing on this page can stop it once the host has picked it up.',
      'upd.requested': 'Requested at {at} — waiting for the host script to pick it up. It runs every few minutes, then the build itself takes a while.',
      'upd.pending': 'An update was requested at {at} and the host has not reported back yet.',
      'upd.working': 'The host is working. This page comes back on its own when the build is done.',
      'upd.doneCommit': 'Updated. Now running commit {commit}.',
      'upd.done': 'Updated.',
      'upd.failed': 'The host tried and failed. The output below is the end of what it printed.',
      'upd.timeout': 'Nothing has come back for {min} minutes. Either the host script is not running (then the request is still sitting in the config volume, waiting), or the build failed so badly that it never wrote a result. Check the update-result file in the config volume and the script’s own log on the host.',
      'upd.failedHttp': 'The update could not be requested (HTTP {status}).',
      'upd.failedNet': 'The update could not be requested — server not reachable.',
      'upd.lastOk': 'Last update {at}: succeeded.',
      'upd.lastFailed': 'Last update {at}: FAILED.',
      'upd.lastUnknown': 'Last update {at}: the host left a result that does not say how it went.',
      'upd.statusFailedHttp': 'The update status could not be loaded (HTTP {status}).',
      'upd.statusFailedNet': 'The update status could not be loaded — server not reachable.',

      // ---- Releases block (settings page) ---------------------------------------
      'rel.title': 'Releases',
      'rel.installed': 'Installed: {version}',
      'rel.installedUnknown': 'Installed: unknown (this server cannot read its own version)',
      'rel.latest': 'Latest release: {version} ({date})',
      'rel.latestNone': 'No release published yet',
      'rel.latestNotChecked': 'Not checked yet',
      'rel.latestUnknown': 'Unknown — the last check did not get an answer',
      'rel.link': 'Release page',
      'rel.lastCheck': 'Last check {when}: {outcome}',
      'rel.outcome.ok': 'release found',
      'rel.outcome.none': 'no release published yet',
      'rel.outcome.unchanged': 'nothing new',
      'rel.outcome.failed': 'failed',
      'rel.advice.unreachable': 'GitHub could not be reached.',
      'rel.advice.rejected': 'GitHub refused the request, usually because of its rate limit.',
      'rel.advice.incompatible': 'GitHub’s answer could not be read; the latest release’s tag may not be a version number.',
      'rel.advice.unknown': 'The check failed for a reason that is not classified.',
      'rel.adviceNext': 'The next automatic check is in 24 hours.',
      'rel.adviceNextAt': 'The next automatic check is at {when}.',
      'rel.adviceReason': 'Reason: {reason}',
      'rel.autoOff': 'The automatic check is turned off; the button below still works.',
      'rel.pointer_html': 'The server is updated by whoever runs it (<a href="https://github.com/{repo}/blob/main/docs/admin.md#update-procedure">update procedure</a>). Every player’s hotkey daemon is its own clone and is updated on their own machine (<a href="https://github.com/{repo}/blob/main/README.md#setting-up-the-hotkey">setting up the hotkey</a>).',
      'rel.checkTitle': 'Check for a newer release',
      'rel.checkNote': 'Asks GitHub now whether a newer release of this tool exists. It only reports; nothing is downloaded or installed. This works whether or not the daily automatic check is switched on.',
      'rel.checkBtn': 'Check for updates',
      'rel.checking': 'Checking…',
      'rel.resultUpToDate': 'Up to date.',
      'rel.resultNewer': '{version} is available.',
      'rel.resultNone': 'No release has been published yet.',
      'rel.resultUnknown': 'The latest release is {version}; the installed version is unknown, so they cannot be compared.',
      'rel.resultRunning': 'A check is already running. Its result appears here by itself.',
      'rel.resultCooldown': 'Try again in {seconds} s.',
      'rel.resultUnauthorized': 'The admin password was not accepted.',
      'rel.resultHttp': 'Check failed: HTTP {status}',
      'rel.resultNet': 'Check failed: the server could not be reached.',

      // ---- texts the SERVER puts on the page ------------------------------------
      // See srv() below: these are literals server.mjs sends in a message the
      // page renders verbatim. Translating them here keeps the change inside
      // frontend/; server-langs.test.mjs guards that the literals still exist.
      'srv.Linked sockets': 'Linked sockets',
      'srv.market rate': 'market rate',
      'srv.fallback': 'fallback',
      'srv.Unknown': 'Unknown',
      // Keyed by the literal the server sends, like every other srv.* entry.
      "srv.GGG's trade API rate-limited the app — searches are paused (retry-after). Common at league launch under heavy load.":
        "GGG's trade API rate-limited the app — searches are paused (retry-after). Common at league launch under heavy load.",
      // Card "facts" (server.mjs activeFilterFacts) arrive as "Label: value".
      // Only the label half is ours to translate; the value is a number.
      'fact.Quality': 'Quality',
      'fact.Item Level': 'Item Level',
      'fact.Level': 'Level',
      'fact.Base Percentile': 'Base Percentile',
      'fact.anyPriced': '(any priced)',

      // ---- filter rows the ENGINE invents (see filterLabel below) ----------
      // These are NOT game strings and NOT stats from the data set: the
      // vendored engine builds them in renderer/src/web/price-check/filters/
      // and hands them over as the `text` of a filter row. No data generation
      // can ever translate them — `Base Percentile` appears zero times in
      // data/en/stats.ndjson — so the table is the only place they can be
      // localized, and the fix belongs here rather than in vendored code.
      //
      // Keyed by the exact literal the engine produces, `#` placeholder and
      // all: the value is substituted into the `#` when the row is rendered
      // (app.js modTextHtml), so a translation MUST keep it. The wording
      // follows the game client's own (data/<lang>/client_strings.js), not a
      // free rendering — the user reads these next to real client text.
      //
      // The full inventory, so the next reader does not have to re-derive it:
      //   pseudo/item-property.ts  the twelve property rows below
      //   pseudo/maps.ts           the three map rows
      //   pseudo/heist.ts          the target + the nine job levels
      //   create-stat-filters.ts   the empty/crafted modifier row
      'flt.Armour: #': 'Armour: #',
      'flt.Evasion Rating: #': 'Evasion Rating: #',
      'flt.Energy Shield: #': 'Energy Shield: #',
      'flt.Ward: #': 'Ward: #',
      'flt.Block: #%': 'Block: #%',
      'flt.Base Percentile: #%': 'Base Percentile: #%',
      'flt.Memory Strands: #': 'Memory Strands: #',
      'flt.Total DPS: #': 'Total DPS: #',
      'flt.Elemental DPS: #': 'Elemental DPS: #',
      'flt.Physical DPS: #': 'Physical DPS: #',
      'flt.Attacks per Second: #': 'Attacks per Second: #',
      'flt.Critical Strike Chance: #%': 'Critical Strike Chance: #%',
      'flt.Item Quantity: +#%': 'Item Quantity: +#%',
      'flt.Item Rarity: +#%': 'Item Rarity: +#%',
      'flt.Monster Pack Size: +#%': 'Monster Pack Size: +#%',
      'flt.Heist Target: Priceless': 'Heist Target: Priceless',
      'flt.1 Empty or Crafted Modifier': '1 Empty or Crafted Modifier',
      // The nine Heist job rows are the one group whose engine text is not
      // even English: heist.ts uses the internal trade id as the row's label,
      // so an English page reads "item.heist_job_lockpicking" — and because
      // that string has no `#`, the required job level never appears either.
      // A real label per language fixes both at once.
      'flt.item.heist_job_lockpicking': 'Lockpicking: #',
      'flt.item.heist_job_bruteforce': 'Brute Force: #',
      'flt.item.heist_job_perception': 'Perception: #',
      'flt.item.heist_job_demolition': 'Demolition: #',
      'flt.item.heist_job_counterthaumaturgy': 'Counter-Thaumaturgy: #',
      'flt.item.heist_job_trapdisarmament': 'Trap Disarmament: #',
      'flt.item.heist_job_agility': 'Agility: #',
      'flt.item.heist_job_deception': 'Deception: #',
      'flt.item.heist_job_engineering': 'Engineering: #'
    },

    de: {
      'app.subtitle': 'Path of Exile',
      'nav.pricecheck': 'Preis-Check',
      'nav.networth': 'Vermögen',
      'nav.history': 'Verlauf',
      'nav.settings': 'Einstellungen',
      'nav.switchUser': 'Nutzer wechseln',
      'rail.league': 'Liga',
      'rail.leagueAria': 'Aktive Liga',
      'rail.cdCap': 'Chaos → Divine',
      'rail.cdUnit': 'Chaos / Div',
      'rail.cdOneDivine': '1 Divine',
      'rail.cdChaos': 'Chaos',
      'rail.cdLive': 'Live-Kurs',
      'rail.cdTrendFallback': 'live',
      'shell.ageHours': '{n} Stunden',
      'shell.ageDays': '{n} Tage',
      'shell.syncExpired': 'Hintergrund-Sync pausiert: die gespeicherte POESESSID ist abgelaufen. Auf der Einstellungsseite erneuern.',
      'shell.dataStale': 'Automatische Datenaktualisierung: keine erfolgreiche Prüfung von {list} — das Werkzeug läuft mit den vorhandenen Daten weiter.',
      'shell.dataStaleSource': '{source} seit {age}',
      'shell.dataStaleReason': 'Letzter Versuch für {source} fehlgeschlagen: {reason}',
      'shell.dataWarning': 'Hinweis zu {source}: {warning}',
      'shell.dataAdvice.unreachable': 'Die Gegenstelle hat nicht geantwortet — hier ist nichts zu tun, die nächste Prüfung versucht es von selbst erneut.',
      'shell.dataAdvice.rejected': 'Es kam eine Antwort, und dieses Werkzeug hat sie abgelehnt. Das erledigt sich nicht von selbst: siehe Adminbereich auf der Einstellungsseite und das Container-Log.',
      'shell.dataAdvice.incompatible': 'Das Datenformat ist diesem Stand davongelaufen — Container aktualisieren (Einstellungsseite, Adminbereich, „Auf eine neuere Version aktualisieren“).',
      'shell.releaseNewer': 'poe-price-tool {latest} ist erschienen; dieser Server läuft mit {installed}. Siehe Einstellungsseite.',
      'conn.connecting': 'verbinde…',
      'conn.live': 'live',
      'conn.reconnecting': 'verbinde neu…',
      'conn.offline': 'offline',
      'idgate.title': 'Wer bist du?',
      'idgate.hintCards': 'Nur für die Zuordnung (deine eigenen Karten & Liga). Kein Passwort.',
      'idgate.hintLeague': 'Nur für die Zuordnung (deine eigene Liga). Kein Passwort.',

      'pc.heading': 'Geprüfte Gegenstände',
      'pc.active': '{n} aktiv',
      'pc.note': 'Suchen laufen nur auf Anforderung',
      'pc.clearAll': 'Alle entfernen',
      'pc.empty': 'Keine Gegenstände in der Warteschlange. Prüfe im Spiel einen Gegenstand.',
      'pc.hint_html': 'Fahre im Spiel über einen Gegenstand und drücke <kbd>deine Taste</kbd> für den Preis-Check. Öffne eine Karte, wähle Mods, dann <kbd>Suchen</kbd>.',
      'pc.price.queued': 'wartet',
      'pc.price.inQueue': 'in der Warteschlange',
      'pc.price.searching': 'suche…',
      'pc.price.priority': 'bevorzugt',
      'pc.price.rateLimited': 'Limit erreicht',
      'pc.price.searchesPaused': 'Suchen pausiert',
      'pc.price.noPrice': 'kein Preis',
      'pc.price.tryAgain': 'erneut versuchen',
      'pc.price.noData': 'keine Daten',
      'pc.price.marketValue': 'Marktwert',
      'pc.price.dataPoints': '{n} Datenpunkte',
      'pc.price.bulk': 'Menge',
      'pc.price.sellers': '{n} Verkäufer',
      'pc.price.listings': 'Angebote',
      'pc.price.listingsN': '{n} Angebote',
      'pc.price.medianTitle': 'Median — der typische Preis, unbeeindruckt von Ausreißern',
      'pc.price.tradeAsk': 'Trade-Preis: {value}',
      'pc.price.tradeAskTitle': 'Was Verkäufer am Handelsplatz VERLANGEN — die günstigsten Angebote dieser Suche, kein Preis, zu dem etwas verkauft wurde',
      'pc.price.tradeOnly': 'HANDEL',
      'pc.price.tradeOnlyTitle': 'Für diesen Gegenstand gibt es keinen Kurs im Währungsumschlag, also ist der Preis das Angebot des Handelsplatzes — Forderungen, unten einzeln aufgelistet',
      'pc.price.exchangeAge': 'Kurs ist {n} h alt',
      'pc.price.exchangeAgeTitle': 'Der Währungsumschlag veröffentlicht einen Auszug pro Stunde, und dieser Gegenstand wurde zuletzt in einer so alten Stunde gehandelt — der Kurs beschreibt also jene Stunde, nicht den Markt von jetzt. Das Fenster im Spiel kann abweichen. Wird nur angezeigt, wenn der Kurs älter ist, als dieses Werkzeug vermeiden kann; ab einer Grenze wird er verworfen und durch einen poe.ninja-Preis ersetzt.',
      'pc.price.exchangeRange': 'jene Stunde {low}–{high} c',
      'pc.price.exchangeRangeTitle': 'Tief und Hoch der EINEN Börsenstunde, aus der dieser Kurs stammt — nicht die Spanne der durchsuchten Stunden. Der Kurs oben ist der volumengewichtete Mittelwert jener Stunde.',
      'pc.price.conflictOver': 'Der Handelsplatz verlangt deutlich weniger als dieser Kurs (siehe Trade-Preis). Einer von beiden stimmt nicht — prüfe das, bevor du den Gegenstand mit dieser Zahl bewertest.',
      'pc.price.conflictUnder': 'Selbst das günstigste Angebot am Handelsplatz liegt um ein Vielfaches über diesem Kurs (siehe Trade-Preis). Der Kurs kann veraltet oder aus einer dünnen Stunde sein — prüfe das, bevor du zu dieser Zahl verkaufst.',
      'pc.price.conflictMark': ' — Angebote widersprechen',
      'pc.openNinja': 'poe.ninja öffnen ↗',
      'pc.openNinjaTitle': 'Diesen Gegenstand auf poe.ninja öffnen',
      'pc.openNinjaNone': 'Über poe.ninja bepreist — es lief keine Handelssuche',
      'pc.openTrade': 'Handel öffnen ↗',
      'pc.openTradeNone': 'Noch keine Handelssuche',
      'pc.openTradeTitle': 'Diese Suche auf pathofexile.com/trade öffnen',
      'pc.listings.more': '+ {n} weitere',
      'pc.listings.less': '− weniger zeigen',
      'pc.card.dismiss': 'Schließen',
      'pc.card.corrupted': 'Verderbt',
      'pc.card.matchMods': 'Mods wählen',
      'pc.card.tier': 'Tier {n}',
      'pc.ed.lead_html': 'Hake die geforderten Mods an und setze je Mod die Wertespanne (Min–Max). <b>Es läuft nichts, bis du auf Suchen drückst.</b>',
      'pc.ed.topTier': 'T2+',
      'pc.ed.topTierTitle': 'Nur die Mods anhaken, die Tier 1 oder 2 gerollt haben',
      'pc.ed.allMods': 'Alle Mods',
      'pc.ed.allModsTitle': 'Jeden Mod anhaken — nochmal klicken hebt alle wieder auf',
      'pc.ed.corrupted': 'Verderbt',
      'pc.ed.corruptAny': 'egal',
      'pc.ed.corruptYes': 'ja',
      'pc.ed.corruptNo': 'nein',
      'pc.ed.modOne': 'Mod',
      'pc.ed.modOther': 'Mods',
      'pc.ed.search': 'Suchen',
      'pc.ed.searching': 'Suche läuft…',
      'pc.ed.refreshes': 'aktualisiert die Preise',
      'pc.ed.reset': '↺ Zurücksetzen',
      'pc.ed.resetTitle': 'Spannen & Haken auf die Vorgaben dieses Gegenstands zurücksetzen',
      'pc.ed.notSearchable': 'nicht suchbar',
      'pc.ed.notSearchableTitle': 'Nicht in den mitgelieferten Handelsdaten — über Handel öffnen von Hand ergänzen',
      'pc.ed.fractured': 'frakturiert',
      'pc.ed.min': 'Minimum',
      'pc.ed.max': 'Maximum',
      'pc.group.links': 'Fassungen',
      'pc.group.unknown': 'Nicht suchbar',
      'pc.group.implicit': 'Implizit',
      'pc.group.fractured': 'Frakturiert',
      'pc.group.prefix': 'Präfixe',
      'pc.group.suffix': 'Suffixe',
      'pc.group.explicit': 'Explizit',
      'pc.group.crafted': 'Gefertigt',
      'rarity.normal': 'Normal',
      'rarity.magic': 'Magisch',
      'rarity.rare': 'Selten',
      'rarity.unique': 'Einzigartig',
      'rarity.currency': 'Währung',
      'rarity.gem': 'Edelstein',
      'rarity.divination': 'Weissagung',
      'rate.soft': 'Limit der Handels-API fast ausgeschöpft — Suchen pausieren möglicherweise gleich.',
      'rate.defaultMessage': 'Die Handels-API von GGG hat die App ausgebremst — Suchen pausieren.',
      'rate.retryIn': ' Erneuter Versuch in {wait}.',
      'rate.waitSec': '~{n}s',
      'rate.waitMin': '~{n}min',
      'rate.waitHour': '~{n}h',
      'rate.waitHourMin': '~{h}h {m}min',
      'ref.currency': 'Währung',
      'ref.lifeforce': 'Lebenskraft — Verkauf',
      'ref.beasts': 'Bestien',
      'ref.title': 'Referenz',
      'ref.noData': 'keine Daten',
      'ref.noSource': 'Kein Wert, also keine Quelle: keine belastbaren Verkaufsdaten für diese Zeile',
      'ref.valueFrom': 'Wert von {source}{when}',
      'ref.updatedAt': ' · aktualisiert {time}',
      'ref.updateUnknown': ' · Aktualisierungszeit unbekannt',
      'ref.footUpdated': 'aktualisiert {time}',
      'ref.footUnknown': 'Zeit unbekannt',

      'nw.heading': 'Vermögen',
      'nw.syncSettings': 'Sync-Einstellungen',
      'nw.building': 'Die Übersicht entsteht im Hintergrund — sie füllt sich von selbst.',
      'nw.toHistory': 'Verlauf →',
      'nw.overview': 'Überblick — nach Kategorie',
      'nw.viewList': 'Liste',
      'nw.viewGrouped': 'Gruppiert',
      'nw.stashHighlight': 'Stash-Hervorhebung',
      'nw.stashHighlightTitle': 'Macht aus der sichtbaren Auswahl einen Suchtext für das Suchfeld der Stash im Spiel',
      'nw.hlAria': 'Suchtext für das Suchfeld der Stash',
      'nw.hlCopy': 'Kopieren',
      'nw.hlCopied': 'kopiert',
      'nw.hlCtrlC': 'Strg+C',
      'nw.hlMaxBefore': 'max.',
      'nw.hlMaxAfter': 'Zeichen',
      'nw.hlMeta': '{used}/{total} Gegenstände · {len}/{max} Zeichen',
      'nw.hlNothing': 'nichts ausgewählt — passe die Filter an',
      'nw.hlDropped': '{n} passen nicht mehr hinein:',
      'nw.hlOvermatch': 'trifft zwangsläufig auch ähnliche Gegenstände:',
      'nw.hlWordGuard': 'warum der Platz ausging: {n} Fragmente sind länger, als die Namensliste allein verlangen würde, weil die kürzeren gewöhnliche englische Wörter sind — die Stash-Suche liest auch den Aromatext.',
      'nw.historySection': 'Verlauf',
      'nw.historyRow': '{when} — {div} Div ({chaos} c) · {league}',
      'nw.searchPlaceholder': 'Gegenstand suchen…',
      'nw.threshLabel': 'Gegenstände ausblenden unter',
      'nw.threshOff': 'Aus',
      'nw.threshDiv': '1 Div',
      'nw.stashTabs': 'Stash-Tabs',
      'nw.selAll': 'Alle',
      'nw.selNone': 'Keine',
      'nw.selValued': 'Nur mit Wert',
      'nw.selValuedTitle': 'Nur Tabs auswählen, die bepreiste Gegenstände über der Schwelle enthalten',
      'nw.resetOrder': 'Reihenfolge zurücksetzen',
      'nw.autosyncTitle': 'Ein Hintergrunddienst synchronisiert einen Stash-Tab nach dem anderen und bleibt unter dem Limit von GGG.',
      'nw.autosyncStarting': 'synchronisiert im Hintergrund',
      'nw.autosync': '{recent}/{total} Tabs in den letzten {windowMins} min synchronisiert · ältester Tab vor {mins} min synchronisiert',
      'nw.sideCount': '{on}/{total}',
      'nw.sideIgnored': ' · {n} ignoriert',
      'nw.noTabs': 'Noch keine Tabs mit bepreisten Gegenständen.',
      'nw.tabCounts': '{priced} bepreist · {unpriced} ohne Preis · {skipped} übersprungen',
      'nw.tabNothingArrived': 'aus diesem Tab kam nichts an',
      'nw.tabHintOn': 'wird gezählt. Klicken, um ihn auszuschließen.',
      'nw.tabHintOff': 'ausgeschlossen, aber Alle / Keine / Nur mit Wert können ihn wieder einschalten. Klicken, um ihn dauerhaft zu ignorieren.',
      'nw.tabHintIgnored': 'dauerhaft ignoriert — Alle / Keine / Nur mit Wert lassen ihn in Ruhe. Klicken, um ihn wieder zu zählen.',
      'nw.tabFallback': 'Tab #{n}',
      'nw.tabFallbackPlain': 'Tab',
      'nw.colItem': 'Gegenstand',
      'nw.colTab': 'Tab',
      'nw.colQty': 'Anz.',
      'nw.colEach': 'Stück',
      'nw.colTotal': 'Gesamt',
      'nw.colSource': 'Quelle',
      'nw.noMatch': 'Keine Gegenstände passen zu den gesetzten Filtern.',
      'nw.nothingPriced': 'noch nichts bepreist',
      'nw.groupCount': '{items} Einträge · {pcs} Stück',
      'nw.stat_html': '<b>{n}</b> Gegenstände sichtbar · <b>{value}</b>',
      'nw.statHidden': '{n} unter der Schwelle ausgeblendet',
      'nw.tradeTitle': 'Auf pathofexile.com/trade öffnen',
      'nw.unpriced': '{pcs} Stück ohne Preis in {names} {nameWord} (nicht gezählt)',
      // Dativ nach "in": Singular und Plural von "Name" lauten hier beide
      // "Namen". Der Schlüssel bleibt trotzdem zweiformig, weil tn() beide
      // Formen nachschlägt und eine fehlende ein harter Testfehler wäre.
      'nw.unpricedNameOne': 'Namen',
      'nw.unpricedNameOther': 'Namen',
      'nw.unpricedMore': ' · {n} Stück nicht aufgeführt',
      'nw.unpricedRow': '{name} ×{n} ({kind})',
      'kind.stackable': 'Währung & Stapelbares',
      'kind.unique': 'Unikate',
      'kind.divcard': 'Weissagungskarten',
      'kind.beast': 'Bestien',
      'kind.incubator': 'Inkubatoren',
      'kind.vial': 'Phiolen',
      'kind.gem': 'Edelsteine',
      'kind.corpse': 'Leichen',
      'kind.all': 'Alle',
      'nw.syncExpired': 'POESESSID abgelaufen — Hintergrund-Sync pausiert. Zum Erneuern die Einstellungen öffnen.',
      'nw.syncCooldown': 'Von GGG ausgebremst — der Sync läuft um {at} weiter.',
      'nw.syncCooldownOther': 'Ein anderer Nutzer wurde von GGG ausgebremst — der Sync pausiert für alle bis {at}.',
      'nw.syncTradeBan': 'Die Trade-API von GGG blockiert diese App — der Stash-Sync pausiert bis {at} mit.',
      'nw.syncSoon': 'gleich',
      'nw.syncMissing': 'Keine Zugangsdaten hinterlegt — zum Eintragen die Einstellungen öffnen.',
      'nw.setState.unknown': 'Hintergrund-Sync: Zustand unbekannt.',
      'nw.setState.expired': 'Der Hintergrund-Sync pausiert — die hinterlegte POESESSID ist abgelaufen. Trage unten eine neue ein.',
      'nw.setState.cooldown': 'Der Hintergrund-Sync wird von GGG ausgebremst und läuft um {at} weiter. Die Zugangsdaten sind in Ordnung.',
      'nw.setState.cooldownOther': 'Der Hintergrund-Sync pausiert bis {at}: GGG hat einen anderen hinterlegten Nutzer ausgebremst, und der Auffrischer hält für alle an. Deine Zugangsdaten sind in Ordnung.',
      'nw.setState.tradeBan': 'Der Hintergrund-Sync pausiert bis {at}: Die Trade-API von GGG blockiert diese App, und eine Sperre trifft die ganze Adresse — deshalb halten die Stash-Abrufe mit an. Deine Zugangsdaten sind in Ordnung, hier ist nichts zu ändern.',
      'nw.setState.missing': 'Für diesen Nutzer sind noch keine Zugangsdaten hinterlegt. Trage Kontonamen und POESESSID ein, damit der Sync startet.',
      'nw.setState.ok': 'Der Hintergrund-Sync läuft.',
      'nw.setLoading': 'Lädt…',
      'nw.setAccount': 'Kontoname',
      'nw.setSessid': 'POESESSID',
      'nw.setSessidPh': 'leer lassen, um die hinterlegte zu behalten',
      'nw.setSave': 'Speichern',
      'nw.setNote': 'Die hinterlegte POESESSID wird hier nie angezeigt — auch nicht maskiert. Zum Erneuern eine neue einfügen; ein leeres Feld behält den hinterlegten Wert. Das Speichern greift beim nächsten Hintergrund-Sync, ein Neustart ist nicht nötig.',
      'nw.setHint': 'Hinweis: dieser Wert hat {n} Zeichen — POESESSID-Cookies haben üblicherweise 32. Speichern ist trotzdem erlaubt.',
      'nw.saveFailedHttp': 'Speichern fehlgeschlagen (HTTP {status}).',
      'nw.saveFailedNet': 'Speichern fehlgeschlagen — Server nicht erreichbar.',

      'hi.heading': 'Verlauf',
      'hi.rangeAria': 'Zeitraum',
      'hi.chartAria': 'Vermögen über die Zeit',
      'hi.collecting': 'Sammle Daten…',
      'hi.whatMoved': 'Was sich bewegt hat',
      'hi.window': 'Dieser Ausschnitt',
      'hi.covRange': 'Zeitraum',
      'hi.covRecorded': 'Aufgezeichnet',
      'hi.covEvents': 'Ereignisse',
      'hi.covNet': 'Nettoänderung',
      'hi.covRate': 'C:D-Kurs',
      'hi.covRateVal': '{from} → {to} ({pct} %)',
      'hi.rateLine': 'Chaos pro Divine in diesem Ausschnitt — eigene Skala',
      'hi.unitInfoAria': 'Wie die Divine-Beträge gerechnet werden',
      'hi.unitInfoBtn': 'Divine-Beträge',
      'hi.unitInfo': 'Jeder Punkt wird mit dem C:D-Kurs umgerechnet, den er damals hatte, nie mit dem von heute — deshalb ändert sich die Vergangenheit nicht mehr, sobald sie aufgezeichnet ist. Das heißt auch: Die Kurve kann fallen, obwohl dein Bestand derselbe geblieben ist — wird der Divine teurer, sind dieselben Gegenstände weniger davon wert, und umgekehrt genauso. Ein Ausschnitt mit gestiegenem Chaos-Bestand kann deshalb trotzdem ein Netto-Verlust sein, wenn der Kurs schneller stieg als der Bestand. Die blasse Linie ist dieser Kurs, damit du beides auseinanderhalten kannst — dein Bestand oder der Markt.',
      'hi.minLabel': 'Als Ereignis zählen ab',
      'hi.minAll': 'allem Aufgezeichneten',
      'hi.minDiv05': '0,5 Div',
      'hi.minDiv1': '1 Div',
      'hi.minDiv3': '3 Div',
      'hi.minDiv10': '10 Div',
      'hi.covNote': 'Ereignisse sind Bestandsbewegungen — was hereinkam und was hinausging. Preisbewegungen stecken in der Kurve, nicht in der Liste.',
      'hi.evNoneInWindow': 'In diesem Ausschnitt kam nichts herein und ging nichts hinaus. Die Kurve bewegt sich trotzdem mit den Preisen.',
      'hi.evNoneRecorded': 'Für diesen Ausschnitt ist noch nichts aufgezeichnet.',
      'hi.evBarAll': 'alles Aufgezeichnete',
      'hi.evBarFrom': 'ab {n} Div',
      'hi.evNote': '{n} {word} · nur Bestandsbewegungen · {bar}',
      'hi.eventOne': 'Ereignis',
      'hi.eventOther': 'Ereignisse',
      'hi.headSum_html': 'jetzt <b>{now}</b> · Bestand bewegt {moved}',
      'hi.agoSec': 'vor {n}s',
      'hi.agoMin': 'vor {n} min',
      'hi.agoHour': 'vor {n}h',
      'hi.spanMin': '{n} min',
      'hi.spanHour': '{n}h',

      'set.heading': 'Einstellungen',
      'set.saved': 'gespeichert',
      'lang.title': 'Sprache des Spiel-Clients',
      'lang.lead': 'Wähle die Sprache, in der dein Spiel läuft — die Sprache des Gegenstandstexts, den du kopierst. Das ist keine Einstellung für die Sprache dieser Website; die Seiten richten sich zwar danach, aber das ist nur eine Nebenwirkung. Steht hier das Falsche, wird dein Gegenstand nicht falsch bepreist, sondern gar nicht erkannt: hier taucht keine Karte auf, und das Spiel sagt dir dazu nichts.',
      'lang.label': 'Sprache deines Spiel-Clients',
      'lang.onlyOne': 'Dieser Server hat nur eine Sprache geladen, es gibt also nichts umzuschalten. Eine zweite muss erst auf dem Server erzeugt werden.',
      'lang.notPersisted': 'Dieser Server kann sein /config-Volume nicht beschreiben: deine Wahl gilt jetzt, ist aber beim nächsten Neustart des Servers wieder weg.',
      'lang.failedHttp': 'Die Sprache konnte nicht geändert werden (HTTP {status}).',
      'lang.failedNet': 'Die Sprache konnte nicht geändert werden — Server nicht erreichbar.',
      'lang.name.en': 'Englisch',
      'lang.name.de': 'Deutsch',
      'set.adminTitle': 'Admin-Bereich',
      'set.adminLead': 'Für den, der den Server betreibt: die Einstellungen, die diese Installation im laufenden Betrieb ändern kann, ein Neustart-Knopf, und was das Werkzeug nicht konnte — Texte, an denen das Parsen scheiterte, Mod-Zeilen ohne Auflösung, und wie weit ein übersetzter Datensatz hinter dem englischen zurückliegt. Zum Spielen braucht man hiervon nichts.',
      'set.adminGateNote': 'Ein Klartext-Passwort aus einer Datei auf dem Server (Vorgabe: admin). Das ist eine Trennwand, kein Sicherheitsmechanismus — es hält den normalen Nutzer aus einer Ansicht heraus, die ihn nichts angeht.',
      'set.adminPassword': 'Admin-Passwort',
      'set.adminOpen': 'Öffnen',
      'set.adminClose': 'Schließen',
      'set.adminReload': 'Neu laden',
      'set.adminWrong': 'Falsches Passwort.',
      'set.adminFailedHttp': 'Der Admin-Bereich konnte nicht geladen werden (HTTP {status}).',
      'set.adminFailedNet': 'Der Admin-Bereich konnte nicht geladen werden — Server nicht erreichbar.',
      'adm.gapsTitle': 'Lücken, die das Werkzeug selbst gefunden hat',
      'adm.gapsNote': 'Beim Preis-Check gesammelt, nach Sprache getrennt und nach Häufigkeit sortiert. Nur im Arbeitsspeicher: nach einem Neustart ist die Liste leer. Und es ist eine Seite, die man aufrufen muss — das Werkzeug meldet sich nicht von selbst.',
      'adm.parse': 'Fehlgeschlagene Parses',
      'adm.parseNote': 'Die Engine hat den Text aus der Zwischenablage abgelehnt. Im Browser ist nie eine Karte erschienen.',
      'adm.unknownMod': 'Unaufgelöste Mod-Zeilen',
      'adm.unknownModNote': 'Der Gegenstand wurde geparst, aber diese Zeile traf weder den mitgelieferten Datensatz noch den Stat-Katalog von GGG. Die Karte zeigt sie nur lesend, die Suche übergeht sie — der Preis ist damit der Preis eines anderen Gegenstands.',
      'adm.none': 'Nichts aufgezeichnet.',
      'adm.langSection': 'Sprache: {lang}',
      'adm.colCount': 'Anzahl',
      'adm.colText': 'Text',
      'adm.colReason': 'Grund',
      'adm.colLast': 'Zuletzt',
      'adm.sample': 'Auslösender Text',
      'adm.dropped': '{n} seltenere Einträge wurden verworfen — die Liste ist auf {max} je Art begrenzt.',
      'adm.skewTitle': 'Datensatz-Versatz zwischen den Sprachen',
      'adm.skewNote': 'Jede Zeile misst einen übersetzten Datensatz an {base} — der ist der Maßstab, weil der übersetzte Satz als Kopie davon entsteht. Ab {pct} wird eine Zeile zur Warnung.',
      'adm.skewOk': 'Kein Versatz oberhalb der Schwelle.',
      'adm.skewWarn': '{lang} hängt hinter {base}.',
      'adm.skewAbsent': 'Für {lang} gibt es überhaupt keinen Datensatz — Gegenstände in dieser Sprache können nicht geparst werden.',
      'adm.skewBaseAbsent': 'Der Datensatz {base} war nicht lesbar — ein Vergleich ist nicht möglich.',
      'adm.skewExtra': '{n} Einträge gibt es nur in {lang} und ohne Entsprechung in {base}. Nach der Bauweise des Satzes müsste diese Zahl null sein.',
      'adm.metric.items': 'Gegenstandsnamen',
      'adm.metric.stats': 'Stat-Einträge',
      'adm.metric.matchers': 'Stats ohne Matcher',
      'adm.metric.advanced': 'Erweiterte Modbeschreibungen',
      'adm.metricRow': '{missing} von {base} fehlen ({pct})',
      'adm.langsConfigured': 'Konfiguriert: {list}',
      'adm.langsLive': 'Aktive Parser-Instanzen: {list}',
      // ---- Admin: Herkunft des übersetzten Datensatzes -------------------------
      'adm.buildTitle': 'Woher der übersetzte Datensatz stammt',
      'adm.buildNote': 'Ausgelesen aus dem Datensatz, den der Container gerade ausliefert. Leere Zahlen heißen: der Satz ist älter als diese Buchführung — nicht, dass nichts übersetzt wurde.',
      'adm.buildNoLangs': 'Diese Installation erzeugt keinen eigenen Datensatz — Englisch kommt vom Upstream.',
      'adm.buildAbsent': 'Für {lang} gibt es noch keinen Datensatz, also auch keine Herkunft.',
      'adm.buildNoRun': 'Dieser Satz entstand, bevor die Laufzahlen mitgeschrieben wurden. Der nächste Lauf trägt sie nach.',
      'adm.buildUnknown': 'unbekannt',
      'adm.buildFirstBuild': 'Erstaufbau, kein Vorgänger',
      'adm.buildAt': 'Erzeugt',
      'adm.buildPatch': 'Aus Spiel-Patch',
      'adm.buildCovered': 'Stats mit Matcher',
      'adm.buildCoveredValue': '{covered} von {base} — {gap} ohne',
      'adm.buildRegressed': 'Gegenüber dem vorherigen Satz verloren',
      'adm.buildRegressedValue': '{n} von {base}',
      'adm.buildNewGaps': 'Neu ohne Matcher (der vorherige Satz hatte dort auch keinen)',
      'adm.buildItems': 'Gegenstandsnamen',
      'adm.buildItemsValue': '{translated} von {base} übersetzt, {kept} englisch belassen',
      'adm.buildUnknownNamespace': 'Für den Gegenstands-Namensraum {namespace} gibt es überhaupt keine Namensquelle — seine {n} Einträge bleiben englisch, und keine andere Zahl auf dieser Seite zeigt das an.',
      'adm.stringsOk': 'Die Anzeigetexte von {lang} tragen dieselben {n} Schlüssel wie der englische Satz.',
      'adm.stringsMissing': 'Die englischen Anzeigetexte haben {n} Schlüssel, die {lang} nicht hat: {keys}. Jeder davon, den der Parser liest, fehlt in dieser Sprache. Diese Dateien sind handgeschrieben und kommen mit dem Image — das schließt ein Container-Update, keine Datenaktualisierung.',
      'adm.stringsExtra': '{lang} hat {n} Schlüssel, die der englische Satz nicht mehr hat: {keys}. Übrig aus einem älteren Upstream — sie werden von nichts mehr gelesen.',
      'adm.stringsUnreadable': 'Die Anzeigetexte von {lang} waren nicht lesbar ({why}), die beiden Sätze wurden deshalb nicht verglichen.',
      'adm.stringsAt': 'Verglichen bei der letzten Übernahme des englischen Satzes, {at}.',
      'cfg.title': 'Server-Einstellungen',
      'cfg.note': 'Die Einstellungen, die diese Installation im laufenden Betrieb ändern kann. Sie landen in einer Datei im /config-Volume, und diese Datei gewinnt gegen die Werte, mit denen der Container gestartet wurde. Nichts Geheimes lässt sich hier setzen oder lesen.',
      'cfg.path': 'Gespeichert in {path}',
      'cfg.groupLive': 'Wirkt sofort',
      'cfg.groupRestart': 'Braucht einen Neustart',
      'cfg.trafficTitle': 'Wie oft dieses Werkzeug fremde Server anfragt',
      'cfg.trafficNote': 'Diese Werte entscheiden, wie viel Verkehr die Hintergrundjobs an die Trade-API, an poe.ninja, an GGGs Exchange-Feed und an die Datenquellen schicken. Sie stehen für sich, weil einen davon hochzudrehen etwas anderes ist als die Kopfzeile umzubenennen: Die Trade-API beantwortet eine Anfragerate, die ihr nicht passt, mit einem Rate-Limit, und dieses Werkzeug ist zweimal für das gesperrt worden, was danach kam. Die Vorgabewerte sind die, mit denen es nachweislich läuft, und jede Zeile sagt, welche Richtung mehr Anfragen erzeugt.',
      'cfg.trafficLower': 'Kleinere Werte erzeugen mehr Anfragen.',
      'cfg.trafficHigher': 'Größere Werte erzeugen mehr Anfragen.',
      'cfg.trafficOffMore': 'Ausgeschaltet erzeugt es mehr Anfragen.',
      'cfg.trafficOnMore': 'Eingeschaltet erzeugt es mehr Anfragen.',
      'cfg.colSetting': 'Einstellung',
      'cfg.colValue': 'Wert',
      'cfg.colSource': 'Woher der Wert kommt',
      'cfg.source.override': 'hier auf dieser Seite gesetzt',
      'cfg.source.env': 'aus der Compose-Datei des Servers',
      'cfg.source.default': 'eingebauter Vorgabewert',
      'cfg.defaultIs': 'Vorgabe: {value}',
      'cfg.defaultUnset': 'standardmäßig nicht gesetzt',
      'cfg.boolOn': 'an',
      'cfg.boolOff': 'aus',
      'cfg.shadowsEnv': 'Das gewinnt gegen die Compose-Datei, in der hier {value} steht. An Compose zu drehen ändert für diese Einstellung nichts, solange der Wert auf dieser Seite nicht zurückgesetzt ist.',
      'cfg.invalid': 'In der gespeicherten Datei steht für diese Einstellung ein unerlaubter Wert, der nichts bewirkt — angezeigt ist der tatsächlich geltende Wert. {why}',
      'cfg.rowPending': 'gespeichert — wirkt nach einem Neustart',
      'cfg.pending': 'Einige Einstellungen sind gespeichert, aber noch nicht in Kraft. Dafür braucht es einen Neustart.',
      'cfg.reset': 'Zurücksetzen',
      'cfg.resetTitle': 'Den hier gesetzten Wert entfernen und zurück auf die Compose-Datei oder den eingebauten Vorgabewert fallen',
      'cfg.saved': 'gespeichert',
      'cfg.saveFailed': 'Nicht gespeichert: {error}',
      'cfg.saveFailedNet': 'Nicht gespeichert — Server nicht erreichbar.',
      'cfg.quarantineTitle': 'Die gespeicherten Einstellungen wurden verworfen',
      'cfg.quarantineBody': 'Mehrere Starts hintereinander sind mit den Einstellungen von dieser Seite nicht hochgekommen. Sie wurden nach {path} beiseitegelegt und sind NICHT in Kraft — der Server läuft mit seiner Compose-Datei und den eingebauten Vorgabewerten. Sieh in diese Datei, bevor du etwas davon zurückholst.',
      'cfg.problemsTitle': 'Probleme mit der Einstellungsdatei',
      'cfg.pwDefaultTitle': 'Das Admin-Passwort ist noch das voreingestellte',
      'cfg.pwDefaultBody': 'Es steht im öffentlichen Repository dieses Werkzeugs, und es ist das Einzige, was zwischen jedem in diesem Netz und dem Neustart-Knopf weiter unten, den Einstellungen für den nächsten Start und dieser Diagnoseansicht steht. Ändere es in der Passwortdatei auf dem Server (POE_ADMIN_PASSWORD_FILE, standardmäßig /config/admin-password) — eine Klartextzeile, wirkt beim nächsten Klick, ohne Neustart.',
      'cfg.restartTitle': 'Neustart',
      'cfg.restartBtn': 'Jetzt neu starten',
      'cfg.checkNowTitle': 'Datenquellen prüfen',
      'cfg.checkNowBtn': 'Jetzt prüfen',
      'cfg.checkNowNote': 'Die Datenquellen werden einmal am Tag geprüft — eine hier gespeicherte Einstellung, allen voran die Patch-Version, zeigt also normalerweise erst bei der nächsten Prüfung Wirkung. Das hier führt diese Prüfung sofort aus; so erfährt man, ob eine Reparatur gegriffen hat, statt darauf zu warten. Umsonst ist das nicht: es fragt die Patch-Version ab, holt jede Upstream-Datei erneut und baut den lokalisierten Datensatz neu, wenn etwas veraltet ist — dabei werden Spieldaten vom Patch-CDN geladen. Deshalb bleibt der Knopf danach eine Weile gesperrt (POE_DATA_CHECK_NOW_COOLDOWN_MS weiter oben).',
      'cfg.checkNowRunning': 'Wird geprüft …',
      'cfg.checkNowDone': 'Prüfung abgeschlossen — die Statuszeile oben ist aktuell.',
      'cfg.checkNowBusy': 'Es läuft bereits eine Prüfung. Ihr Ergebnis erscheint von selbst in der Statuszeile.',
      'cfg.checkNowCooldown': 'Gerade eben lief eine Prüfung. Wieder möglich in {sec} Sekunden.',
      'cfg.checkNowFailed': 'Der Server war nicht erreichbar.',
      'cfg.checkNowFailedHttp': 'Der Server hat die Prüfung abgelehnt (HTTP {status}).',
      'cfg.restartNote': 'Der Container hält an und wird von seiner Aufsicht wieder gestartet — normalerweise nach etwa {sec} Sekunden zurück, vorausgesetzt der Container hat eine Restart-Policy. Alles, was in dem Moment läuft, bricht ab: der Hintergrund-Sync der Stash, jede laufende Suche, und jede offene Seite muss sich neu verbinden.',
      'cfg.restartConfirm': 'Den Server jetzt neu starten? Laufende Stash-Syncs und Suchen brechen ab, und jede offene Seite verliert für einen Moment die Verbindung. Von selbst kommt er nur zurück, wenn dieser Container mit einer Restart-Policy gestartet wurde (restart: unless-stopped in der mitgelieferten docker-compose.yml). Ohne die bleibt das Werkzeug aus, bis es jemand auf dem Host wieder startet — und diese Seite ist dann nicht mehr da, um es rückgängig zu machen.',
      'cfg.restarting': 'Neustart läuft — warte darauf, dass der Server wieder antwortet…',
      'cfg.restartBack': 'Der Server ist wieder da.',
      'cfg.restartGone': 'Der Server hat seit {sec} Sekunden nicht geantwortet. Der wahrscheinlichste Grund: es hat ihn nichts wieder gestartet — ein Container ohne Restart-Policy bleibt unten. Starte ihn auf dem Host (docker compose up -d, oder wie diese Installation eben gestartet wird) und gib ihm restart: unless-stopped, damit der Knopf beim nächsten Mal funktioniert.',
      'cfg.restartGoneEarlier': 'Ein früherer Neustart von dieser Seite ist nicht von selbst zurückgekommen — jemand musste das Werkzeug wieder starten. Das heißt, dieser Container hat keine Restart-Policy; ergänze restart: unless-stopped, oder rechne damit, es nach jedem Druck auf diesen Knopf von Hand starten zu müssen.',
      'cfg.restartFailedHttp': 'Der Neustart konnte nicht ausgelöst werden (HTTP {status}).',
      'cfg.restartFailedNet': 'Der Neustart konnte nicht ausgelöst werden — Server nicht erreichbar.',
      'cfg.runtimeTitle': 'Womit dieser Server sonst noch läuft',
      'cfg.runtimeNote': 'Nur zum Lesen. Diese Werte kommen aus der Compose-Datei oder sind Tatsachen über den laufenden Prozess; keiner davon lässt sich hier ändern. Die Liste gibt es, damit niemand dafür eine Shell auf dem Server öffnen muss.',
      'cfg.failedHttp': 'Die Server-Einstellungen konnten nicht geladen werden (HTTP {status}).',
      'cfg.failedNet': 'Die Server-Einstellungen konnten nicht geladen werden — Server nicht erreichbar.',

      // ---- der Update-Knopf (host-update.mjs + deploy/host-update.sh) -----------
      'upd.title': 'Auf eine neuere Version aktualisieren',
      'upd.note': 'Holt den neuesten Code auf dem Server und baut den Container neu. Dafür braucht es ein kleines Skript auf dem Host — das Werkzeug kann das nicht selbst und hat bewusst keinen Zugriff auf den Docker-Daemon des Hosts.',
      'upd.btn': 'Jetzt aktualisieren',
      'upd.build': 'Dieser Container wurde aus Commit {commit} gebaut.',
      'upd.buildUnknown': 'Dieser Container weiß nicht, aus welchem Commit er gebaut wurde: dem Build wurde es nicht gesagt. Gib BUILD_COMMIT beim Bauen mit (siehe docs/admin.md), dann kann das nächste Image die Frage beantworten.',
      'upd.notInstalled': 'Auf dem Host ist kein Update-Skript eingerichtet, dieser Knopf hätte also niemanden, der ihn erhört. Installiere deploy/host-update.sh aus dem Repository auf der Maschine, die Docker betreibt, und lass es alle paar Minuten laufen (Unraid User Scripts, Cron oder ein systemd-Timer) — docs/admin.md, „Update-Knopf". Das Werkzeug kann ein nie installiertes Skript nicht von einem entfernten unterscheiden und behauptet deshalb auch nicht, welcher von beiden Fällen hier vorliegt.',
      'upd.installedAt': 'Das Update-Skript des Hosts hat sich zuletzt um {at} gemeldet.',
      'upd.stuck': 'Das Update-Skript auf dem Host hängt fest, und es wird nichts aktualisiert, bis das jemand aufräumt. Ein Lauf, der nie fertig geworden ist, hält seine Sperre seit {at} — länger, als ein Build dauern kann, der Lauf selbst ist also weg (ein Neustart mitten im Build macht genau das). Auf dem Host aufräumen: es ist das leere Verzeichnis update.lock im Arbeitsverzeichnis des Skripts, neben dem Config-Verzeichnis. docs/admin.md, „Update-Knopf", schreibt es aus.',
      'upd.stuckNoTime': 'Das Update-Skript auf dem Host hängt fest, und es wird nichts aktualisiert, bis das jemand aufräumt. Ein Lauf, der nie fertig geworden ist, hält seine Sperre — länger, als ein Build dauern kann, der Lauf selbst ist also weg (ein Neustart mitten im Build macht genau das). Auf dem Host aufräumen: es ist das leere Verzeichnis update.lock im Arbeitsverzeichnis des Skripts, neben dem Config-Verzeichnis. docs/admin.md, „Update-Knopf", schreibt es aus.',
      'upd.outNote': 'Ausgabe des Hosts. Zeilen, die etwas benennen, das ein Zugangsdatum sein könnte, werden entfernt, und Zugangsdaten in einer URL werden maskiert — das ist aber ein Filter und keine Garantie: ein nacktes Token in einer Zeile, die nichts benennt, geht glatt durch. Lies das als Text, in dem trotzdem eines stehen kann.',
      'upd.confirm': 'Jetzt aktualisieren? Der Host holt den neuesten Code und baut das Image neu. Das dauert deutlich länger als ein Neustart — mehrere Minuten — und das Werkzeug ist einen Teil davon weg: laufende Stash-Syncs und Suchen brechen ab, jede offene Seite verliert die Verbindung. Von dieser Seite aus lässt sich das nicht mehr anhalten, sobald der Host es aufgegriffen hat.',
      'upd.requested': 'Um {at} angefordert — wartet darauf, dass das Host-Skript sie aufgreift. Es läuft alle paar Minuten, danach dauert der Build selbst noch eine Weile.',
      'upd.pending': 'Um {at} wurde ein Update angefordert, und der Host hat sich noch nicht zurückgemeldet.',
      'upd.working': 'Der Host arbeitet. Diese Seite meldet sich von selbst, wenn der Build durch ist.',
      'upd.doneCommit': 'Aktualisiert. Läuft jetzt auf Commit {commit}.',
      'upd.done': 'Aktualisiert.',
      'upd.failed': 'Der Host hat es versucht und ist gescheitert. Unten steht das Ende dessen, was er ausgegeben hat.',
      'upd.timeout': 'Seit {min} Minuten kommt nichts zurück. Entweder läuft das Host-Skript nicht (dann liegt die Anforderung noch im Config-Volume und wartet), oder der Build ist so gründlich gescheitert, dass er kein Ergebnis mehr geschrieben hat. Sieh in die Datei update-result im Config-Volume und in das Log des Skripts auf dem Host.',
      'upd.failedHttp': 'Das Update konnte nicht angefordert werden (HTTP {status}).',
      'upd.failedNet': 'Das Update konnte nicht angefordert werden — Server nicht erreichbar.',
      'upd.lastOk': 'Letztes Update {at}: erfolgreich.',
      'upd.lastFailed': 'Letztes Update {at}: FEHLGESCHLAGEN.',
      'upd.lastUnknown': 'Letztes Update {at}: der Host hat ein Ergebnis hinterlassen, das nicht sagt, wie es ausging.',
      'upd.statusFailedHttp': 'Der Update-Status konnte nicht geladen werden (HTTP {status}).',
      'upd.statusFailedNet': 'Der Update-Status konnte nicht geladen werden — Server nicht erreichbar.',

      // ---- Releases block (settings page) ---------------------------------------
      'rel.title': 'Versionen',
      'rel.installed': 'Installiert: {version}',
      'rel.installedUnknown': 'Installiert: unbekannt (der Server kann seine eigene Version nicht lesen)',
      'rel.latest': 'Neueste Version: {version} ({date})',
      'rel.latestNone': 'Noch keine Version veröffentlicht',
      'rel.latestNotChecked': 'Noch nicht geprüft',
      'rel.latestUnknown': 'Unbekannt — die letzte Prüfung hat keine Antwort bekommen',
      'rel.link': 'Seite der Version',
      'rel.lastCheck': 'Letzte Prüfung {when}: {outcome}',
      'rel.outcome.ok': 'Version gefunden',
      'rel.outcome.none': 'noch keine Version veröffentlicht',
      'rel.outcome.unchanged': 'nichts Neues',
      'rel.outcome.failed': 'fehlgeschlagen',
      'rel.advice.unreachable': 'GitHub war nicht erreichbar.',
      'rel.advice.rejected': 'GitHub hat die Anfrage abgelehnt, meist wegen seines Anfragelimits.',
      'rel.advice.incompatible': 'Die Antwort von GitHub war nicht lesbar; der Tag der neuesten Version ist vielleicht keine Versionsnummer.',
      'rel.advice.unknown': 'Die Prüfung ist aus einem nicht eingeordneten Grund fehlgeschlagen.',
      'rel.adviceNext': 'Die nächste automatische Prüfung ist in 24 Stunden.',
      'rel.adviceNextAt': 'Die nächste automatische Prüfung ist am {when}.',
      'rel.adviceReason': 'Grund: {reason}',
      'rel.autoOff': 'Die automatische Prüfung ist abgeschaltet; der Knopf darunter funktioniert weiterhin.',
      'rel.pointer_html': 'Den Server aktualisiert, wer ihn betreibt (<a href="https://github.com/{repo}/blob/main/docs/admin.md#update-procedure">Update-Ablauf</a>). Der Hotkey-Daemon jedes Spielers ist ein eigener Klon und wird auf dessen Rechner aktualisiert (<a href="https://github.com/{repo}/blob/main/README.md#setting-up-the-hotkey">Hotkey einrichten</a>).',
      'rel.checkTitle': 'Nach einer neueren Version suchen',
      'rel.checkNote': 'Fragt jetzt bei GitHub nach, ob es eine neuere Version dieses Tools gibt. Es meldet nur; es wird nichts heruntergeladen oder installiert. Das funktioniert, egal ob die tägliche automatische Prüfung eingeschaltet ist.',
      'rel.checkBtn': 'Nach Updates suchen',
      'rel.checking': 'Prüfe…',
      'rel.resultUpToDate': 'Auf dem neuesten Stand.',
      'rel.resultNewer': '{version} ist verfügbar.',
      'rel.resultNone': 'Es wurde noch keine Version veröffentlicht.',
      'rel.resultUnknown': 'Die neueste Version ist {version}; die installierte Version ist unbekannt, ein Vergleich ist nicht möglich.',
      'rel.resultRunning': 'Eine Prüfung läuft bereits. Ihr Ergebnis erscheint hier von selbst.',
      'rel.resultCooldown': 'Nochmal versuchen in {seconds} s.',
      'rel.resultUnauthorized': 'Das Admin-Passwort wurde nicht akzeptiert.',
      'rel.resultHttp': 'Prüfung fehlgeschlagen: HTTP {status}',
      'rel.resultNet': 'Prüfung fehlgeschlagen: der Server war nicht erreichbar.',

      'srv.Linked sockets': 'Verbundene Fassungen',
      'srv.market rate': 'Marktkurs',
      'srv.fallback': 'Ersatzwert',
      'srv.Unknown': 'Unbekannt',
      "srv.GGG's trade API rate-limited the app — searches are paused (retry-after). Common at league launch under heavy load.":
        'Die Handels-API von GGG hat die App ausgebremst — Suchen pausieren (Retry-After). Bei Liga-Start unter Last üblich.',
      'fact.Quality': 'Qualität',
      'fact.Item Level': 'Gegenstandsstufe',
      'fact.Level': 'Stufe',
      'fact.Base Percentile': 'Basis-Perzentil',
      'fact.anyPriced': '(beliebig bepreist)',

      // Wording taken from data/de/client_strings.js (ARMOUR, EVASION,
      // ENERGY_SHIELD, TAG_WARD, BLOCK_CHANCE, MEMORY_STRANDS, CRIT_CHANCE,
      // ATTACK_SPEED, MAP_*, HEIST_JOB_*, HEIST_TARGET_PRICELESS) — the same
      // words the German client puts on the item itself.
      'flt.Armour: #': 'Rüstung: #',
      'flt.Evasion Rating: #': 'Ausweichwert: #',
      'flt.Energy Shield: #': 'Energieschild: #',
      'flt.Ward: #': 'Schutz: #',
      'flt.Block: #%': 'Chance auf Blocken: #%',
      'flt.Base Percentile: #%': 'Basis-Perzentil: #%',
      'flt.Memory Strands: #': 'Erinnerungsstränge: #',
      // DPS is the engine's own arithmetic, not a client string — the German
      // trade community reads it as DPS too, so only the qualifier moves.
      'flt.Total DPS: #': 'Gesamt-DPS: #',
      'flt.Elemental DPS: #': 'Elementar-DPS: #',
      'flt.Physical DPS: #': 'Physischer DPS: #',
      'flt.Attacks per Second: #': 'Angriffe pro Sekunde: #',
      'flt.Critical Strike Chance: #%': 'Kritische Trefferchance: #%',
      'flt.Item Quantity: +#%': 'Gegenstandsmenge: +#%',
      'flt.Item Rarity: +#%': 'Gegenstandsseltenheit: +#%',
      'flt.Monster Pack Size: +#%': 'Monstergruppengröße: +#%',
      'flt.Heist Target: Priceless': 'Auftragsziel: Unbezahlbar',
      'flt.1 Empty or Crafted Modifier': '1 leerer oder gefertigter Modifikator',
      'flt.item.heist_job_lockpicking': 'Schlossknacken: #',
      'flt.item.heist_job_bruteforce': 'Brachialgewalt: #',
      'flt.item.heist_job_perception': 'Wahrnehmung: #',
      'flt.item.heist_job_demolition': 'Sprengung: #',
      'flt.item.heist_job_counterthaumaturgy': 'Thaumaturgie-Abwehr: #',
      'flt.item.heist_job_trapdisarmament': 'Fallenentschärfung: #',
      'flt.item.heist_job_agility': 'Agilität: #',
      'flt.item.heist_job_deception': 'Täuschung: #',
      'flt.item.heist_job_engineering': 'Ingenieurwesen: #'
    }
  }

  // Number/date formatting follows the language, not the browser: the same page
  // must not print "1,234.5" for one user and "1.234,5" for the other only
  // because their systems differ.
  const LOCALES = { en: 'en-US', de: 'de-DE' }

  // ---- state ----------------------------------------------------------------
  let lang = DEFAULT_LANG
  const listeners = []
  // Runtime warning only, NOT the proof of completeness: it can only fire where
  // the key-coverage test would already have failed. A hardcoded English text
  // never reaches this counter — that is what the grep stage is for.
  const missing = new Map()

  function readCookie (name) {
    if (typeof document === 'undefined') return null
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : null
  }

  function cachedLangFor (user) {
    if (!user) return null
    try { return localStorage.getItem(LANG_CACHE_PREFIX + user) } catch { return null }
  }
  function cacheLangFor (user, l) {
    if (!user) return
    try { localStorage.setItem(LANG_CACHE_PREFIX + user, l) } catch { /* private mode */ }
  }

  function known (l) { return Object.prototype.hasOwnProperty.call(STRINGS, l) }

  // ---- lookup -----------------------------------------------------------------
  function fill (tpl, params) {
    if (!params) return tpl
    return tpl.replace(/\{(\w+)\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m)
  }

  function t (key, params) {
    const table = STRINGS[lang] || STRINGS[DEFAULT_LANG]
    let tpl = table[key]
    if (tpl == null) {
      missing.set(key, (missing.get(key) || 0) + 1)
      tpl = STRINGS[DEFAULT_LANG][key]
      if (tpl == null) return key
    }
    return fill(tpl, params)
  }

  // Plural pick: `base` + 'One'/'Other'. Two forms are enough for both
  // languages this tool ships.
  function tn (base, n, params) {
    return t(base + (Number(n) === 1 ? 'One' : 'Other'), params)
  }

  // A text the SERVER produced and the page renders as-is. Unknown text passes
  // through unchanged — an English line is better than an empty card.
  function srv (text) {
    if (text == null || text === '') return text
    const key = 'srv.' + text
    const table = STRINGS[lang] || STRINGS[DEFAULT_LANG]
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : text
  }

  // Card facts arrive as "Label: value" / "Label: value (any priced)".
  // Only the label and the trailing note are translatable; the rest is data.
  function fact (text) {
    const s = String(text == null ? '' : text)
    const i = s.indexOf(': ')
    if (i < 0) return s
    const label = s.slice(0, i)
    const table = STRINGS[lang] || STRINGS[DEFAULT_LANG]
    const key = 'fact.' + label
    if (!Object.prototype.hasOwnProperty.call(table, key)) return s
    let rest = s.slice(i + 2)
    const anyEn = STRINGS[DEFAULT_LANG]['fact.anyPriced']
    if (rest.endsWith(anyEn)) rest = rest.slice(0, -anyEn.length) + t('fact.anyPriced')
    return `${table[key]}: ${rest}`
  }

  // A filter row's label, invented by the vendored engine rather than taken
  // from the data set (see the flt.* block above). Same contract as srv():
  // known text is replaced, everything else passes through untouched — which
  // is what keeps a real, already localized mod line out of this path.
  //
  // The WHOLE text is the key here, not just a label half as in fact(): these
  // strings carry a `#` where the roll goes and the substitution happens after
  // this call, so splitting them would only invent a second parser.
  function filterLabel (text) {
    if (text == null || text === '') return text
    const key = 'flt.' + text
    const table = STRINGS[lang] || STRINGS[DEFAULT_LANG]
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : text
  }

  // ---- item names ------------------------------------------------------------
  // Item names are not in the string table and never will be: there are
  // thousands, they come out of the game data, and the tool already has both
  // spellings of every one of them (data/<lang>/items.ndjson carries the
  // localized `name` beside the English `refName`). The server serializes that
  // pair table for THIS user's language; here it is applied, and only here.
  //
  // The rule this whole path exists to keep: translate where a name is
  // RENDERED, never where one is matched. Trade links, the value join and every
  // price source keep the English name they are keyed by — itemName() hands out
  // a display string and nothing else.
  let itemNames = null      // Map(refName -> localized name), null while unloaded
  let itemNamesLang = null  // the language the loaded table belongs to
  let itemNamesPending = false

  // The localized name for an English reference name, or NULL when there is
  // none — deliberately not the input, so a caller has to spell out its own
  // fallback and an unresolvable name visibly stays English instead of turning
  // into a placeholder or an empty cell.
  function itemName (ref) {
    // Identity for the primary language: a branch taken before any lookup
    // exists, the same guarantee the server's englishCorpseName gives.
    if (lang === DEFAULT_LANG || !itemNames || ref == null) return null
    return itemNames.get(String(ref)) || null
  }

  // For tests and for a page that already holds the table.
  function setItemNames (names) {
    itemNames = names ? new Map(Object.entries(names)) : null
    itemNamesLang = itemNames ? lang : null
  }

  // Fetched once per language, from the endpoint that reads the same snapshot
  // the engine parses with. English never asks at all. When the table arrives
  // the pages redraw through the SAME channel a language switch uses, so no
  // page needs to know this exists.
  function loadItemNames () {
    if (lang === DEFAULT_LANG) return
    if (itemNamesLang === lang || itemNamesPending) return
    if (typeof fetch !== 'function') return
    itemNamesPending = true
    const forLang = lang
    fetch('/item-name-map', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        itemNamesPending = false
        if (!j || j.lang !== forLang || forLang !== lang || !j.names) return
        itemNames = new Map(Object.entries(j.names))
        itemNamesLang = forLang
        for (const fn of listeners) { try { fn(lang) } catch { /* one page must not break the others */ } }
      })
      .catch(() => { itemNamesPending = false }) // no table -> English names, as before
  }

  function locale () { return LOCALES[lang] || LOCALES[DEFAULT_LANG] }

  // ---- DOM ---------------------------------------------------------------------
  // Static page text carries its key as a data attribute; the English wording in
  // the HTML is the built-in default (and what the shell tests read).
  const DOM_ATTRS = [
    ['data-i18n', (el, s) => { el.textContent = s }],
    ['data-i18n-html', (el, s) => { el.innerHTML = s }],
    ['data-i18n-title', (el, s) => el.setAttribute('title', s)],
    ['data-i18n-ph', (el, s) => el.setAttribute('placeholder', s)],
    ['data-i18n-aria', (el, s) => el.setAttribute('aria-label', s)]
  ]

  function applyDom (root) {
    if (typeof document === 'undefined') return
    const scope = root || document
    for (const [attr, set] of DOM_ATTRS) {
      scope.querySelectorAll('[' + attr + ']').forEach(el => set(el, t(el.getAttribute(attr))))
    }
    if (document.documentElement) document.documentElement.setAttribute('lang', lang)
  }

  function setLang (next) {
    const l = known(next) ? next : DEFAULT_LANG
    const user = readCookie('ppt_user')
    cacheLangFor(user, l)
    // Also on the no-change path: boot may already have adopted the cached
    // language, so this is where /users CONFIRMS it — and the confirmation is
    // the first moment the name table may be asked for.
    if (l === lang) { loadItemNames(); return false }
    lang = l
    itemNames = null
    itemNamesLang = null
    loadItemNames()
    applyDom()
    for (const fn of listeners) { try { fn(lang) } catch { /* a page redraw must not break the others */ } }
    return true
  }

  // The page tells us its identity answer; we take the language out of it.
  // `langs` is exactly the map GET /users returns.
  function applyUsers (langs, user) {
    const u = user || readCookie('ppt_user')
    const l = langs && u ? langs[u] : null
    setLang(l || DEFAULT_LANG)
  }

  function onChange (fn) { if (typeof fn === 'function') listeners.push(fn) }

  // ---- boot ---------------------------------------------------------------------
  // Cached answer for THIS user, so a German page does not flash English before
  // /users returns. Corrected by applyUsers() moments later either way.
  const bootUser = readCookie('ppt_user')
  const bootLang = cachedLangFor(bootUser)
  if (known(bootLang)) lang = bootLang

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => applyDom())
    else applyDom()
  }

  return {
    t,
    tn,
    srv,
    fact,
    filterLabel,
    itemName,
    setItemNames,
    loadItemNames,
    locale,
    applyDom,
    setLang,
    applyUsers,
    onChange,
    lang: () => lang,
    languages: () => Object.keys(STRINGS),
    missing: () => new Map(missing),
    STRINGS
  }
})()
