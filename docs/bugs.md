# Defects

Known, reproducible defects, fixed and open. Distinct from the
[Known issues](../README.md#known-issues) in the README: those are limitations
we accept and document, these are bugs we intend to remove or have removed.
The file has 19 entries: 16 fixed, 3 open. Entry numbers are identifiers, not a
running count (B3, B4, B6, B8, B9 and B11 have no entry here).

**Open today:**

- **B1** a cheap card priced at a fortune: cause unknown.
- **B2** a dip in the curve with no event: four mechanisms found and fixed, the
  repairs of 2026-08-14 not yet confirmed on live data, and the original dip is
  still only a candidate.
- **B20** a card with no bid priced 30-70x too high: diagnosed, not fixed.
- Remainders inside fixed entries: **B10** (the premise is unconfirmed),
  **B17** (the market side is unmeasured, the 6 h gate is a judgement) and
  **B21** (whether the game's search reads more than name and flavour text).

Each entry states what was observed, what the evidence is, and where to start
looking. A hypothesis is marked as one — nothing here is a diagnosis until it
has been reproduced.

**Provenance and standing**, because the list otherwise reads as equal items:

| | Found by | Standing |
|---|---|---|
| B1 a cheap card was PRICED at a fortune | reported from live use, 2026-08-10 | open, cause unknown — the recorded series is guarded now, the valuation is not |
| B2 dip with no event | same screenshot as B1; a **third** and a **fourth** mechanism reported from live use 2026-08-13/14 | open for the original screenshot, **but a mechanism that produces both halves of it is now fixed (2026-08-14)**. The event list was built from the PRICED rows, so an item that only lost its price read as leaving the stash and reappeared when the price came back — seven such events on an untouched stash, mirror images to the decimal. The diff runs over stock including unpriced names now; a lost price is a price move, in the curve and in no list. That first pass was followed by a second, because the recorder was still fed the snapshot's **100-name display list** and a name ranked below it fell back to the old reading; the recorder folds the per-tab store uncapped since, with nothing added to the snapshot. **Neither pass has been shown to work on live data yet.** Counted off the recorded file, an untouched stash produced 2–6 movement rows per hour all through the night *before* either fix, and 4, 0 and 2 in the three hours after the first — the same range. An earlier reading of "four-to-six per block down to two" measured the block size, not the rate, and does not survive the hourly count. The measurement that would decide it is several offline hours after both passes. Whether it fired on 2026-08-10 cannot be told from the repository, and the phantoms already recorded stay — no field distinguishes them from a real sale. **The fourth mechanism is a whole stash tab (2026-08-14, fixed the same day):** an answer that carried no contents was stored as an empty tab, so its entire stock booked as leaving and, one lap later, as arriving (53 lines in one event on an untouched stash); such an answer now leaves the stored tab standing (`networth/tab-unread.test.mjs`). It is the strongest candidate for the original dip and still only a candidate. Separately, the trend line plotted chaos until 2026-08-14 and has converted each point at its stored rate since 2026-08-15, so a wrong rate can bend it again |
| B5 folder tab occupies the refresher | measured while diagnosing B7 | **visibility closed 2026-08-11, the occupancy itself 2026-08-13, the last open point 2026-11-02.** The tick used to block for the whole 1+N walk (measured: `Maps` 913 s, `UNIQUE` 457 s) and that stopped every other user with it; a folder tab is now 1+N steps of one request each, same requests, same order, same pace. The last open point was the first round on an EMPTY store (about half an hour): the one place that assumed a short round was the Net Worth tab counter, and it states what it measures now |
| **B7** map stash reads as empty | reported from live use, 2026-08-10 | **fixed 2026-08-11 — as a side effect of the derived stash pacing, and the entry's own hypothesis is refuted by it.** The map tab now finishes with items after 913 s (38 requests at 24 s spacing) and the `yielded 0 items` line stays away. The three ordinary tabs listed alongside it are explicitly NOT covered |
| B10 Stash-Highlight regex is English | found while fixing the display language | **fixed 2026-08-11 on a premise that is still UNCONFIRMED** — nobody has pasted a regex into a German client. The fix moves the whole name universe into the client's language, not just the wanted names; one paste in game closes or reverts it, and the entry says which |
| B12 test files call poe.ninja | measured while fixing B11 | **fixed 2026-08-11.** There were four of them, not the two originally measured — hence a recording-`fetch` test rather than a list of files |
| B13 seven settings cannot express zero | found while fixing the same defect in the config block, 2026-08-11 | **fixed 2026-08-11.** All seven go through the shared reader now; five honour a zero that used to be swallowed, two are refused with a reason. Defaults unchanged, pinned by hand-written literals |
| B14 a trade ban does not stop the stash refresher | found while auditing the stash path's 429 handling, 2026-08-11 | **fixed 2026-08-11 — the two are coupled.** What overturned the old decision is not a measurement in this code but the operator's account of a past ban: it applied to the whole address. The opposite direction (a stash 429 holding the *trade* queue) was examined in the same pass and deliberately left alone — see the entry |
| B15 every unique map in the map stash was unpriced | reported from live use, 2026-08-11 — the first day B7's tab delivered anything | **fixed 2026-08-11.** GGG's base line is `Map (Tier 16)` while every unique map's base in the bridge data is plain `Map`, so the base join could never hit; it retries undecorated now, and the kept decoration is what matches poe.ninja's tier. One link in the chain is inference rather than observation, and the entry says which |
| **B16** the derived stash pace only ever got stricter | measured from the rule-set log, 2026-08-13 | **fixed 2026-08-13.** The pacer's rule table only ever grew, so one strict answer held the tool at 80 s between requests until a restart. `X-Rate-Limit-Policy` — sent all along, parsed by nothing — is now part of the rule key, so a response replaces the set of its own budget and no other. The strict set turned out to be the **unauthenticated** form of the same policy, i.e. a dead cookie, which the tool now says out loud instead of quietly pacing around |
| **B17** the exchange headline was 40 % above the in-game market | reported from live use, 2026-08-13 | **fixed 2026-08-13.** The cause was the age of the hour a quiet market keeps, not its side: the observation hour is carried per item, printed on the card once it is older than one digest hour plus a refresh interval, and gated at `POE_FAUSTUS_MAX_AGE_HOURS` (6), past which the item takes the poe.ninja fallback. **Still open:** the market side is unmeasured (neither source publishes a bid and an ask, so no liquidation discount was applied), and the 6-hour value is a judgement, calibratable from the age the card prints |
| **B18** the unpriced headline disagreed with the list under it | reported from live use, 2026-08-13 | **fixed 2026-08-13.** The headline counted stash ENTRIES, the rows counted PIECES, and the page printed both as "items"; on top of that the account-wide 100-name cap dropped a row the headline still counted. The line now states the pieces and names it actually shows and says separately how many pieces it does not. That the reported single missing one came from the cap is inference — a zero stack is ruled out at the code, the cap was not checked against the live store, and the entry names the one-line check that would settle it |
| **B19** a name pattern skipped the whole map stash | measured from the production log, 2026-08-13, hours after the feature shipped | **reverted 2026-08-13, rebuilt on a measured field 2026-08-19.** The map stash's children are called `"1"` and `"2"` — page numbers, not section names — so a pattern meant for `Tier: 16` matched all 39 of them and the tab went unread, `Unique Maps` and `Special Maps` included (~165c missing from the net worth, and the history recorded it). The log line that stayed answered the open question: `metadata.map.section` is GGG's own label of each page (`unique`, `special`, `tier<N>`). The skip came back on that field, on by default, and skips only a page that explicitly says `tier<N>`; anything missing or unknown is read (`networth/map-sections.mjs`). `POE_NETWORTH_SKIP_TIER_MAPS=0` reads the whole stash |
| **B20** a card with no bid is priced 30-70x too high | reported from live use, 2026-08-13 — four cards read against the in-game exchange at one minute | **open, and deliberately not "fixed" on a guess.** The defect is real and binary: with a bid the tool is at 0.9-1.4x, on "No Stock" at 30-70x. The cause is diagnosed down to the line (the whole absolute bar on the direct chaos path is 50 chaos in one of eight hours, and the thin-market trigger is a PIECE count, which is blind at the cheap end) — but **no source this tool fetches carries a bid**, and the four points bound only the wrong side of the comparison, so any threshold would be invented. The entry names the one dump that decides it. What shipped is the missing observation: the Net-Worth table now names the feed behind every price |
| **B21** the highlight regex lit up 12 slots for 9 cards | reproduced in game, 2026-08-13 | **fixed 2026-08-13.** The stash search reads the flavour text too, so `some` — unique among the 4700 NAMES — matched six foreign cards. Fragments that are everyday English words are refused now and grow instead. The tool has no flavour texts and cannot prove a fragment is clean; the entry says what the word list misses and why it was written by hand |
| **B22** the German data set stopped following the English one | measured from the container log, 2026-08-15 to 2026-08-17 — three identical failure lines, last success 2026-08-13 | **fixed 2026-08-18.** GGG's patch version grew a fifth part (`3.29.3.1.2`) and the version pattern accepted at most four, so every daily check refused a perfectly good answer. Four days of skew: the English set gained 542 stat and 48 item lines in that window while the German one was carried over unchanged. The part count is out of the pattern now, and what is not a version is still refused. The generation side was checked too, not assumed — a five-part version reaches the CDN path and `build-info.json` unchanged |
| **B23** the German set built again and was then thrown away by its own coverage check | measured from the production log, 2026-08-18 — the first run after B22 was fixed | **fixed 2026-08-18, and the fix is not a looser bar.** The gate measured the gap against the ENGLISH set, which upstream grows on its own schedule, so it fired hardest exactly where refusing helps least: the set it kept live does not carry the missing stats at all. It now asks the only question a refusal can act on — did this run LOSE coverage the live set already had — and 505 stats with no German matcher are reported rather than fatal. Proven from the run's own numbers: not one pre-existing stat changed. The WHY was then settled from the run's own list of unresolved matchers — they are skill and gem names, a new KIND of matcher upstream started shipping, and the tables holding those names in German were being downloaded on every run and never offered to the resolver. Both halves shipped; the second costs no new request |
| **B24** the message that announced an outage never said whether it was ours to fix | walked back from B22/B23 — five days of "no successful check of lang-data" that named no cause, 2026-08-18 | **fixed 2026-08-18.** The refresher logged the reason of every failed check and persisted only the OUTCOME, so the browser could say how long a source had been quiet and nothing about why. The reason and a CLASS of failure (unreachable / rejected / incompatible / unknown) travel into the note now, and `unknown` really does say nothing rather than guess. Four more holes in the same wall went with it: the game-data export's exit code was ignored (so a schema change would have arrived as advice about a misspelled language name), a run's provenance was nowhere but the log, an unknown item namespace was silent by construction, and the documented escape hatch `POE_PATCH_VERSION` needed the SSH session it exists to save |
| **B25** the repairs B24 shipped were unverifiable, and two of them said the wrong thing | an adversarial pass over the B24 work, 2026-08-18 | **fixed 2026-08-18.** Four findings: the credential filter deleted the very reason sentence it was built to deliver; the `POE_PATCH_VERSION` pin, now settable from a form, was a new way to go quiet in two cases (a valid but non-existent version read as "unreachable, the next check tries again", and a stale pin froze the set with every check green); the reasons carried advice of their own next to the advice of their class; and a repair took effect only at the next daily check, so a working repair and a useless one looked alike for up to 24 hours (settings -> admin area -> "Check now"). Smaller findings of the same pass went with it |

---

## B1 — A cheap divination card was PRICED at a fortune, and where that came from is still unknown

**Observed** (2026-08-10, 24h window, Allflame league, from a screenshot of the
History page): **The Twilight Moon**, quantity **+1**, recorded at **+55.2 div**
— at that hour's rate (212 c/div) roughly **11,700 chaos** for a card that
trades at about **1 chaos**. Two other cards in the same window looked
suspicious by the same measure: **The Demoness** +1 → +7.8 div, **Enmity's
Embrace** −1 → −12.9 div.

**What was reproduced and fixed is the guard hole, not the price.** The
hypothesis about `price-guard.mjs` was right and is pinned by a test now:
`apply()` walked `curMap`, looked up `prevMap.get(name)` and `continue`d when
there was none, so an item ARRIVING had no previous unit price and nothing for
`GUARD_FACTOR` to measure against. Every event in the list above is a ±1
quantity change, i.e. an arrival or a departure — exactly what the guard could
not see. `price-guard.test.mjs` now reproduces the Twilight Moon arrival; it
failed before the change and passes after it. The guard also judges arrivals
(its own memory of prices it has accepted per name, plus a share-and-divine bar
that withholds an unknown big arrival until it has stood), and the price
**source** of every item survives the valuation and is named in the log line.
See `docs/pricing-logic.md`, "History: what a recorded point is protected
against".

**What is still open is the price itself.** Nothing recorded that night says
whether the 11,700c came from Faustus below its volume floor or from a poe.ninja
line that matched the wrong row, and the container's log is gone — the same dead
end as the Scavenger case. It cannot be answered from the repository. The series
is protected from it; the valuation still produces it.

**Next step, cheap and decisive:** when the brake fires again, take the
`[networth]` line off the container. It names the item, both prices, the
quantity, the share, and the source. `source faustus` points at that hour's
digest; `source exchange:DivinationCard` points at poe.ninja's card overview
line for that name. Until one of those two is in hand, anything about the cause
is a guess.

**Scope of the fix, stated plainly:** The Demoness (7.8 div) and Enmity's
Embrace (12.9 div) are below the arrival bar's divine floor and are **not**
caught. Neither was ever shown to be wrong — they are suspicious, not diagnosed,
and suppressing arrivals that small for six hours on suspicion costs more than
it buys.

### Known limits of that guard — deliberately left, not overlooked

Three of them, all found by review before this ever ran on the container. None
is fixed here, because each fix needs a number that no measurement supports, and
the 20-divine floor is already declared as "a judgement call bounded by the one
measured case". A second guessed number stacked on the first buys nothing and
hides which of them was wrong when the next incident arrives.

1. **The arrival bar does not exist below its floor — on any account.** The
   floor is absolute and AND-ed with the share, so a 19-divine arrival passes
   unexamined on a 5-divine account just as it does on a 94-divine one, even
   though it is four times that account. Everything that would repair it moves
   or reshapes the floor: scaling it by the share, OR-ing it with the previous
   total, or a separate small-account bar. The first two were worked through and
   both misfire at the bottom of the range — with an account worth a tenth of a
   divine, ordinary league-start drops become "suspicious", which is exactly
   what the floor exists to prevent. Deciding between them needs a second
   observed case, and there is one observed case in total.
2. **Several arrivals under the floor in one point are judged one by one.** Ten
   bogus 19-divine names entering together are ten passes, not one 190-divine
   event. Judging the *sum* of unreferenced arrivals would catch it — and would
   also withhold every name of a legitimate inventory dump for six hours, which
   is a worse failure than the one it prevents. Not done on a suspicion.
3. **The memory of accepted prices does not survive a restart.** `known` in
   `price-guard.mjs` lives in the process and ages out with the hold window, so
   the "an item that left and came back is still measured against what we last
   saw" property holds for at most six hours and not at all across a container
   rebuild — which was the exact circumstance of the Scavenger night. It is
   narrower than it sounds: the *previous point's* breakdown does survive, in
   the history-items sidecar, so only a name that was absent from the last
   recorded point loses its reference. Persisting the map as well would mean a
   second store in `/config` for at most six hours of opinion; the honest
   description is in the module header and in `docs/pricing-logic.md` instead.

**Where to look**
- `backend/v2/networth/kinds.mjs` — the divination-card branch, Faustus first,
  then the poe.ninja card exchange overview
- `backend/v2/networth/valuator.mjs` — `exchangeSingle`, the volume floors
- `docs/pricing-logic.md` — how cards are valued, and the confidence floors

---

## B5 — One folder tab occupies the refresher for minutes (visible 2026-08-11, and the occupancy itself removed 2026-08-13)

**Observed** (2026-08-10, read live off the running container over
`ws://…/events`):

- Tabs were walked as designed: 18 tabs, 30 s apart, `07:18:22Z` to `07:27:55Z`.
- Then **nothing for ten minutes** — three probes at `07:32:40Z`, `07:35:17Z`
  and `07:37:48Z` saw every `syncedAt` frozen. `networth-sync-status` said
  `state: "ok"` throughout, and the container log had no `[networth-refresher]`
  line at all.
- At `07:38:07Z` the `Maps` tab appeared with a fresh stamp, and the 30 s
  cadence resumed immediately (`Fragment` 07:38:52, `Essence` 07:39:22, …).

So the refresher never stopped: **a single `step()` ran for about ten minutes.**
`Maps` is a folder tab, and those are fetched as a child list plus one request
per child, each with a hard timeout and retries
(`requestUrl()` and `withTimeout()` in `backend/v2/networth/stash-client.mjs`;
at that time the whole walk ran inside one step). A slow
or partly failing folder tab therefore costs 1+N requests × retries inside one
tick, and only logs when it is over.

**What is actually wrong is that none of this is visible.** `tickOnce()` latches
`busy = true` for the whole of `step()` and clears it in `finally`, with no
watchdog; `statusFor()` reported only `pausedPoesessid` and `cooldownUntil`, so a
tick that has been running for ten minutes was indistinguishable from a healthy
idle one. From the outside — the UI, the status line, the log — a long folder
tab and a dead refresher looked exactly the same. That ambiguity cost three
WebSocket probes and a wrong diagnosis before the `Maps` stamp settled it.

**The three points this entry carried, and where each of them ended**

1. ~~A status field for *when the last tab was written* and *what the current
   tick is doing*~~ — **done 2026-08-11.** `statusFor()` now also answers
   `lastTab` (when a tab was last written for this user and which one — read
   from the store, so a restart cannot make it lie) and `current` (the step in
   flight: `phase`, `since`, and the tab name when the step belongs to this
   user; another user's step shows as busy but unnamed). Both ride the existing
   `networth-sync-status` message — see `backend/v2/frontend/PROTOCOL.md`.
   Alongside it, a step that holds the tick longer than
   `POE_NETWORTH_SLOW_STEP_MS` (default 120s) logs
   `[networth-refresher] still busy: …` **once**, and a second line when it
   returns, so the gap is bracketed at both ends instead of being a hole with
   nothing around it.
2. A bound on how long one tick may hold `busy` — **still deliberately not
   built, and the reason is unchanged:** a watchdog that RELEASES `busy` would
   put a second request against GGG in flight next to the first and break the
   strict sequentiality every rate-limit decision in `stash-client.mjs` rests
   on. This project has a ban history. Whatever bounds a tick has to end the
   *request*, not step around it. What made the point moot in the end was not a
   bound but point 3: a step is one request again, so the longest a tick can
   hold `busy` is one derived spacing plus one request.
3. Whether folder tabs need a budget of their own — **answered no, and then
   overtaken.** A budget cannot make 1+N requests cheaper; it can only spread
   them over more ticks. What that entry said could not be had — "other tabs
   syncing *in between*" — is exactly what was built on 2026-08-13, and it needed
   neither point 2's shape nor a second request stream: the WALK became a piece
   of plain data the refresher puts down between ticks
   (`networth/folder-walk.mjs`), so a folder tab is `1 + N` steps instead of one
   step of `1 + N` requests. Same requests, same order, same pace, one per turn.
   See "The occupancy itself is gone too" below.

### The occupancy itself is gone too (2026-08-13)

This entry was closed on the argument that the occupancy was by design and only
its invisibility was a fault. That held right up until the deployment had more
than one user on it. `busy` is global and the round-robin advances only when a
step returns, so a folder tab did not just stop the other TABS — it stopped the
other USERS, for 913 s at a 24 s spacing and for the best part of an hour at the
80 s an unauthenticated rule set derives (B16). A full round went from hours to
days, and no amount of logging makes that acceptable.

**What was built.** The walk is now a state rather than a stack frame
(`networth/folder-walk.mjs`): `beginFolderWalk` / `stepFolderWalk` /
`finishFolderWalk`, driven one request per tick by the refresher and in a loop by
`stash-client.fetchTab` for the callers that have no ticks (the one-shot scan).
A test asserts the two produce byte-identical request sequences, which is the
whole safety argument: **the request count does not change in any
constellation** — 1+N, in the same order, at the same derived pace.

**What it is careful about.**

- The partial walk lives in the refresher's per-user memory, next to `st.tabs`
  and `st.attempts`, and NEVER in the store. A half-read folder tab written
  there would be read as a tab that has been read — by the snapshot, by
  `tabList` and by `coverageOf` — which is B7 with the tool doing it to itself.
  The previous complete contents of the tab stand until the walk finishes.
- `coverageOf` counts the tab from the walk's FIRST step, exactly as it counted
  the old 1+N step from its start, so B2's recorder gate is unaffected.
- A failure mid-walk drops the walk and writes nothing; the tab is walked again
  from the beginning later, which is what the old all-in-one step would also
  have had to spend again. A **429 keeps** the walk and resumes after the
  cooldown — strictly fewer requests than starting over.
- The tab-list refresh waits for a walk instead of interrupting one.
- The visibility is not lost but moved: the `still busy` / `finished after` pair
  no longer fires for a folder tab (there is no long step to fire it), so its
  place is taken by a closing `[networth-refresher] folder tab … N sub-tabs read
  over S steps in Ts` line and by `folderTab` in the sync status, which answers
  "12 of 37" BETWEEN ticks — something the old pair could not do at all. B7's
  `yielded 0 items` line is emitted by the shared walk code, so it is identical
  whichever way the walk was driven.

**Closed as a defect 2026-08-11, on the numbers.** Today's log has both folder
tabs bracketed at both ends: `Maps` 913 s and `UNIQUE` 457 s, each between its
`still busy: …` and `finished after Ns` pair, at a derived spacing of 24.0 s.
913/24 = 38 requests and 457/24 = 19 = 1+18 children — the walks are legitimate
requests being paced, and the pacing is doing the arithmetic it says it does.
What made this an entry was never the duration; it was that ten minutes of
legitimate work and a dead refresher printed the same thing, which is point 1.

**And the ten minutes of 2026-08-10 are probably not the defect they were filed
as.** The reading at the time was "a single `step()` ran for ten minutes and
nothing said so"; the second half was right. For the first half there are two
explanations in that version of the code and **nothing in the material chooses
between them**: `delayFor()`'s reactive brake, which returns the whole window
once a state counter reaches `limit-1` (slept capped at 90 s) — i.e. the client
braking correctly on a window it could see filling — or 31 merely slow
responses, each allowed 30 s before the hard timeout. Neither was logged. So the
honest statement is that the observation is compatible with the tool working as
designed, and it was filed as a fault because the log could not tell the
difference. It can now.

**The last open point is closed (2026-11-02): a first full round on an EMPTY
store takes long, and the one place that assumed otherwise was a display.**
Coverage counts a tab once it has stored data or has been attempted
(`coverageOf`), and the history recorder refuses a point until every tab is
covered (B2), so on a fresh install the first recorded point waits for one
complete round. A round takes tabs x interval (x users), and a folder tab adds
its 1+N steps; on the 18-tab account these numbers come from that was about half
an hour on 2026-08-11, not the ~9 min the 30 s cadence suggests. A restart with
a warm store is unaffected: the stored tabs count as covered immediately.

The check whether anything else assumes a round to be nine minutes long found
one thing. The Net Worth status line counted "fresh" tabs against a fixed
10-minute threshold that a full round rarely fits into. Since 2026-11-02 the
counter reads `{recent}/{total} tabs synced in the last 10 min · oldest tab
synced {mins} min ago` and invents no round duration: the client knows neither
the interval nor the number of users (`autosyncSummary()` in
`backend/v2/frontend/networth-sync.js`). Nothing else is open in this entry.

**Where to look**
- `backend/v2/networth/refresher.mjs` — `tickOnce()`, `step()`, `statusFor()`
- `backend/v2/networth/stash-client.mjs` — the folder-tab path and its retries
- `docs/admin.md`, "When the refresher goes quiet" — what each line means and
  how often it fires

---

## B7 — The map stash read as empty (fixed by the pacing, and the old hypothesis is refuted)

**Observed** (2026-08-10): the `Maps` tab showed **0c / 0 items** in the tool
while the same tab in the game was full — roughly 30 sub-tabs holding hundreds
of maps (`53`, `49`, `42`, `30`, `25`, … per sub-tab). Read straight off the
running container, the snapshot carried `Maps  idx=2 {"chaos":0,"items":0}`, and
no row anywhere had `tab: "Maps"`. This is not the documented "non-unique maps
are not priced" behaviour: unpriced items still arrive and are counted. There,
nothing arrived at all. The same tab also took about ten minutes, during which
the refresher did nothing else (see B5).

**Fixed 2026-08-11 — as a side effect of the derived pacing in `c45bc29`, not by
anything aimed at this entry.** Nothing in the folder-tab walk changed (it was `fetchChildedTab()` then; it is `walkFolderTab()` in `backend/v2/networth/folder-walk.mjs` now). What
changed is the spacing between two stash requests, and the map stash now
delivers items.

### What the production log proves

Three lines from the same run:

```
19:03:09 [stash-client] … derived minimum spacing between two stash requests: 24.0s
19:03:39 [stash-client] folder tab "Maps" (MapStash): reading sub-tabs
19:18:51 [networth-refresher] tab "Maps" (index 2, MapStash) for player1 finished after 913s
```

- 913 s at 24.0 s spacing is **38 requests**: the child list plus ~37 sub-tabs.
  The whole walk ran; nothing was cut short. The `UNIQUE` tab in the same run
  took 457 s = **19 requests** = 1 + 18 children, which is exactly the sub-tab
  count the code comments already record for that tab — so the arithmetic that
  turns seconds into requests is checked against a known quantity, not assumed.
- **The `yielded 0 items` line did not appear.** Its condition is
  `items.length === 0` with nothing else AND-ed onto it
  (`finishFolderWalk()` in `backend/v2/networth/folder-walk.mjs`), and since 2026-08-11 it is
  unconditional — no debug switch, no sampling. Its absence therefore says
  items arrived, and it says so without anybody having to read a snapshot.

That is the whole of the symptom, gone.

### The causal chain, and how far each link is actually carried

1. **The old pace produced a burst.** The base spacing inside a step was a 1.5 s
   constant, so the map stash's 1+30 requests went out inside 46 s (measured,
   and recorded in the header of `networth/stash-pacer.mjs`).
2. **That burst was past a limit GGG publishes itself.** Folder tabs are walked
   on `/api/stash/*`, whose own rule set comes back as
   `Account 15/10s ban 60s, Account 30/300s ban 300s`. 31 requests inside 46 s
   is past `Account 30/300s` on its own, before the unique stash's 19 on the
   next turn are counted. Measured off response headers, not assumed.
3. **The ten minutes of B5 are NOT used as evidence here, because two things in
   that version produce them and nothing chooses between them.** `delayFor()`
   returns the whole window once a state counter reaches `limit-1`, slept capped
   at 90 s — that one fires only on a near-full window and would corroborate
   step 2. But a request is also allowed 30 s before the hard timeout, so 31
   merely slow responses fill ten minutes on their own, with every window
   healthy. Neither was logged. Step 2 therefore stands on the published limits
   and the request count alone; the duration is left out of the chain.
4. **The silent path is real, and it is the only one there is.** Every non-2xx
   throws a typed error: 401/403 → `auth`, 429 → `ratelimit`, other 4xx →
   `rejected`, 5xx after retries → `server`. `auth`/`ratelimit` propagate to the
   refresher (a cookie warning or a cooldown line); everything else is caught in
   `fetchTab` and logged as `folder tab "…" not readable`. **None of those lines
   was in the log.** So the walk returned normally with an empty
   array, and the only way the code can do that after walking N children is a
   child answering **HTTP 200 with a body that is not `{stash:{items:[…]}}`** —
   `Array.isArray` is false, nothing is appended, nothing is logged.
5. **What the refusal looked like on the wire was never captured.** That a full
   window is what produced those bodies is the suspicion this entry always
   carried, and it stays one: no response body from that night exists. What is
   established is the pair of endpoints — with 24 s spacing the same code path
   gets items, with 1.5 s spacing it got nothing.

### The old hypothesis is refuted, not confirmed

This entry used to say: *the map stash has one level more than the code walks*,
and pointed at the row of pages under the sub-tabs in game. **That is wrong**,
and it matters that it is written down as wrong, because it is where the next
person would otherwise start digging.

The walk is still two levels deep — parent → children, `j?.stash?.items` per
child — and it now returns hundreds of maps. A level the code never descends
into cannot be the reason the same code found nothing in August and finds items
now. Whatever the map stash looks like in the client, its items are reachable
where the code already looks.

### The three tabs listed alongside it are NOT covered by this

The entry also named `Maps2Run`, `Maprunner` and the unnamed tab 16 as "also
affected, same symptom: `items: 0`". Nothing here fixes or diagnoses those, and
they should not be assumed to have gone with the map stash:

- Only `UniqueStash` and `MapStash` take the folder-tab route
  (`CHILDED_TAB_TYPES`), and an account has one of each. The other three are
  therefore ordinary tabs on the old endpoint — a different request, a different
  code path, and one request rather than 1+N, so the burst above cannot be their
  cause either.
- An ordinary tab that is genuinely empty in game also reports `items: 0`, and
  nothing in the material distinguishes the two.

Reading them off the page is now a glance rather than a diagnosis: the Net-Worth
sidebar marks a worthless tab `∅` (nothing arrived) or `⨯N` (N items arrived and
the classifier dropped them), with the counts in the row's tooltip. `∅` on a tab
that has items in game is the thing worth reporting; it would be a new entry,
with the tab's type in it.

**Where to look**, if one of them turns out to be real
- `backend/v2/networth/stash-client.mjs` — `fetchTab()`'s ordinary branch, and
  its `POE_NETWORTH_DEBUG=1` shape dump for a tab that came back with 0 items
- `backend/v2/networth/stash-pacer.mjs` — the derived spacing that fixed the
  folder-tab case, if the count of requests is ever in question again

---

## B10 — The Stash-Highlight regex is English even for a German client (fixed on an UNCONFIRMED premise)

**Found while making the item names on the page follow the user's language**
(2026-08-10), by reading the code, **not reproduced in game**.

The Net Worth page can build a regex to paste into the **game's** stash search
(`buildHighlight`, `renderHighlight` in `backend/v2/frontend/networth.js`). It was
built from the snapshot's item names, which are the **English reference names**,
and from `/item-names`, which was the English name list of the snapshot.

Everything else on that page prints the localized name while keeping the English
one for lookups. This one string was deliberately **not** translated, because it
is not display text: it is matched by the game client, and a German client
searches its stash by German names. If that holds, a German user got a regex
that highlights nothing.

### The premise is still unconfirmed, and that is on purpose written down here

**Nobody has pasted a generated regex into a German client.** The claim "the
stash search matches the names the client displays, not their English reference
names" is a reading of how the client behaves, not a measurement of it. It is
the only assumption the fix rests on, and if it is wrong the fix is wrong in
exactly one direction: a German player then gets a regex that highlights nothing
where an English one would have worked. Nothing else on the page changes, and no
price can be affected either way.

**One paste settles it, and it costs nothing:** open Net Worth on the German
client's user, copy the regex, paste it into the stash search in game. Slots
light up → premise confirmed, entry closed. Nothing lights up → paste an English
name into the same field by hand; if *that* matches, the premise is refuted and
this change should be reverted rather than patched.

The fix was made ahead of that confirmation anyway, because the state it
replaces is inconsistent on its own terms: every other name on that page already
follows the client's language, and only this one — the single string that leaves
the page and enters the game — did not.

### Fixed

`GET /item-names` is now **per user** (same `ppt_user` cookie as
`/item-name-map`) and answers in the language the game runs in:

```json
{ "lang": "de", "names": ["Cortex", …], "byRef": { "Chaos Orb": "Chaossphäre", … } }
```

- **The whole universe moves, not just the wanted names.** This was the trap.
  `buildHighlight` shortens every wanted name against the universe so the regex
  does not match too much (the "14 slots instead of 9" case in the header of
  `frontend/highlight.js`). Localizing only the wanted side would shorten German
  names against an English universe and produce fragments that are unambiguous
  in a universe nobody is searching — the same failure class, freshly earned. So
  the endpoint delivers both halves in one answer, built from one file, and the
  page derives both lists in one call (`highlightInputs`). Either everything is
  German or everything is English; there is no half state, including when the
  request fails.
- `names` and `byRef` are **disjoint**: `names` carries only the spellings that
  need no translation, and the page unions the two. Without that split every
  localized name would be in the payload twice.
- **The language source is its own function.** `gameClientLang(user)` reads the
  same setting the display side reads (`POE_USER_LANGS`, overridden per user by
  `/user-lang`) and is deliberately not the same call: the display side asks
  "how should this be spelled for the reader", this one asks "what will the game
  match". They agree today because one setting feeds both; they are named apart
  so the day they stop agreeing, only one of them moves.
- `cache-control` went from `public, max-age=86400` to `no-store`: the answer is
  user-specific now, and a shared cache handing one player's German list to
  another would highlight the wrong slots for both.

**Where to look**
- `backend/v2/frontend/highlight.js` — `highlightInputs()` and the contract note
  above `buildHighlight`
- `backend/v2/frontend/networth.js` — `renderHighlight()`, `ensureItemNames()`
- `backend/v2/server.mjs` — `gameClientLang()`, `loadItemNamesJson(lang)`
- Tests: `frontend/highlight.test.mjs` (both lists in one language, and the
  no-table fallback), `item-name-map.test.mjs` (the endpoint, and that no
  English name survives in a German universe)

**Not the same question as B21.** B21 (below) is about a second universe the
generator never had — the flavour text — and it was measured on an English
client. It says nothing for or against the language premise above, and closing
one does not close the other.

---

## B21 — The regex lit up twelve slots for nine cards, because the stash search reads the FLAVOUR TEXT (fixed, as far as a tool without flavour texts can fix it)

**Reproduced in game** (2026-08-13, English client, from the Net Worth page's
Stash Highlight). Nine divination cards selected — Mawr Blaidd, Divine Beauty,
Monochrome, Imperial Legacy, The Fortunate, Darker Half, The Fathomless Depths,
Matryoshka, Something Dark — produced

```
"awr|ne be|mono|ial l|tuna|rker |oml|yos|some"
```

Pasted into the stash search, **twelve** cards lit up. Six of them were not in
the selection: Boon of Justice, Demigod's Wager, Disdain, Forbidden Power, The
Aesthete, The Body.

### The cause is one fragment, and the universe it was checked against

`some` is unique among the ~4700 item NAMES — exactly one name contains it, and
that is the wanted card. The stash search does not stop at the name. It reads
the whole item text, **the flavour text included**, and there `some` is an
everyday word. The seven hits, one by name and six by flavour text:

| Card | where `some` sits |
|---|---|
| Something Dark | in the NAME — wanted |
| Boon of Justice | "**Some** gifts are obligations while others are simply opportunities." |
| Demigod's Wager | "**Some**times you need to make your own luck." |
| Disdain | "…but you'll see more than **some** see in a lifetime." |
| Forbidden Power | "**Some** things should not be used. **Some** power is too great a risk." |
| The Aesthete | "**Some** see our mortal flesh as a limitation." |
| The Body | "…all must flow through the body at **some** point." |

So the shortening minimized against the wrong universe — the same failure class
as the "14 slots instead of 9" case the header of `frontend/highlight.js`
already warned about, one level further down: there the exclusion set was too
small (own stash instead of all names), here it is the wrong KIND of set (names
instead of item text). Before the fix, `shortestTokenIn()`
(`backend/v2/frontend/highlight.js`, called from `buildHighlight()`) took the name list and nothing else into account. It is the only
shortening in the repository and it is used for the Stash Highlight only.

### Fixed, and what the fix cannot do

A fragment that **is an everyday English word, or sits inside one, is refused**;
the fragment then grows. That is the conservative direction and it costs
characters, hence items per search field — fewer cards per pass beats a field
that lights up half the stash.

**The tool has no flavour texts.** No data file maps a name to its flavour text
and no endpoint answers with one (`items.ndjson` is names only, `stats.ndjson`
is modifier text and does not contain the word "some" at all). The daemon does
see the flavour text of the one item a user pastes, in the clipboard text —
that is a single item on a different path, not a lookup this page could use.
The guard can therefore never verify that a fragment is collision-free; it can
only refuse what is LIKELY to collide, and everything it has not been told
about passes. `tuna` (from The Fortunate) is still in the output, because
"fortunate" is not on the word list — a card whose flavour text uses that word
would light up, and `highlight.test.mjs` asserts exactly that, so nobody can
later write "guaranteed" over it.

**Where the word list comes from**, because a hand-written list of common words
is otherwise a guessed number in list form: there is no usable English corpus in
this repository (checked: `items.ndjson`, `stats.ndjson`, `app_i18n.json`,
`client_strings.js`, `frontend/i18n.js` — UI vocabulary, modifier text, keys and
German, none of it flavour prose). So the list is written by hand from two
stated criteria: **(a)** the closed-class words of English — articles, pronouns,
prepositions, conjunctions, auxiliaries, quantifiers, question words; the set
does not grow with the language, so this half can be near-complete, and it is
where the short dangerous fragments live. **(b)** every word of the six flavour
texts above, rarities included, because "measured" is a criterion and "feels
common" is not. It is **incomplete by construction** and English-only — for a
German client it guards against the wrong language altogether, which is B10's
open question again.

**The count stays honest.** The nine cards above still fit (49 of 250
characters, `"…|yos|thing d"`), so the page still reads 9/9. Where the guard
does push entries out, the page already names them, and now says why: the new
`lengthened` list counts the fragments that grew past what the name list alone
would have needed, and `nw.hlWordGuard` prints that reason under the drop list.
A regex that silently covers less would be the next bug of this family.

A name that cannot be shortened safely at all passes as the **whole name** — the
full name is exempt from the guard, because refusing it would leave nothing.

**Where to look**
- `backend/v2/frontend/highlight.js` — `EVERYDAY_WORDS`, `looksEveryday()`,
  `shortestTokenIn()`; the header note on the second universe
- `backend/v2/frontend/networth.js` — `renderHighlight()`, the reason line
- Tests: `frontend/highlight.test.mjs`, section B21 — the seven hits, the six
  flavour texts staying dark, the count adding up, the whole-name fallback, and
  the honesty test that pins what the guard misses

**Open:** whether the game's search covers more than name plus flavour text
(implicit/explicit modifier text on rares would be a third universe, and a much
larger one). Nothing here was measured on anything but divination cards.

---

## B2 — A momentary drop in the curve with no matching event

**Observed** in the same window: a single sharp dip just before 08:31 PM, down
from the ~94 div baseline and back within one recording interval. No entry in
*What moved* accounts for it, and the threshold for that list was `1 div`.

**Verified: a partial sync could reach the recorder, and nothing stopped it.**
`history.append()` wrote a point for whatever `networthSnapshot()` summed at
that moment — the union of the per-tab store — and the refresher fills that
store ONE TAB PER TICK. Between an empty store (a fresh install, or
`pruneTabs()` after a tab list that came back short) and the end of the first
full round, that union is a sum over a subset of the account, and the only
condition on writing a point was the one-per-minute throttle. The refresher now
reports coverage of the live tab list and the recorder refuses a point until
every tab has been walked; a tab that is never readable counts as walked,
because its absence is then a constant rather than a dip. Regression test:
`refresher.test.mjs`, "after a short tab list wiped the store, coverage reads
incomplete again".

**NOT established: that this is what produced the 08:31 PM dip.** The mechanism
existed and is closed; whether it fired that evening cannot be told from the
repository. Two things that were checked and change how the screenshot reads:

- *What moved* groups points into buckets **before** it applies its threshold
  (hourly on the 24h range), so a movement out and straight back inside one
  bucket cancels to nothing, whatever caused it. The empty list is therefore not
  evidence that the stock did not move.
- A **second** mechanism with exactly this signature was found by review and
  closed before it ever ran: the guard's withholding of an unknown arrival (B1)
  booked the later acceptance as a *price* move with no quantity change, which
  `events()` drops and `stockMove()` reads as nothing — so a genuine 25-divine
  find was in no list at all and then stepped into the curve unexplained six
  hours later. It is now booked as stock arriving at the point where the series
  can first count it (`withoutReleased` in `history.mjs`), with a regression
  test in `history.test.mjs`. It is **not** a candidate for the 08:31 PM dip:
  the withholding did not exist yet that evening.
- **Until 2026-08-14 the trend line plotted chaos**, not divine
  (`history-chart.js` drew `p[1]`), so a momentarily wrong C:D rate could not
  bend it, and that candidate was ruled out for the 08:31 PM dip as it was drawn
  that evening. **Since 2026-08-15 it can:** `displaySeries()` in
  `history-chart.js` converts every point to divine with the rate stored on that
  point (a point without one borrows the nearest), as soon as one point in the
  window carries a rate. A point recorded with a wrong rate bends the curve, so
  a rate that is off for one recording interval is a candidate again for any dip
  seen on the chart today. Nothing recorded says which rate a given point
  carried.

### A third mechanism with this signature — and this one was caught in production (2026-08-14, fixed)

**Observed** on a stash nobody touched: the operator had not played for many
hours, and the event list showed seven events over six hours. Three of them
paired up as mirror images, to the decimal:

| time | item | qty | value |
|---|---|---|---|
| 09:37 | The Card Sharp | **+3** | **+12.6 c** |
| 10:16 | The Card Sharp | **−3** | **−12.6 c** |
| 05:37 | Weeping Essence of Contempt | **+7** | **+18.8 c** |
| 06:16 | Weeping Essence of Contempt | **−7** | **−18.8 c** |
| 05:37 | Runegraft of Fury | +1 | +11 c |
| 10:16 | Runegraft of Fury | −1 | −12.4 c |

The items appear and disappear rather than move, which is a different report
from every one above it — and the page states the opposite in as many words:
*"Events are stock movements — what came in and what went out. Price moves are
in the curve, not in the list."*

**The cause, and it is one line of set arithmetic.** The stored delta was built
from `foldItems(snapshot.items)`, and `snapshot.items` holds the **priced** rows
only — `aggregate.mjs` puts everything without a price into `snapshot.unpriced`
instead. So the set the diff ran over was "the items we can price", not "the
items in the stash". A name that lost its price left that set, and
`buildDelta` has exactly one reading for a name that is in the previous map and
not in the current one: `dq = -q0`, the whole stock leaving, valued at the price
it had. Getting the price back read as the same stock arriving. Two of the three
pairs above are the same quantity at the same chaos to the decimal because
nothing about the item changed between the two points except whether a feed had
a number for it; *Runegraft of Fury* differs (+11 → −12.4) because its price had
moved by the time it went away again.

**Which gate dropped those prices is not answerable from the repository** —
the same limit as everywhere else in this file, and the container's log for that
night was not taken. All three items are thin-market fungibles that sit on the
floors this tool is full of, and the candidates are named rather than picked:
`POE_FAUSTUS_MAX_AGE_HOURS` (6 by default, shipped the day before — an
observation ages out and the item drops to the poe.ninja fallback, which for a
cheap thin line is often nothing), `MIN_EXCHANGE_UNITS` / `MIN_EXCHANGE_TURNOVER_C`
in `valuator.mjs` (`valuator.mjs` names essences as the population that sits
right at that floor, and a Runegraft line as one that fails it), and Faustus's
own `QUOTE_VOL_MIN` / `THIN_X_UNITS`, which decide per hourly digest whether a
market was informative at all. Any of them flipping across the hourly refresh
produces this. **The fix does not depend on knowing which**: whatever unprices
an item, the answer is the same.

**This IS a candidate for the 08:31 PM dip, and it is the first one that
explains the missing event as well as the dip.** The two candidates above
explain a dip; this one explains a dip *with an empty list*, for the reason the
first bullet already gives — `events()` buckets before it thresholds (hourly on
the 24h range), so a price that goes away and comes back inside one bucket
cancels its own phantom pair to nothing while the curve still carries the drop.
Both halves of the screenshot fall out of one mechanism. It is still not
established that it fired that evening: the age gate did not exist yet, but the
volume floors did, and nothing recorded says which items were priced that
minute. It is a candidate, not a diagnosis — the difference this entry has
insisted on throughout.

**Fixed 2026-08-14 — the diff now runs over stock, not over priced stock.**
`foldItems(items, unpriced)` folds the snapshot's unpriced names into the same
breakdown at a value of zero, and `server.mjs` hands the list along. A name that
loses its price is then still in the map: quantity delta 0, the whole value
change on the price side, which lands in the curve and in the detail panel and
in no event list. A name in neither list is gone and is booked as the outflow it
is. No new threshold and no new number — the repair is that the diff sees the
whole stash.

Two things it deliberately does not do:

- **It does not soften the split.** The value change is real and stays visible
  where prices live, which is the curve. It is not moved into the event list
  with a label, because then the list would no longer mean one thing.
- **It does not touch the recorded file.** The phantoms already on disk cannot
  be told apart afterwards — the stored row for one is byte-identical to the row
  for a real sale, and no field distinguishes them — so nothing is rewritten and
  nothing is marked. Any marking would need a "same name, same quantity, same
  value, within N hours" rule, i.e. a guessed N that would also flag a genuine
  buy-and-sell. They age out with the 15-day retention.

**And the cap that was left over is closed too (2026-08-14, same day).**
`aggregate.mjs` capped `snapshot.unpriced` at **100 names** ranked by piece
count, and the recorder was fed that list — so a name ranked out of it was
missing from the proof above and fell straight back into the old reading. That
was measurable: after the fix above, the phantom rows per block went from four
to six down to **two**, and the survivors were thinly traded items, which is
exactly the population the ranking cuts and exactly the population that drifts
between priced and unpriced.

The repair separates the two readers instead of enlarging the message, because
the cap exists for a real reason — an uncapped list over the wire is paid for by
every browser, on accounts with a great many unpriced names:

- `scan.mjs` writes each tab's stored unpriced list **uncapped**
  (`unpricedMax: Infinity`), bounded by the tab's own slots. The priced rows
  stored beside it were never capped.
- The recorder folds those stored lists account-wide inside the server
  (`unpricedStock`, `{name, count}` per name). **Nothing was added to the
  snapshot**: `snapshot.unpriced` is the same 100-name display list, and the page
  still states the pieces it is not listing from `tabs[].unpricedPieces`.
- No schema break and no re-scan: it is the same stored field, only no longer cut
  short. Tabs written before this still carry at most 100 names and cannot be
  helped by any fold, so completeness returns **tab by tab** over one round-robin
  lap — and until then nothing behaves worse than it did.

**Tests:** `history-unpriced.test.mjs` — the reported shape end to end (a price
that flickers off and back on produces no event at all, and the same run without
the unpriced list reproduces the mirror pair), the four diff cases apart, and the
two neighbours that must not change: the guard's release of a withheld arrival is
still an inflow, and a held item that is merely unpriced for one point still does
not end its hold. Then the cap, in the same file: a name pushed below the 100
busiest produces **no** stock movement, the same run fed the capped display list
brings the phantom departure back, the page's list is still 100 names with its
"not listed" pieces derivable — plus the call site in `server.mjs`, pinned
because the two lists look interchangeable there and are not. `aggregate.test.mjs`
holds the cap itself: it cuts the drawn list, it never cuts the stored one, and
`unpricedStock` merges a name across tabs into one entry.

**Next step, cheap and decisive:** a refusal now logs one `[networth-history]`
line when it starts and one when recording resumes. If the dip recurs without
either line around it, the cause is somewhere else and the remaining candidate
is a single tab being re-valued lower and restored on its next turn — for which
`POE_NETWORTH_DEBUG=1` (one line per synced tab) is the observation to take.

*(That remaining candidate turned out to be the next section, and it needed no
debug switch in the end: the tab was not re-valued lower, it was stored EMPTY.)*

**The route into that window is closed too (2026-08-11), and it was tracked here
rather than as an entry of its own:** `pruneTabs(user, [])` used to delete every
stored tab when a tab list came back empty — a wipe on one bad response, and the
only thing that made the partial-store window above reachable outside a fresh
install. A shorter list threw away its share the same way.

It was left alone deliberately until the log could say how often it happens.
That number is now in: with the warning line in place since `c481720`, **it did
not fire once in a full day of production logging** — short and empty lists are
not a routine event. So the repair is the conservative one rather than a
frequency-tuned one: **a stored tab is dropped only when two CONSECUTIVE tab
lists agree it is gone** (the intersection, so two lists that disagree about
which tab vanished confirm neither, and one whole list in between clears the
proposal). A single hiccup now costs a log line and nothing else.

No threshold on "how much shorter" was introduced, on purpose: that would have
been the third guessed number in this file, guarding against a frequency nobody
has measured. Requiring agreement needs no number, and it costs no request — the
second opinion is the list the refresher fetches on its own schedule anyway. The
price is that a tab genuinely deleted in game keeps showing its stored value for
one more list interval.

**The recorder gate itself was deliberately not touched in the same pass.** It
is what `refresher.test.mjs`, "after a short tab list wiped the store, coverage
reads incomplete again", pins down; changing the gate and its last known trigger
together would have left neither of them demonstrated. That test still drives a
wipe — it just needs the second empty list now.

### A fourth mechanism, and this one is a whole stash TAB (2026-08-14, fixed)

**Observed** hours after the fix above shipped, on the same untouched stash and
read straight out of `GET /networth-events`: one event over 18 points and about
50 minutes, **53 lines**, of which the largest were

| item | qty | value |
|---|---|---|
| Divine Orb | **−6** | **−1155.6 c** |
| Chromatic Orb | **−80** | −195.5 c |
| Chaos Orb | **−133** | −133 c |
| Enkindling Orb | −35 | −39.8 c |
| Grand Eldritch Ember | −6 | −69.7 c |
| Simulacrum Splinter | **+71** | +12.5 c |
| Orb of Alteration | +18 | |
| Sepia Oil | +25 | |

**This is not the mechanism above.** That one is about an item falling out of
the *priced* set; Divine Orbs and Chaos Orbs never lose their price, so those
lines cannot come from there. The size and the composition say something else:
the negatives are the whole content of the operator's currency tab, and the
positives the whole content of another. **A stash tab went missing, not an
item** — and because `events()` buckets before it thresholds, a tab that went
away near the start of the bucket and a tab that came back inside it net out to
exactly this: one tab's stock leaving and another's arriving, in one row list.

**The cause: an answer that carried no contents was stored as an empty tab.**
Two places said "empty" where they meant "I do not know", and both are one line
of defaulting:

- `stash-client.mjs`, ordinary tabs: `Array.isArray(j?.items) ? j.items : []`.
  A response that is HTTP 200 but not the documented shape produced an empty
  array, indistinguishable afterwards from GGG saying the tab holds nothing.
- `stash-client.mjs`, folder tabs: `catch { … return [] }` for everything that
  is not `auth`/`ratelimit`, and — the silent one — `finishFolderWalk` handing
  up its items even when a sub-tab had answered 200 with no items array at all.
  `folder-walk.mjs` was already COUNTING those (`withItemsArray`); it only ever
  said so when the total came to zero.

From there the chain is short and every link is in the repository:
`refresher.mjs` `step()` writes whatever `fetchTab` returned through
`store.setTab` — the tab is now stored, EMPTY, with a fresh `syncedAt`;
`coverageOf` counts it as covered, because from that level a stored empty tab
and a stored full one look the same; `server.mjs` `recordNetworthHistory` sums
the store and `history.append` writes the point with `syncComplete: true`; and
`buildDelta` has exactly one reading for a name in the previous map and not in
the current one — `dq = -q0`, the whole stock leaving at the price it had. On
the tab's next turn the same arithmetic runs backwards. **And the interval fits
the report**: the empty write stamps a fresh `syncedAt`, so the tab goes to the
back of the round-robin and does not come round again for a full lap — tens of
minutes, which is the length of the observed event.

**That HTTP 200 with the wrong body is real is not assumed here.** It is what B7
concluded from the map stash reading empty with no error line anywhere in the
log: *"the only way the code can do that after walking N children is a child
answering HTTP 200 with a body that is not `{stash:{items:[…]}}`"*. The same
shape on the ordinary endpoint empties an ordinary tab.

**Fixed — the three states are told apart where the response is.**

- **Read with contents** — GGG answered with items. Unchanged.
- **Read and empty** — GGG answered `items: []`. A fact about the stash, stored
  as one, and it does **not** block anything: owning an empty tab is ordinary.
- **Not known** — no answer about the contents: a 200 without an items array, a
  folder walk in which a sub-tab did not answer or GGG listed an entry the walk
  cannot address, or an unexpected status the folder path used to swallow. This
  now throws `kind: 'unread'`, which every caller already handles the way it
  handles a timeout: **the tab keeps its stored contents, nothing is written, no
  `onTabSynced` fires, and therefore no point is recorded out of that step.**
  `folderWalkComplete()` is the predicate for the folder case, and
  `finishFolderWalk` throws rather than returning a subset — so a walk driven
  tick by tick and one driven in a loop still behave identically (B5's promise).

Two things had to come with it, or the fix would have cost more than it saved:

- **A 429 mid-walk no longer eats its sub-tab.** The cursor advanced *before*
  the request, so the refused sub-tab was skipped and the resumed walk could
  never be complete — i.e. it would now be discarded, and keeping the walk over
  a 429 would have bought nothing. The cursor goes back for a `ratelimit` only.
  No retry loop: every other error drops the whole walk, and a sub-tab that keeps
  answering 429 costs one request per cooldown, which is the fewest possible.
- **`pickStalest` no longer pins the round-robin to a failing tab.** It read the
  attempt stamp only for a tab with NO stored data, so a tab that had been synced
  and then started failing kept its old `syncedAt`, stayed the stalest, and was
  picked again on every single tick, for ever. It takes the LATER of stored
  `syncedAt` and attempt stamp now — the unified timeline the comment above it
  always claimed. Without this, turning empty writes into failures would have
  turned one bad tab into a one-request-per-tick loop on that tab.

**And the residue, which is the coverage gate itself.** `coverageOf` counts a
tab as covered as soon as an attempt is stamped, and the stamp is set *before*
the request — so a tab that has never yielded a reading counts as covered from
its first try. That stays, deliberately: a tab that never becomes readable must
not stop the series for good, and its absence is then a constant in every point
rather than a dip in one. What it cost is the other direction — the first
successful reading of such a tab booked its whole content as stock ARRIVING —
and the same is true of a tab `pruneTabs` deletes, which `coverageOf` cannot see
at all, because that tab left the LIVE list, the very set coverage is counted
over. So the recorder compares the set of tabs the **snapshot** was summed over
(`createTabSetWatch` in `history.mjs`): when it differs from the last point's,
`append({ tabsChanged: true })` refuses that one point and forgets the previous
breakdown, so the next point starts the diff over on the new set instead of
diffing across the change. It refuses exactly **one** point — the watch updates
on every look, not only when a point is written — so neither a tab deleted in
game nor one that never becomes readable can stop the recording.

`coverageOf` also reports `tabsRead` now, and the recorder says once, in the
log, when it is writing points over less than the whole account. That is the
thing an operator could not see before: nothing distinguished a healthy series
from one recorded over an account with a tab missing from every point of it.

**What is visible from outside while nothing is being recorded** (all in
`docs/admin.md`'s log table): `[stash-client] … was NOT read in full`,
`[networth-refresher] a tab of <user> was NOT read and is left as it was
stored`, `[networth-history] the stash tabs <user> is summed over changed`, and
the pair `[networth-history] recording for <user> over N of M tabs` /
`every tab of <user> reads again`. The existing pause pair (`no points for X
until the sync covers the whole account` / `covered again`) is unchanged.

**The recorded phantoms stay, and this time some of them ARE recognisable
afterwards.** Nothing is rewritten — the file is the only record there is. But
unlike the single-item phantoms of the section above, a tab-sized one has a
signature a reader can apply by eye: **tens of names moving at once, in one
direction, each by its entire stock**, with the countermovement one round-robin
lap later. A row saying `Divine Orb −6` next to 52 others, on a stash nobody
touched, is that. It is not a rule the code applies — the stored rows are still
byte-identical to real ones, and any automatic marking would need a guessed
window — but it is a reading the operator can make of their own history.

**Does this close B2?** For the reported 2026-08-14 events, yes: it explains the
shape completely, including why both directions appear inside one bucket and why
the interval is tens of minutes. For the original **08:31 PM dip** it is now the
strongest candidate on the list — a whole tab dropping out and coming back inside
one hourly bucket is precisely a dip in the curve with an empty event list — but
it is still a candidate. Nothing recorded from that evening says which tabs the
store held that minute, and this entry does not turn a mechanism into a
diagnosis.

**Tests:** `backend/v2/networth/tab-unread.test.mjs` — the reported shape driven
through the recorder to show what an empty write produces, then that a tab which
does not answer writes nothing, re-stamps nothing, broadcasts nothing and records
neither a point nor a movement; that a genuinely empty tab does **not** block the
recording; that a failing tab does not pin the round-robin; and that a pruned tab
and a first-time-read tab each cost one point and no phantom, with the series
carrying on afterwards. Plus `folder-walk.test.mjs` (complete vs merely finished,
both shapes of incompleteness) and `stash-client.test.mjs` (a 200 without an
items array, a 404 on the folder endpoint, and `items: []` still meaning empty).

---

## B12 — The server tests reached poe.ninja (fixed, and there were four of them, not two)

Found while fixing B11 (2026-08-11) and **measured, not assumed**: with every
outbound `fetch` logged, `server.test.mjs` and `server-langs.test.mjs` each sent
two requests to `poe.ninja` — the currency-exchange overview and the beast
overview. They come from `warmLeague()`, which the WS connection handler calls
whenever a room's league has no warm C:D / reference cache
(`backend/v2/server.mjs`, the `!cdCache.has(...)` branch of the opening
handshake). Every test that opens a WebSocket walks into it.

**Fixed 2026-08-11, and the count was wrong.** Re-measuring with a recording
`fetch` over every test file that imports `server.mjs` found **four**, not two:
`mod-selection.test.mjs` and `ratelimit-banner.test.mjs` open a WebSocket as
well and were sending the same two requests each. The original measurement was
taken while chasing B11 and only covered the files that were in hand — which is
exactly why the fix ships with an instrument rather than a list.

**The fix is a switch of its own, not a wider meaning for an existing one.**
`POE_REFERENCE_DISABLED=1` was already set in all four files and does not cover
this; that is not a lie in the switch (`docs/admin.md` documents it precisely as
skipping *the one-time warm-up done at boot*), and stretching it would have
changed what an existing compose file does. The precedent is
`POE_PRICE_CHECK_DISABLED`, introduced for this same class — the foreground path
the background switches never covered. So:
`POE_REFERENCE_ON_CONNECT_DISABLED=1` covers the client-triggered warm-up, both
the WS-open branch and the `set-league` message, because otherwise "the server
reaches nothing" would depend on which message a browser happens to send.

**The assurance is measured, not promised.** `server-no-network.test.mjs` boots
the real server with the full set of switches, replaces `globalThis.fetch`
before the import, records every call and **rejects** anything that is not
loopback — so a regression fails an assertion instead of quietly costing a
request. It covers the three paths that used to send: a WS connect on a cold
league, a `set-league` switch, and a pasted item. Verified by removing the guard
again: three poe.ninja URLs are recorded and three tests fail.

**Where to look**
- `backend/v2/server.mjs` — `warmLeague()`, `REFERENCE_ON_CONNECT_DISABLED`, and
  the `set-league` branch
- `backend/v2/server-no-network.test.mjs` — the recorder
- `CONTRIBUTING.md`, "Local dev" — the env a server-booting test file has to set

---

## B13 — Seven more settings could not express zero (fixed)

The config block in `server.mjs` read eighteen numbers as
`Number(process.env.X) || DEFAULT`, an idiom that cannot express `0` and cannot
tell a typo from an unset variable. Those eighteen went through
`env-number.mjs` + `numeric-settings.mjs` first: zero is decided per setting and
an unusable value is reported instead of silently replaced (see "How a number in
this table is read" in [admin.md](admin.md)).

**Seven read sites further down the same file were not converted.** They shared
one helper — the same defect in another spelling, which is why the first pass
walked past it:

```js
const positiveEnvInt = (raw, fallback) => Math.max(1, Number(raw) || fallback)
```

`0`, `''`, `abc` and `-1` all landed on the default and none of them could be
told from "not set" afterwards.

**Fixed 2026-08-11.** All seven are rows in `numeric-settings.mjs` now, the
helper is gone, and each of them was decided on its own rather than by a rule
applied to the batch:

| Setting | Zero | Why, at the code |
|---|---|---|
| `POE_MAX_REQUEUE_ON_RECONNECT` | **honoured** | "re-queue nothing", and the only one of the seven that costs REQUESTS: a re-queued card is an `auto` Trade-API search (`enqueue({ kind: 'auto' })`), so a `0` that came back as 10 was ten searches per reconnect nobody asked for |
| `POE_RATE_LIMIT_BANNER_MIN_SEC` | **honoured** | "banner every rate-limit wait, however short". Display only — the local backoff happens either way |
| `POE_ASK_CONFLICT_ABS_GAP_C` | **honoured** | "no absolute gap required; the ratio alone decides" |
| `POE_MIN_ASK_EVIDENCE` | **honoured** | "no minimum listing count". The listings are already fetched when this is read: a confidence bar, never a request cap |
| `POE_MIN_CONFLICT_HEADLINE_C` | **honoured** | "mark sub-chaos headlines too", for investigating exactly the case the floor exists to suppress |
| `POE_MAX_ITEMS_PER_ROOM` | **refused** (min 1) | `enforceItemCap` evicts while `size > cap`, so a cap of 0 deletes every card as fast as it is created. No reading of it is what anybody meant |
| `POE_ASK_CONFLICT_RATIO` | **refused** (min 1) | the test is `headline >= ratio * askMedian`: at 0 every card is marked, and below 1 it fires when the headline is merely near the asks |

Three of them also became whole numbers (`POE_MAX_ITEMS_PER_ROOM`,
`POE_MAX_REQUEUE_ON_RECONNECT`, `POE_MIN_ASK_EVIDENCE`) plus
`POE_RATE_LIMIT_BANNER_MIN_SEC`, which is compared against GGG's `Retry-After`.
The two thresholds measured in chaos and the ratio stay fractional: half a chaos
is a real gap.

**Nothing an operator has set moves.** Every default is exactly what
`Math.max(1, Number(undefined) || d)` handed back, and the test that says so
(`numeric-settings.test.mjs`) types them out as literals rather than reading
them out of the table it is checking — a table compared with itself agrees
whatever it says.

**What DID change, and it is the point:** a value the tool cannot honour is now
reported instead of silently replaced. `POE_MAX_REQUEUE_ON_RECONNECT` thereby
becomes the third setting whose *refusal* sends more than was asked for (a typo
lands on 10 searches per reconnect), next to `POE_CORPSE_BUDGET_PER_HOUR` and
`POE_FAUSTUS_UNION_HOURS`. As with those two, the loud line is the protection:
refusing to boot over a compose typo would take the tool away and leave the
admin area unreachable to correct it.

**Where to look**
- `backend/v2/numeric-settings.mjs` — the seven rows, each with its answer to
  "is zero a setting here?"
- `backend/v2/numeric-settings.test.mjs` — `DEFAULTS_BEFORE_THE_SECOND_PASS`
- `docs/admin.md` — the seven rows, and "How a number in this table is read"

---

## B14 — A trade-API ban stops the stash refresher too (fixed), and a stash 429 still does not stop the trade queue (on purpose)

**State today.** While the global trade ban gate is up, the net-worth refresher
does nothing: `server.mjs` passes `tradeBanPause()` into the refresher's
`isPaused` hook, the tick asks it before it considers a request, and the pause
is reported like the 429 cooldown with `tradeBan: true` telling the two apart.
The gate lifting resumes syncing on the next tick — there is no second timer and
no state to get stuck. Before this, the gate held the *entire* trade queue
(price check, paste, corpse pricer) while the refresher went on reading a stash
tab every 30 seconds.

**What changed the answer, and what it is worth.** The entry used to argue the
other way, and the first of its two arguments was "different endpoint, different
budget". That one is gone — not because something in the code was measured, but
because the operator reported a past GGG ban that applied to the **whole
address**: it was not sat out but ended by taking a new address, the alternative
being roughly twelve hours. That is an account of an incident, not a measurement
in this repository, and it is recorded as one. It matches the two waits this
code has seen (3.7h and 11h) and it fits what GGG already publishes on the trade
side, where the rule name is `Ip` (`trade-audit.mjs`).

The second argument still stands and was paid, not talked away: **coupling
freezes the net worth for the length of the ban** and leaves a gap in the
history series. The asymmetry is what decides it — a frozen net worth is
annoying and heals itself the moment the ban lifts, while a ban costs every user
of the deployment at once and heals only with time or a new address. Between a
gap in a series and a request into a ban, the gap is the cheap one.

**The reverse direction — examined here, deliberately not coupled.** Nothing
stops the trade queue when the *stash* path takes a 429: the refresher's cooldown
is internal to it, and `pump()` gates only on the trade ban. It was left that
way, and the reason is a distinction the "shared IP budget" phrase blurs:

- A **429** means one rule's window is full. GGG's limits are published per rule
  group (`X-Rate-Limit-Rules`, one set for `/api/trade/*` and another for the
  stash endpoints), and two rules keyed to the same address still count
  separately. A full stash window therefore says nothing about the state of the
  trade window, and holding the price check — the one thing a user is standing
  in front of waiting for — would buy nothing measurable.
- A **ban** is the thing that spans the paths, and it arrives on the trade side
  with a gate already built for it. That is the direction that is now coupled.

What would change this: a stash 429 that behaves like a ban rather than a full
window — a `Retry-After` far beyond the rule's own window, or a `banSec` in the
published rules that we start acting on. Both are visible in headers the stash
client already parses, and neither has been seen yet. Acting on them today would
mean inventing a threshold with nothing behind it.

**What the rule names showed (B16, 2026-08-12/13).** The first stash response
of each process logs the rule sets (`[stash-client] GGG rate-limit rules for the
stash endpoints: …`), and they were read: the ordinary stash endpoint publishes
rules under the name `Ip` next to the `Account` ones (`Ip 45/60s`, `Ip 180/1800s`
while the cookie is accepted), the folder endpoint publishes `Account` rules.
So the stash reads spend an address budget, one that the household's browser and
this app's trade traffic draw on as well and that cannot be seen from here. That
is an argument for pacing and not for another gate: the stash pacer holds to
`POE_STASH_IP_BUDGET_SHARE` (0.5) of every `Ip` rule. The coupling stash 429 ->
trade queue stays off on purpose, and nothing seen contradicts the reasoning
above (a full stash window says nothing about the trade window). The ban
coupling in the other direction is unaffected: a ban on the address is a ban on
the address whatever the counters do.

**Where to look**
- `backend/v2/networth/refresher.mjs` — the `isPaused` hook, the pause edge in
  `tickOnce` (one log line and one status push per user, not one per tick), and
  the `tradeBan` branch in `statusFor`
- `backend/v2/server.mjs` — `tradeBanPause()` next to `rateLimitMsg()`, and
  `createNetworthRefresher({ isPaused: tradeBanPause })`
- `backend/v2/networth/stash-client.mjs` — `noteRateLimitRules`, the line that
  produces the remaining evidence
- Tests: `networth/refresher-status.test.mjs` (the pause, its wording, and that
  a stash 429 keeps precedence) and `ratelimit-banner.test.mjs` (the wiring, on
  a really booted server)

---

## B15 — Every unique map in the map stash was unpriced (fixed), and the tier was the key all along

**Observed** (2026-08-11, the first day the map stash delivered anything — see
B7): 48 items arrived from that tab and **not one** of them was priced. From the
page, verbatim:

```
48 unpriced items across 8 names (not counted)
Unidentified Map (Tier 16) ×40 (Uniques)
Cortex ×2 (Uniques)
Unidentified Map (Tier 15) ×1 (Uniques)
Hallowed Ground ×1 (Uniques)
The Vinktar Square ×1 (Uniques)
Mao Kun ×1 (Uniques)
Poorjoy's Asylum ×1 (Uniques)
Whakawairua Tuahu ×1 (Uniques)
```

The 41 **unidentified** ones are correct — before identification, which unique a
map is cannot be known, so no lookup could be honest. The other seven are
ordinary unique maps with real prices, and the tool has a route for exactly
them: `ninja.mjs` maps category `Map` to the `UniqueMap` overview,
`pricing-logic.md` describes it, and `valuator.test.mjs` had a green test for
it.

### Where they turned off, and what proves it

**The green test proved the route, not that anything reaches it.** It handed the
valuator a descriptor that already said `category: 'Map'`. Classification is
where these items ended.

1. **The base line is not a base name.** The label `Unidentified Map (Tier 16)`
   is produced by `unidentifiedLabel` in `kinds.mjs` as literally
   `Unidentified ${typeLine}`. So GGG's `typeLine` for these items is the string
   `Map (Tier 16)` — a base name with the tier baked in. That is a reading of
   production output, not a hypothesis.
2. **That name is in no index.** `categoryOfBase('Map (Tier 16)')` cannot hit:
   `items.ndjson` has an ITEM row `Map` with `craftable.category: "Map"`, and
   **every** unique map in it carries `unique.base: "Map"` — Cortex, Hallowed
   Ground, Mao Kun, Poorjoy's Asylum, The Vinktar Square, Whakawairua Tuahu
   included. There is no row whose name carries a tier. The base join therefore
   misses on **every** unique map, always. This is checked by a test that reads
   the shipped data.
3. Without a category, `ninjaTypeFor` returns `null` and the unique route
   returns `{ each: null }` — honestly unpriced, never `0`. That is precisely
   the failure the comment above `hasMapTier` in `kinds.mjs` already described
   for the *unique* stash; it was fixed there in July with a fallback on the
   item's `Map Tier` **property**, and that fallback is evidently not firing for
   the map stash's items.

**What is inference rather than observation:** step 3's last sentence. Two
things can make an identified unique map come back `null` — no category, or a
`UniqueMap` overview that has no confident line for the name. Ruling the second
one out would need a look at the live overview, and none was taken (no request
was made for this diagnosis). It is the less likely of the two: it would have to
be true of six well-known, liquid unique maps at once, whereas the broken join
in step 2 is proven and hits all of them by construction. **The cheap decisive
observation, if the maps are still unpriced after this fix:** with
`POE_NETWORTH_DEBUG=1` the scan already prints per-tab counts; the missing half
is one look at the `UniqueMap` overview for the current league, checking whether
its lines carry `count >= 5` (`MIN_CONFIDENCE` in `valuator.mjs`) — the overview
is fetched by the tool anyway, so this costs no extra request.

### Fixed

`uniqueCategory` retries the base join **without a trailing parenthesised
decoration** when the direct join misses: `Map (Tier 16)` → `Map` → `Map`. Not a
map-specific rule and not a name list, so it does not rot when GGG adds bases —
and no base name in the bridge data contains a parenthesis at all (asserted), so
the retry cannot resolve to a different item class. The direct join keeps
absolute priority, so no unique that is priced today changes value.

**The decoration is deliberately kept on `baseType`.** poe.ninja spells its
`UniqueMap` lines the same way (`baseType: "Map (Tier 8)"`, verified live), so
the existing baseType tiebreak in `fromItemOverview` becomes the map-tier match:
a Tier 15 item takes the Tier 15 line even when the Tier 16 line is the more
liquid one. That is the "map tier taken into account" the docs claimed, now with
a test under it.

**Where to look**
- `backend/v2/networth/kinds.mjs` — `uniqueCategory`, `undecorateBase`
- `backend/v2/networth/valuator.mjs` — `fromItemOverview`, the baseType tiebreak
- Tests: `networth/normalize.test.mjs` (the real `items.ndjson`, and the
  parenthesis guard), `networth/kinds.test.mjs` (the retry in isolation),
  `networth/valuator.test.mjs` (tier tiebreak, and two end-to-end cases that
  start at raw stash JSON)

---

## B16 — The derived stash pace was a one-way street (fixed)

**Observed** (production, 12.–13.08.2026, read off the rule-set log of one
account on one address):

```
12.08. 14:12 UTC   Account 30/60s ban 60s, Account 100/1800s ban 600s,
                   Ip 45/60s ban 120s,     Ip 180/1800s ban 600s      -> 24s spacing
12.08. 14:13 UTC   Account 15/10s ban 60s, Account 30/300s ban 300s   (the folder endpoint)
13.08. 02:15 UTC   Ip 30/60s ban 120s, Ip 90/1800s ban 600s,
                   Ip 180/7200s ban 3600s                             -> 80s spacing
13.08. 11:28 UTC   the 14:12 set again                                -> still 80s
```

The last line is the defect. `stash-pacer.mjs` keyed its rule table on
`` `${rule}:${windowSec}` `` and **never removed anything**, so the strict set of
02:15 — with a two-hour window nothing had published before — kept deriving 80 s
for the rest of the day, hours after GGG had gone back to publishing the set
that asks for 24 s. Only a restart cleared it.

**Why that is worse than it looks.** It is strictly one-way: any single strict
answer slowed the whole deployment down permanently. Nothing short of a restart
could undo it, and a new address (nightly on plenty of domestic lines, and it
resets the `Ip` counters) did not either. The refresher's throughput was
therefore decided by the strictest thing GGG had ever said, not by what it was
saying now.

### What the 02:15 set actually was: an unauthenticated request

Not a penalty, and getting this right changes what the tool should DO about it.
The legacy stash endpoint answers the *same* policy in two forms — `Account,Ip`
when the POESESSID was accepted, `Ip`-only when it was not, with the address
limit roughly halved in the second. Two independent sources say so: the
`gerwaric/acquisition` project measured exactly that on this endpoint on
28.07.2026, and a GGG web developer described the mechanism in the official
forum in 2018 (with a session id the budget is counted per account, and the IP
limit is then twice as generous). Our own two forms are that, digit for digit:

| rule | authenticated (11:28) | 02:15 | factor |
|---|---|---|---|
| `Ip` / 60 s | 45 | 30 | 1.5x |
| `Ip` / 1800 s | 180 | 90 | **exactly 2x** |
| `Account` rules | present | **absent** | — |
| a 7200 s window | — | 180, ban 3600 | only unauthenticated |

02:15 UTC is a night-time round with an expired cookie nobody was awake to
notice. **So the change of form is an alarm, not a reason to slow down** — and
the tool's entire reaction to it was to get slower, silently, for hours.
`noteSessionScope` in `stash-client.mjs` now names the state instead, once per
change and in both directions.

It is observation only, deliberately: an unauthenticated request cannot read a
private stash, so it is refused, and the refusal already travels the auth path
(401/403 -> `kind:'auth'` -> the user is paused, `cookie expired for <user> —
renew it on the settings page (Sync settings) or in networth-users.json` is
logged, and the sync status reads `expired` for them: the Net Worth and Settings
pages say so in their own sync line, History and Price Check in the shared
status line). A process-wide header
observation cannot name a user, and a false positive would freeze a healthy
refresher until somebody edited a cookie. What was missing was the sentence that
explains the change of pace, not a second way to stop.

**Whether the auth path also fired that night cannot be told from the material,
and it is not assumed here.** The observation is compatible with it — one
refused response, a paused user, a renewed cookie, and the pacer still holding
the withdrawn rules afterwards, which is exactly the defect above.

**Nothing was tightened on suspicion.** The authenticated set is digit for digit
what a third party measured on 18.07.2026 from another account, another address
and another continent: it is what GGG ships to everybody. GGG's penalties are
binary (a timed lock, a withdrawn credential, a Cloudflare block), never a
quietly smaller set of numbers.

**The union itself was not the bug** and is deliberately kept. The stash path
talks to two endpoints with two rule sets, and a folder tab is walked entirely
on the second one, whose rules do not mention the 1800 s windows the walk is at
risk of filling. Replacing set for set on every response would drop exactly the
limit that measures the walk.

### Fixed 2026-08-13 — with a header GGG was already sending

`X-Rate-Limit-Policy` names the budget a rule set belongs to and was not parsed
at all — and that is GGG's documented meaning of it rather than a convenient
reading: *"Policies may be the same across different API endpoints but are
treated the same for rate limiting purposes."* Same name, one shared counter;
different names, independent counters. It is now part of the rule key
(`policy \0 rule:window`), so **a response replaces the set of its own policy
and leaves every other policy standing**. The folder endpoint can restate its set thirty-one times during a
walk without touching the ordinary endpoint's windows, and a rule GGG has
withdrawn stops counting on the next response.

The direction that matters: this can only make the tool **faster** when GGG
publishes looser rules. It can never do so by forgetting a rule that is still
being published — `stash-pacer.test.mjs` runs a week of responses a minute apart
and asserts the pace does not move by a millisecond.

Two fallbacks, both conservative:

- **No policy header -> no replacement.** The set joins the union exactly as
  before. A missing header must not be able to make two endpoints look like one
  budget.
- **`POE_STASH_RULE_TTL_MS` (6 h)** expires a set nobody asks for any more. The
  floor under the dial is 2 h — the longest window ever observed here — because
  a request can still be counted inside a window for as long as the window is,
  and each rule is additionally kept for at least *its own* window whatever the
  dial says. Its dangerous direction is DOWN, so a refused value falls back up.

### And one number that is in no header at all

The same pass added the window RESOLUTION, because it explains something the
arithmetic could not: pacing that is correct against the published numbers still
collecting the occasional 429. GGG does not count requests as they arrive, it
buckets them — from GGG's support, to `gerwaric/acquisition`, about a stash
policy: *"That particular policy has a resolution of 5 seconds, which means that
it buckets incoming requests in 5 second intervals. To be safe you'd have to add
5 more seconds rather than 2. This isn't exposed anywhere for you to have
known."* Five seconds on the short limit, one minute on the sustained one.

A limit is therefore summed over whole buckets and `45 per 60s` really covers
60-65 s of wall clock, so the rate is derived against `windowSec + bucketSec`
and the reactive brake adds a bucket when it waits a window out. The surcharge
is 3.3 % on the measured set (24.0 s -> 24.8 s); adding a whole minute to every
derived GAP instead would be a 3.5x slowdown that nothing argues for, because it
is the window that is uncertain and not the gap. `POE_STASH_BUCKET_SHORT_SEC`
and `POE_STASH_BUCKET_LONG_SEC`, both floored at their default: they may
lengthen a wait and never shorten one.

**Where to look**
- `backend/v2/rate-limit-headers.mjs` — the policy, parsed and bounded
- `backend/v2/networth/stash-pacer.mjs` — the rule key, the replacement, `dropExpired`, `bucketSecFor`
- `backend/v2/networth/stash-client.mjs` — `noteSessionScope`, and the bucket in `delayFor`
- `backend/v2/numeric-settings.mjs` — `POE_STASH_RULE_TTL_MS` and the two bucket sizes
- `docs/admin.md`, "A rule set GGG has withdrawn stops counting" and "The rule names are also a session check"

---

## B17 — The exchange headline was 40 % above the in-game market, and the reason was its age, not its side

**Reported 2026-08-13 (Allflame), from the game window next to the tool.**

The price-check card for the divination card *The Chosen*:

```
206.6 c
EXCHANGE
Trade-Ask: 9–289.5 c · 10 listings          range 142–300 c
```

The in-game Currency Exchange at the same minute: selling one card returned
**147** chaos, buying one cost **180**. The tool's number sat above *both* sides
of the real market — above what a seller collects and above what a buyer pays.

### The first hypothesis was wrong, and a second card is what showed it

"Net worth is a liquidation value, so the tool is taking the wrong market side"
is the obvious reading, and it does not survive a second observation from the
same league, the same minute and the identical code path:

| card | tool | in-game sell | in-game buy | hour span shown |
|---|---|---|---|---|
| Imperfect Memories | 19 c | 21 c | 38 c | none |
| The Chosen | 206.6 c | 147 c | 180 c | 142–300 c |

*Imperfect Memories* is **10 % below the side a seller collects**. A rate that
systematically sat between bid and ask could not produce that — it would land
above 21, not under it. Whatever is wrong with *The Chosen* is not a side.

### What it is

`backend/v2/networth/faustus.mjs` walks back up to `POE_FAUSTUS_UNION_HOURS`
(8) completed hourly digests and takes, per market, **the newest hour in which
that market was informative**. It does not blend hours — the range on the card
is one hour's own low and high, not the window's, which is worth saying because
the window makes the obvious suspect. What it does mean is that a quiet market
keeps an old hour, and **the store had no way to say which**: one `updatedAt`
for the whole map, stamped when the refresher ran.

So both cards were labelled identically while one described the last completed
hour and the other described an hour that had traded 142–300c at a
volume-weighted average of 206.6 and had since been overtaken. Nothing on the
card, in the net worth or in the history said the two numbers were from
different times.

### Fixed 2026-08-13 — the observation hour is carried, shown, and gated

- `detail.at` records the unix hour a price was **observed** in (the hour of the
  market it came from — the divine market's hour for a bridged price), and it is
  persisted per item (`hours` in the faustus store; additive, no schema bump, an
  older file simply reports the age as unknown and ages in on the next tick).
- **The card says it, and only when it matters.** `rate is N h old` appears above
  the headline once the observation is older than the lag the pipeline cannot
  avoid — one digest hour (`lastHour`) plus one refresh interval. A fresh price
  carries nothing: a label on every card is not read.
- **The valuation stops using it past `POE_FAUSTUS_MAX_AGE_HOURS` (6).** The item
  then takes the same poe.ninja fallback the chain already has for a name Faustus
  never quoted, at no extra request. Card and net worth share the gate.
- The other three numbers on the card are now labelled for what they are — see
  the table in `docs/pricing-logic.md`. The third shape of card (`TRADE`, plain
  trade listings, where *The Trial* lands) names its source too; it was the only
  one that did not, which is why three divination cards looked arbitrarily
  different.

### What is still open

- **The market side is unmeasured.** Neither Faustus nor poe.ninja publishes a
  bid and an ask; both give one number per market, derived from matched trades.
  The two cards above bracket the residual bias (−10 % and, once the age is
  accounted for, some part of the remaining gap) but do not measure it, so no
  liquidation discount was applied — a haircut calibrated on *The Chosen* would
  push *Imperfect Memories* further wrong. **What would settle it, cheaply and
  with no extra request:** record the in-game sell and buy ratio for ten items
  spread over cheap/expensive and liquid/quiet, next to the tool's headline and
  the age it now prints, at one moment. That separates "how far is the headline
  from the mid" from "how far has the market moved since the hour" for the first
  time; today every observation confounds the two.

  **Two more of those readings arrived the same day and moved the question, not
  the answer** (see [B20](#b20--where-the-in-game-exchange-has-no-bid-the-tool-is-30-70x-high--and-no-source-it-fetches-carries-a-bid)):
  *Imperial Legacy* and *The Fathomless Depths*, both reported "No Stock" by the
  exchange, came out 30-70x high. That is not a side and not an age — it is a
  step, and it separates cleanly on whether a bid exists at all. The residual
  side bias stays exactly as unmeasured as this bullet says; what B20 adds is
  that the far bigger error sits somewhere else, and that a liquidation discount
  calibrated on any of these four rows would now be fitted to two different
  defects at once.
- **The default of 6 hours is a judgement, not an optimum.** It is bounded on the
  conservative side (it can only redirect to a fallback, never shorten the walk)
  and it is now calibratable from the screen: the card prints the age, so the
  first card that disagrees with the game says whether 6 is too generous.
- **The history steps once** where the gate changes which source prices an item.
  Nothing rebases it — old points carry totals, not per-item prices. The rise
  direction is still covered by the price guard; a drop is not held, on purpose.

**Where to look**
- `backend/v2/networth/faustus-age.mjs` — the age arithmetic, the gate, the label rule
- `backend/v2/networth/faustus.mjs` — `hourOf` in `fetchUnion`, `detail.at`
- `backend/v2/networth/valuator.mjs` — `fromFaustus`, the per-item gate
- `backend/v2/server.mjs` — `faustusChaosFor`, `faustusStaleHoursFor`, `withExchangeMain`
- `docs/pricing-logic.md`, "What the number MEANS" and "What each number on the card is"

---

## B18 — "40 unpriced items across 1 names" over a list adding up to 39 (fixed)

**Reported 2026-08-13 (Allflame), from the Net-Worth page with a single stash
tab selected:**

```
40 unpriced items across 1 names (not counted)
  Unidentified Map (Tier 16) ×39 (Uniques)
```

The headline and the one row under it disagreed by one, and the same block had
added up exactly two days earlier (B15: `48 unpriced items across 8 names` over
rows summing to 48).

### Two numbers, two units, one word

`aggregate.mjs` counted the unpriced items twice, in different units, and the
page printed both as "items":

```js
if (!e.value) {
  unpricedCount++                 // +1 per stash ENTRY  -> counts.unpriced
  const stack = e.desc.stack ?? 1
  if (u) { u.count += stack }     // += STACK SIZE       -> the row's ×N
```

The headline came from `counts.unpriced` (or `tabs[].unpriced` when the
selection was narrowed), the rows from `count`. While every stack is one they
coincide — which is why the B15 screenshot added up, and why this went unnoticed
for as long as the unpriced bucket held nothing but single items.

They diverge in **both** directions, and both were reproduced against the real
`aggregate()` (`aggregate.test.mjs`):

- one unpriced five-stack → headline **1**, list **5**. The headline is too
  small, and nothing on the page says why.
- an entry with stack size **0** → headline **1**, list **0**. `?? 1` does not
  catch it: `0` is not nullish.

### Where the reported one actually came from — and it was not a stack of zero

Stack size 0 is **unreachable** through the production path: `normalize.mjs`
clamps GGG's `stackSize` with `> 0 ? … : 1`, and every classifier in
`kinds.mjs` either passes that value through or hardcodes `1` (unique maps, the
items in the report, are the hardcoded kind). So the missing piece was not a
piece at all — it was a **row**.

`aggregateFromTabs` caps the unpriced list at 100 **names**, ranked by their
total count **across all tabs**. The cap is account-wide, so a name with one
piece in one tab is ranked out by 100 busier names in *other* tabs, and the row
vanishes from a tab whose own list is a single line — while `tabs[].unpriced`,
the faithful entry count the headline used, still counts it. Reproduced exactly:
a tab holding `Unidentified Map (Tier 16) ×39` plus one `×1` of another name,
behind 120 busier names elsewhere, renders as "40 … across 1 names" over a list
of 39.

**What is inference rather than observation:** that the production account had
crossed 100 distinct unpriced names on that day. Nothing was read from the live
store (no request was made for this diagnosis). It is the only mechanism that
produces this exact shape without a zero stack, and zero stacks are ruled out
above. **The cheap decisive check, from the page's console:**
`new Set(currentSnapshot.unpriced.map(u => u.name)).size` — exactly 100 means
the cap is biting.

### Fixed

- **`counts.unpricedPieces` and `tabs[].unpricedPieces`** carry the piece total
  next to the entry counts, counted over *every* unpriced entry including the
  ones the cap keeps out of the list. Additive, no schema bump: a tab stored
  before the field existed falls back to its own row sum until the refresher
  next reaches it.
- **The summary line states what the list states** — pieces and names, both
  taken from the rows on screen — and appends `· N pcs not listed` when the
  faithful per-tab total is larger. It can no longer contradict the list under
  it, whichever way the two would have drifted.
- **`pieceCount()`** clamps a stack the way `normalize.mjs` does, so the
  unreachable zero stays unreachable one level further in.
- `across 1 names` → `across 1 name`, through the `tn()` plural the i18n already
  had (`nw.unpricedNameOne` / `…Other`).
- **A second site of the same mistake, found while looking:** the sidebar's
  per-tab tooltip printed `{priced} priced · {unpriced} unpriced · {skipped}
  skipped` where the first number was `tabs[].items` — grouped display **rows**,
  not entries. A currency tab whose 3 stash entries of Divine Orb fold into one
  row read "1 priced · 0 unpriced · 0 skipped". `tabs[].priced` now carries the
  stored entry count, so all three are the same unit.

Nothing about pricing or the total changed: every item in this block was already
excluded from the sum, and still is.

**Where to look**
- `backend/v2/networth/aggregate.mjs` — `pieceCount`, `unpricedPiecesOf`, the
  three-unit note at the top
- `backend/v2/frontend/networth.js` — `renderUnpriced`, `unpricedPiecesInSelection`,
  `tabPricedCount`
- `backend/v2/frontend/PROTOCOL.md` — the unit table on the snapshot
- Tests: `networth/aggregate.test.mjs` (both drift directions, the cap, the
  per-tab piece counts), `frontend/networth-unpriced-tabs.test.mjs` (headline
  and list agree in a real browser, stack > 1 and stack 0), `frontend/i18n-dynamic.test.mjs`

---

## B19 — A name pattern skipped the WHOLE map stash (reverted 2026-08-13; the measurement answered on 2026-08-19 and the rule came back the other way round)

**Observed 2026-08-13 (Allflame), from the production log, hours after the
feature that caused it was deployed:**

```
folder tab "Maps": 0 sub-tabs read over 1 steps in 0s, 39 skipped on purpose
yielded 0 items — 39 sub-tabs, 39 not requested on purpose
```

The map stash was not read at all — `Unique Maps` and `Special Maps` included —
so roughly **165 chaos** dropped out of the net worth, and the history recorded
the lower number as if it were the account.

### What the feature did, and what it assumed

A folder tab costs `1 + N` requests and the map stash's `N` was ~37 — half of a
full refresher lap for one tab. The tier sub-folders hold only normal maps,
which the classifier drops as `skip`, so reading them changes no number on the
page. The feature stopped requesting them and kept `Unique Maps` and `Special
Maps`.

It identified a tier folder by its **name**, matching a pattern end to end:
`Tier: 16`, `Tier 16`, `T16`, `XVI` — **and a bare number, `16`**, on the
argument that a map stash's children are laid out by GGG rather than named by
the player, so in *that* parent a child called `16` can only be the tier folder.

### What GGG actually returns

The log line the same commit added — one line per folder tab per process,
written precisely because the naming had never been measured — answered it on
the first lap:

```
folder tab "Maps" (MapStash) sub-tab shape as GGG returns it, once per process:
39 children, entry fields: id,parent,name,type,metadata —
"1" type=MapStash, "1" type=MapStash, … "2" type=MapStash, …
```

The children are called **`"1"` and `"2"`** — *page numbers*, not section names —
and every one of them carries the same `type=MapStash`. "A name that is nothing
but a number" therefore matched **all 39**, `Unique Maps` and `Special Maps`
among them. The unique stash was untouched only by luck: its 20 children have
**empty** names, and an empty name was one of the cases the rule refused to
judge.

### The safe direction was real and it was aimed at the wrong half

The feature was built around "every case the rule cannot judge is READ, so a
wrong pattern costs requests and never data", and that reasoning holds — for a
name the pattern does **not** match. It says nothing at all about a pattern that
matches **too much**, which is the failure that actually happened. A guard that
only protects against under-matching is not a guard on a matcher whose reach is
unknown; it reads as one, which is worse than having none.

### Reverted 2026-08-13, and nothing was left dormant

- **The whole skip mechanism is gone** — the rule, both environment variables
  (`POE_STASH_MAP_TIER_SUBTABS`, `POE_STASH_TIER_SUBTAB_PATTERN`), the
  `skippedSubTabs` field on a stored tab, the counts on the log lines and in the
  `folderTab` status, and the page's "N sub-tabs are deliberately not read" line
  and tooltip. A folder tab is read whole again, exactly as before the feature.
- **No setting was kept.** A switch that can only be turned on by deleting value
  from the net worth without saying so is a trap and not a setting, so the
  allow-list row went with it: a checkbox that does nothing has no business on
  the admin area's list.
- **The request volume goes back up** to what it was before — the map stash is
  `1 + N` again. That is the intended direction: it was never a problem, and it
  is the price of not guessing.
- **The measurement stays** (`backend/v2/networth/subtab-shape.mjs`), and it now
  reports the one thing it did not: the **content** of each child's `metadata` as
  JSON, plus any further field of a child by value, plus the parent's own fields
  and metadata. Foreign data, so it goes through the project's credential filter
  (`secret-keys.mjs`), has its control characters stripped and is length-capped.
  Still one line per folder tab per process, still zero extra requests, and it
  decides nothing.
- **Is a child's section knowable at all?** `name` is a page number and `type`
  is the parent's type repeated on every child; `metadata` was the last free
  candidate, and it answered on 2026-08-19 (see "Closed 2026-08-19" below).
  **There is no second guessing path**, and rebuilding one on anything but a
  measured field is the mistake this entry exists to prevent.

### The lesson, and it is not about maps

**A detection built on an unverified assumption about foreign data ships
DEFAULT-OFF. Measure first, switch on second.** The log line that would have
settled this was written, shipped and correct — it simply travelled in the same
commit as the rule that depended on its answer, so the rule was live in
production for hours before its own evidence arrived. One lap of the refresher
was the entire cost of doing it in the right order.

Two rules follow from that, and they are cheap:

1. **A rule that filters out data does not ship on in the same commit as the
   measurement that justifies it.** Ship the observation, read the log, then
   ship the rule — in that order, as two deployments.
2. **State the failure direction for BOTH sides of a matcher.** "Anything I
   cannot identify is kept" is only half an argument. The other half —
   what happens when it identifies something it should not have — is the half
   that costs data, and it is the one an unmeasured pattern is most likely to
   get wrong.

**Where to look**
- `backend/v2/networth/subtab-shape.mjs` — the observation that is left, and the
  history at the top of it
- `backend/v2/networth/stash-client.mjs` — `listTabChildren`, which reads every
  addressable child and logs the shape
- `docs/admin.md` — "Every sub-tab is read except the map stash's tier pages, and the log says which those were"
- Tests: `networth/subtab-shape.test.mjs` (what the line shows, the redaction,
  the caps, once per process), `networth/stash-client.test.mjs` (a map stash
  whose children are called `"1"`/`"2"` is read completely, whatever is in the
  environment)

**Closed 2026-08-19 — the measurement answered, and the rule was rebuilt the
other way round.** The observation line ran on the production account after the
19.08. deploy and printed what a name never carried:

```
"1" type=MapStash metadata={"items":70,"map":{"section":"tier16","name":"Map (Tier 16)","index":0}}
"1" type=MapStash metadata={"items":16,"map":{"section":"unique","name":"Maelström of Chaos","index":0}}
"1" type=MapStash metadata={"items":28,"map":{"section":"special","name":"Shaper Guardian Map","index":0}}
```

`metadata.map.section` is GGG's own label for the page. Across 43 children it
held three shapes: `unique` (16), `special` (10) and `tier<N>` (14 pages over
13 tiers — tier16 has two). The skip
came back on that field — and, per rule 2 above, **the failure direction is the
opposite one**: it skips only what explicitly says `tier<N>`, so a missing
`metadata`, an unknown section or a stash shaped differently is READ. The worst
a misreading can now do is cost the requests it was trying to save, where the
name rule's worst case cost a whole tab.

That is also why it is on by default while the name rule had to be off: the two
switches are not the same switch. `POE_NETWORTH_SKIP_TIER_MAPS=0` reads
everything, and every walk logs how many sub-tabs it passed over and which
sections they were — unconditionally, because value left out of a tab on purpose
must not be indistinguishable from stock that vanished.

Measured on the first walk after the deploy:

```
folder tab "Maps": 14 of 43 sub-tabs not read — GGG lists them as tier16 x2,
tier1, tier11, tier12, tier13, tier14, tier15, tier2, tier4, tier5, tier6,
tier7, tier8, i.e. pages of normal maps, which carry no price.
folder tab "Maps" (index 2): 43 sub-tabs over 30 steps in 871s
```

30 steps where the same tab took 44, and 871s where it took 1291s. `Unique` and
`Special` were read in full and the tab was written — which is the half of the
result that B19 is actually about.

- `backend/v2/networth/map-sections.mjs` — the rule, and why this one may decide
- Tests: `networth/map-sections.test.mjs` (every fall-through case one by one,
  including a child NAMED `16`), `networth/folder-walk.test.mjs` (a skip costs
  no request and no step; an unanswered sub-tab still blocks the tab)

---

## B20 — Where the in-game exchange has NO BID, the tool is 30-70x high — and no source it fetches carries a bid

**Reported 2026-08-13 (Allflame), from the game window next to the tool: four
divination cards, each read against the in-game Currency Exchange at the same
minute — the same market the Faustus digest is made of, only live and with both
market sides visible.**

| card | tool | in-game sell (player hands over) | in-game buy | bid there? |
|---|---|---|---|---|
| Imperfect Memories | 19 c | 21 c (21:1) | 38 c | yes |
| The Chosen | 206.6 c | 147 c (147:1) | 180 c | yes |
| **Imperial Legacy** | ~4.6 c (14 pieces = 64 c) | **1 chaos for 14 pieces** ≈ 0.07 c | 1 c | **"No Stock"** |
| **The Fathomless Depths** | 15 c (2 pieces = 30 c) | **1 chaos for 2 pieces** = 0.5 c | — | **"No Stock"** |

**The pattern is binary, not gradual.** Where a real bid exists the tool sits at
0.9–1.4x of it. Where the exchange reports "No Stock" it sits **30–70x** high.

Two earlier readings are refuted by this and should not be revived. **"The tool
takes the wrong market side"**: *Imperfect Memories* is 10 % *below* the side a
seller collects, and no side offset produces a number under the bid (B17 said
the same from two of these four rows). **"The rate is too old"**: an eight-hour
window does not move a card by a factor of 70. Both describe gradual effects;
this one is a step.

### What the tool can see, and what it cannot

Nothing in this pipeline carries a bid, an ask or stock:

- the GGG digest gives, per market, `market_pair`, `lowest_ratio`,
  `highest_ratio` and `volume_traded` — **matched trades only**. `detail.sell`
  looks like two sides, and is not: `sell.chaos` and `sell.divine` are the same
  item's two *markets* (against Chaos, against Divine), each with the volumes
  that **filled** on both legs. There is no `volume_offered` anywhere.
- poe.ninja's exchange line is one number (`primaryValue`) plus that line's
  turnover (`volumePrimaryValue`). Also trades, also no book.

"No Stock" is a statement about the **order book**, and the order book is only
in the game client and behind the trade API. Reading it would mean a third
request against GGG for every priced name, which this project does not spend
(two trade-API bans and one address-wide ban stand behind that rule).

So the question "is anybody bidding" **cannot be answered from the data the
tool has**, and this entry does not pretend otherwise. What *can* be said is
what a no-bid market looks like from here: no bid means no fills, so the item
simply stops appearing in the digest hours — and its price then comes either
from the last hour in the union window in which somebody's order was filled, or
from a poe.ninja line aggregated over a longer window. Both are prices of trades
that are over.

### Why the thin-market bars did not fire — file and line

- **`QUOTE_VOL_MIN[CHAOS] = 50` in `backend/v2/networth/faustus.mjs`.** This
  is the ONLY absolute evidence bar on the direct chaos path
  (the two comparisons against `QUOTE_VOL_MIN` in that file, plus `volX >= 1`). Fifty chaos is under half a
  divine. At the tool's own numbers that is **11 pieces** for Imperial Legacy
  and **3.4 pieces** for The Fathomless Depths — one careless fill in one hour
  out of eight.
- **The `winVolX < THIN_X_UNITS` condition in `faustus.mjs`** — the cross-hour check (the
  Broken Truce fix, which was built for a "No Stock" card too) only *starts*
  when the winning hour traded fewer than `THIN_X_UNITS = 10` **pieces**. A
  piece count is blind at the cheap end: 11 pieces of a 0.07c card are 0.8
  chaos of merchandise and already count as "not thin", so the check never
  looks. That is the mirror image of the lesson this repo learned three times
  at the expensive end (`backend/v2/sell-side.mjs` `isTurnoverAttested`, `valuator.mjs`
  `MIN_EXCHANGE_TURNOVER_C`, the `QUOTE_VOL_MIN` comment itself): **a flat
  piece count measures how cheap an item is, not how well evidenced it is.**
- **The `deepVolX >= DEEP_HOUR_VOL_RATIO * …` condition right below it** — even when the check does start, it needs
  another hour in the window with ≥ 3x the volume that itself clears the
  10-piece floor. A card nobody bids on does not trade in the other seven hours
  either, so there is nothing to compare against and the check abstains. That
  abstention is deliberate and load-bearing (it is what keeps Mirror of
  Kalandra priced) — a no-bid market and a genuinely rare one are
  indistinguishable from here.
- **`exchangeLineValue()` in `backend/v2/networth/valuator.mjs`**
  (`MIN_EXCHANGE_UNITS`, `MIN_EXCHANGE_TURNOVER_C`) — on the poe.ninja
  fallback the bar is 10 traded units OR 2000 chaos of turnover with at least
  one completed trade. Ten units of a cheap card is ~50 chaos again.
- **The age gate (B17) covers Faustus only.** The fallback it hands an aged
  item to carries no per-item observation time at all (`server.mjs`,
  `toNinjaPriceResult`), so an item that ages out of the digest lands on a
  number of unknown age with no gate behind it.

Put together: between "no bid at all" and a number in the net worth stand
**50 chaos in one of eight hours**, or **ten pieces on poe.ninja** — one to two
orders of magnitude under what the same repository demands before it will so
much as *claim* something about the same market (`SELL_MIN_QUOTE_TURNOVER_C =
5000`, sell-side.mjs).

### Which feed produced the two wrong numbers is unknown

Divination cards are priced Faustus-first, poe.ninja-card-exchange second
(`kinds.mjs`, `divcard`), and **both paths admit the reported magnitudes** —
pinned from the constants, not guessed, in `networth/faustus.test.mjs` and
`networth/valuator.test.mjs` (marker `B20`). The Net-Worth page did not name the
source of a row, so the report cannot say which one it was. That gap is closed:
the table has a **Source** column now (`faustus`, `exchange:DivinationCard`, …),
the same identifier the store and the price-guard log already used. It changes
no price; it makes the next report answerable.

### What was deliberately NOT built

**No new threshold.** The four measurements do not license one. They give a
*lower* bound on the evidence behind the two wrong numbers (≥ 50 chaos, ≥ 10
pieces — that is what it took to be priced at all) and **nothing at all** about
the evidence behind the two right ones. A bar would have to be placed between
"at least 50" and "unknown", which is a guess wearing four data points as a
costume.

Two candidates were considered and both are refused *for now*, with reasons:

- **Reuse `SELL_MIN_QUOTE_TURNOVER_C = 5000` on the Faustus chaos path.** It is
  the existing turnover concept, it does not punish expensive items, and it is
  what the operator's guidance points at. But `valuator.mjs` says in as many
  words that this number comes from a different market/pair shape and does not
  transfer, and applying it here would unprice every market under 5000 chaos of
  hourly turnover across *every* stackable category at once — an unmeasured
  swing far bigger than the defect, and in a direction that cannot be checked
  against anything measured today.
- **Compare the two sources against each other.** Both are already fetched, so
  a per-name Faustus-vs-poe.ninja check costs no request, and the tolerance for
  exactly that comparison has already been measured for the ask-conflict marker
  (`server.mjs`: 505 Allflame fungibles priced by both on one day, honest
  divergence ≤ 2.4x, everything measurably broken ≥ 9x, ~1 % of lines beyond
  4x). What is missing is the evidence that it would touch *these* cards:
  nobody knows whether the two sources disagree for them, and if the wrong
  price came from poe.ninja while Faustus stayed silent, there is no second
  opinion to compare with. It would also turn a marker that was deliberately
  built to *annotate* into one that *unprices*.

### The measurement that decides it — no request, no game

For the four names above, read together at one moment on the running host:

1. `/config/faustus-store.json` → `prices[name]` (does the digest price it at
   all), `sell[name]` (`[perItem, volX, volQuote]` per market side — **the
   turnover behind the number**), `hours[name]` (which hour it was observed in).
2. `/config/networth-store.json` → the row's `source`, now also on screen.
3. Where the source is a poe.ninja route, that route's own number for the name
   (the price-check card prints it).

That yields the two things this entry lacks: **which feed** produced the two
wrong prices, and **how much turnover stood behind the two right ones**. The
second is the one a threshold needs — today only a lower bound is known, and
only for the wrong side of the comparison. Ten names spread over
cheap/expensive and liquid/quiet make it a calibration instead of an anecdote;
four make it a diagnosis.

### It is not a divination-card problem

Every category Faustus prices runs through the identical chain and the identical
floors: currency, fragments, essences, scarabs, fossils, resonators, oils,
delirium orbs, tattoos, omens, artifacts, runegrafts, allflame embers,
astrolabes — and the cards. Cards are simply where dead names are common (a few
hundred names, most of them junk), and where a wrong price is largest relative
to the truth. Uniques and gems do not use these floors (they go through
poe.ninja's `count >= 5`), so nothing here has been measured about them.

### What happens to the history when this is fixed

Nothing has changed yet, so nothing steps yet. When a fix does land, items that
lose their price leave the sum and the curve steps **down** once — a definition
change, not a loss, and the machinery says so on purpose: recorded points hold
totals and the previous breakdown, not per-item prices, so nothing can be
rebased; the price guard holds a 20x/25 % *rise* and deliberately does not hold
a drop; and the artefact cleanup only removes a stretch that rises and comes
back, which a one-time step does not do. See "A change in what a price MEANS
moves the curve" in `docs/pricing-logic.md`. The honest handling is to say in
the release which day the step belongs to.

**Where to look**
- `backend/v2/networth/faustus.mjs` — `QUOTE_VOL_MIN`, `THIN_X_UNITS`, the
  cross-hour check in `buildDetailById`, `detail.sell`
- `backend/v2/sell-side.mjs` — the turnover concept and why a piece count is the
  wrong instrument
- `backend/v2/networth/valuator.mjs` — `MIN_EXCHANGE_UNITS` /
  `MIN_EXCHANGE_TURNOVER_C`, the fallback the age gate hands items to
- `backend/v2/frontend/networth.js` — the `source` column (`COLS`, `srcLabel`)
- Tests: `networth/faustus.test.mjs` and `networth/valuator.test.mjs` (marker
  `B20`: what the four numbers need to exist, on both candidate paths),
  `frontend/networth-source-column.test.mjs` (every priced row names its feed)

---

## B22 — A five-part patch version froze the German data set (fixed)

**Observed** (container log, 2026-08-15, 2026-08-16 and 2026-08-17, the same
line word for word all three days):

```
[data-refresh] lang-data check failed (kept last good state):
https://ggpk.exposed/version?poe=1 answered "https://patch.poecdn.com/3.29.3.1.2/"
— no patch version in that path; last success 2026-08-13T02:17:45.212Z
```

Nothing here is inferred. The lookup answered, the answer was well formed, and
the tool refused it: **the version has five parts** (`3.29.3.1.2` — a hotfix on
a hotfix), while `PATCH_RE` in `backend/v2/lang-data-gen.mjs` read
`/^\d+(?:\.\d+){1,3}$/` and therefore accepted at most four. The last accepted
version was the four-part `3.29.3.1`; the last successful check is the timestamp
the failure line itself carries, **2026-08-13**.

**The consequence is not cosmetic, and it was measured too.** The English set
kept updating while the German one stood still — the `apt` line of 2026-08-17:

```
stats.ndjson 8648->9182 lines (+542/-8), items.ndjson +48/-47; German set carried over unchanged
```

That carry is the documented skew policy working as intended (English is never
held hostage by a language it does not use), but it is only meant to bridge a
day. Here it ran for four, and every one of those days the German set fell
further behind: 542 stat lines and 48 item lines that a German client's items
can be worded with and the German data set does not know. It is exactly the
drift `lang-skew.mjs` reports in the admin area, and the source's own row aged
into the `no successful check of lang-data for N days` note — which is how it
was noticed at all.

**Fixed** by taking the part count out of the pattern: `/^\d+(?:\.\d+)+$/`. A
patch version is digits and dots with at least two parts and **no upper bound**
on how many, because the number of parts is GGG's to choose and not ours to
predict. Deliberately no looser than that — the string is pasted into a CDN path
(`patch.poecdn.com/<patch>/Bundles2/…`), so `latest`, `3.29.x`, `3.29.`,
`../../etc`, a bare `3` and anything else without the shape of a version are
still refused, on the lookup path and through `POE_PATCH_VERSION` alike.

**Recognising the version was only half of it**, so the second half was checked
rather than assumed: a five-part version reaches `config.json` verbatim, the
exporter builds `https://patch.poecdn.com/3.29.3.1.2/Bundles2/_.index.bin` from
it (`toCdnUrl` in `pathofexile-dat`, pinned by a test that calls the real
function, offline), names its bundle cache after it, and the refresher writes it
back into `build-info.json` unchanged — which is what makes the Soll/Ist
comparison terminate instead of regenerating on every tick. Nothing normalises
or re-splits the version anywhere in between; `staleLangs` compares strings.

**Why this could sit for four days.** The check reported `failed` every single
day, exactly as designed, and the failure line named the reason in full. What is
missing is not the signal but the reading of it: the browser only shows the
staleness note after `POE_DATA_REFRESH_MS × POE_DATA_STALE_TICKS` (3 days by
default), and it says how long, not why. The `why` lives in the container log.
`docs/admin.md` now names this case under "Where the patch version comes from".

**Where to look**
- `backend/v2/lang-data-gen.mjs` — `PATCH_RE`, `resolvePatchVersion()`
- `backend/v2/data-refresher.mjs` — `tickLangData()`, `staleLangs()`
- Tests: `lang-data-gen.test.mjs` (the observed string is a case: five parts,
  four parts, and the list that stays refused, both paths),
  `data-refresher.test.mjs` (a five-part version through generator, log line and
  `build-info.json`, and the run terminating afterwards)

---

## B23 — The German set built again, and its own coverage check threw it away (fixed, and the fix is not a looser bar)

**Observed** (container log, 2026-08-18, the first generation run after
[B22](#b22--a-five-part-patch-version-froze-the-german-data-set-fixed) let the
patch version through again):

```
Unresolved matchers (487):
Validation:
  stats 9278 -> 9278, without matcher 505
  matcher list longer 37, shorter 525
  ERROR: coverage gap too large: 505 of 9278 refs without a matcher (5.44 %, allowed 1.00 %)
[data-refresh] generating data/de FAILED (validation failed with 1 error(s) — nothing written)
```

The obvious suspicion was a regression in the derivation: coverage had been
99.7 % when the generator was built (cross-checked at the time against upstream's
own sets, `ru` 99.02 %, `ko` 95.14 %) and was now 94.6 %.

### It is not a regression, and the run's own numbers prove it

Two of the printed numbers do not move when English grows, and both are
**identical** to the reference measurement — the checked-in English set of
2026-07-31 (8 198 lines, 8 292 stats after flattening) against the German set
generated from it on 2026-08-08:

| | reference, 08-08 | production, 08-18 |
| --- | --- | --- |
| stats (flattened) | 8 292 | 9 278 |
| without a matcher | 20 | 505 |
| matcher list **longer** | **37** | **37** |
| matcher list shorter | 40 | 525 |
| shorter **but still covered** | **20** | **20** |

`longer` counts the stats where the derivation produced MORE forms than English
has — the declension splits and the `line+template` pairs, the hardest thing the
resolver does. It is unchanged to the unit.

`shorter but still covered` is `shorter` minus the stats that went to no matcher
at all. Every English stat in this data carries at least one matcher (measured:
zero exceptions), so a stat with no German matcher is necessarily also
"shorter" — the two numbers overlap by construction. Subtract the overlap and
the remainder is the population that resolved *partially*: 40 − 20 = 20 in the
reference, 525 − 505 = 20 in production. Also unchanged to the unit.

So nothing that resolved before resolves worse now. The whole difference is
**485 stats that resolve to nothing at all**, and they are new: the English set
grew from 8 648 to 9 182 lines in the same window (B22, the `apt` line of
08-17), which is ~534 stats after flattening. 485 of ~534 — about 91 % of the
newly added English material has no German form, while 100 % of the older
material still has exactly the one it had.

The unresolved-matcher count agrees: 487 matchers could not be resolved for 505
uncovered stats, i.e. essentially one dead matcher per dead stat. The remaining
~18 are the known residue — English lines the game data translates two different
ways, which the resolver refuses rather than guesses — and that residue was 20
in the reference.

### `matcher list shorter 525` is the same finding, not a second one

505 of the 525 are the stats with no matcher at all, counted again from the
other side. The 20 that remain are the pre-existing partial cases. The report
prints the split now (`shorter 525 (505 of them down to no matcher at all, 20
still covered)`) so the number stops reading like an independent second defect.

### What was actually wrong: the gate measured the wrong population

`validate()` refused the run when `uncovered / every English ref` passed 1 %.
That denominator is the English set, which comes from an upstream shipping on
its own schedule, while the German side is derived from the game data of one
patch. When upstream runs ahead, English gains stats whose text is in no
description file the export carries — and no correct generator can produce a
German matcher for a line that does not exist in the game data it reads.

The refusal then keeps the PREVIOUS German set live. That set does not carry
those stats **at all** — it was built from an older English skeleton. A stat with
an empty matcher list and a stat that is missing outright are the same thing to
every reader of this data: no match. So the refusal closed none of the 485 gaps,
and it cost the ~49 newly added stats that *did* resolve, plus 534 stat refs and
48 item names that the set would have carried. **Refusing made the served data
strictly worse than accepting.**

### Fixed by asking the question a refusal can act on

The gap is split into the two populations that have different answers:

- **regressed** — refs the live localized set covers and this run does not.
  That is a broken derivation, it is the only kind of gap that keeping the old
  set actually repairs, and it is what the bar now guards.
- **new gaps** — refs the previous set had no matcher for either. Reported in
  full, never fatal. Unbounded on purpose: refusing does not close one of them.

The fraction did **not** move — it is the same 1 % — and against the previously
covered refs it is the *tighter* of the two readings, because that denominator
does not grow when English does: a derivation that breaks trips the bar at the
same absolute amount of damage however far upstream has run ahead. It stopped
being a default parameter of `validate()` reachable from nowhere and became
`POE_LANG_MAX_COVERAGE_LOSS_RATIO` (default `0.01`, `0` honoured and meaning
"not one covered stat may lose its matcher"). A first build has no baseline and
falls back to the old rule against the English set, which is the only yardstick
that exists then.

The baseline is not a guess: the refresher hands the generator the path of the
set the run would replace (`previous`), because the generator's own output dir
is a fresh snapshot holding nothing but the hand written `client_strings.js` and
would make every regeneration look like a first build.

### What is now said out loud, since "allowed" must not mean "unsaid"

- the outcome line of the source, which is what the admin area shows:
  `data/de (the English snapshot moved on; 8773 of 9278 stats carry a matcher,
  505 do not) generated from patch … into v-…`
- the container log lists every ref under two headings that are the same
  distinction again — `COVERAGE LOST against <dir>` and `COVERAGE GAP (new, the
  previous set did not carry these either)`
- in the browser, the skew view's `matchers` row (`lang-skew.mjs`), which warns
  above `POE_LANG_SKEW_WARN_RATIO` (0.5 %) and is measured against the snapshot
  actually being served. That is the right place for it and it needed no change:
  it is a continuous view of the distance, and it is what makes a gap that never
  closes visible now that the generator will keep succeeding. Before the fix it
  warned too, but on the wrong row — with the set carried over, the 534 stats
  showed up as `stats` missing entirely rather than as `matchers` missing.

### WHY the new English lines had no German text — decided, and it was neither candidate

The two candidates written down at first were "upstream is ahead of the patch"
(nothing to fix, the gap closes itself) and "a league mechanic ships a
description file `STAT_DESCRIPTION_FILES` never asks for". The observation that
decides between them was named as the run's own list of unresolved matcher
strings, which it prints in full. **The list was read on 2026-08-18, and it
refutes both.**

The 487 unresolved matchers are, almost without exception, **skill and gem
names**. Alphabetically from the start: `Absolution`, `Abyssal Cry`,
`Added Chaos`, `Added Cold`, `Added Fire`, `Added Lightning`, `Ailment Damage`,
`Ailment Effect`, `Alchemist's Mark`, `Anger`, `Arc`, `Arctic Armour`,
`Artillery Ballista`, `Aspect of the Spider`, `Assassin's Mark`,
`Ball Lightning of Static`, `Bane`, `Bear Trap` … and from the end:
`Volcanic Fissure of Snaking`, `Vortex`, `Wave of Conviction of Trarthus`,
`Whirling Blades`, `Wild Strike`, `Wither on Hit`, `Withering Step`, `Wrath`,
`Zealotry` — with the occasional real stat text scattered between them.

That rules out candidate (1): `Arc`, `Anger`, `Wrath` and `Vortex` have been in
the game for a decade, so no upstream can be "ahead" of the patch for them. And
it rules out candidate (2) in the shape it was written: not one league mechanic
but a whole CATEGORY, straight through the alphabet, transfigured variants
(`… of Static`, `… of Snaking`, `… of Trarthus`) included. What upstream added
on 2026-08-17 is a new KIND of matcher — a matcher that is nothing but a gem or
skill name.

### The third answer: the names were already on disk and the resolver was never shown them

`byName()` — the strategy for "the whole matcher string IS a name from a name
table" — reads exactly the tables in `WHOLE_NAME_TABLES`. That list held `Mods`,
`IncursionRooms`, `ExpeditionFactions`, `LakeRooms` and, of the whole gem
family, `IndexableSupportGems`. Alone.

Meanwhile `ActiveSkills`, `IndexableSkillGems` and
`IndexableNonActiveSupportGems` are exported on **every single run** already —
they are in `REQUIRED_TABLES` through `NAME_SOURCES` and `ITEM_NAME_SOURCES`,
because the templates and the item names need them. They were downloaded,
parsed, held in memory, and never offered to `byName()`.

Proven at the code before anything was changed, with the fixtures that were
already in the test file:

```
"Arc"               -> null
"Bear Trap"         -> null
"Ailment Damage"    -> null
"Added Fire Damage" -> { how: "name:IndexableSupportGems", forms: [...] }
```

The last line is what makes this an omission rather than a decision: one table
of the family was in the list and three were not, so `Added Fire Damage`
resolved all along while `Ailment Damage` two tables over produced nothing.

**Fixed** by adding the three missing tables to `WHOLE_NAME_TABLES`. The cost is
zero: no new file, no new request, no new dependency, `REQUIRED_TABLES`
unchanged — pinned by a test that walks the list and demands every entry be
reachable through `NAME_SOURCES` or `ITEM_NAME_SOURCES`.

**It cannot disturb what already worked**, and that was measured rather than
assumed: of the 10 414 matcher strings in the English set as it stood before the
update, **zero** are equal to any of the 823 gem names — no matcher that
resolves today can be reached by these tables at all. `byName()` is also only
consulted after `byLine()` and `byTemplate()` have failed, so a description line
still wins over a name that reads like one; both halves have a test.

`BaseItemTypes` was deliberately left out although it carries gem base names
too. Over `ActiveSkills` it would add only the support gem FULL names
("… Support"), which is not what the observed matchers are, and it brings ~14 000
ordinary item bases into a lookup that is tried for every matcher text that is
not a description line. Real risk, no measured gain, and falsely matched is
worse than unmatched.

**What is NOT claimed:** how far this lifts the coverage. That cannot be
measured in this repository — it needs the game data export and the newer
English set, neither of which is here. The next run says it in one line, and it
now says it in the shape that answers the question: the outcome line carries
`N of M stats carry a matcher`, and the unresolved list is split into "on stats
the previous set already had" and "on stats that are new since the previous
set".

### The two fixes are independent, and both stay

The adoption rule above is not undone by this. A set that has new gaps but loses
no old coverage is better than a five-day-old set whichever way the gaps came
about, and there will be a next time upstream is ahead of the patch. The one
change makes sure something arrives at all; the other closes this particular
gap.

**Where to look**
- `backend/v2/lang-derive.mjs` — `validate()`, the coverage section;
  `DEFAULT_MAX_COVERAGE_LOSS_RATIO`; `WHOLE_NAME_TABLES` and `byName()`
- `backend/v2/lang-data-gen.mjs` — the baseline (`--previous`), the two coverage
  headings, the unresolved list split by known/new, `STAT_DESCRIPTION_FILES`
- `backend/v2/data-refresher.mjs` — `tickLangData()`, which set is handed over
  as the baseline and the coverage in the outcome line
- `backend/v2/lang-skew.mjs` — the continuous view of the same distance
- Tests: `lang-derive.test.mjs` (the pair that matters — the same size of gap
  refused when it is a loss and kept when it is not, plus the baseline that
  ignores refs upstream removed, and `shorter` against `shorterToZero`; then the
  gem-name half — the five observed shapes resolving, two tables agreeing
  staying ONE form, the export not growing, `BaseItemTypes` staying out, and a
  description line still winning),
  `data-refresher.test.mjs` (the baseline path handed to the generator on a
  first build and on a regeneration, and the coverage in the outcome line),
  `numeric-settings.test.mjs` (the bar's default, and that `0` is a setting),
  `lang-dataset.test.mjs` (the shipped set: an absolute floor on what IS
  covered, and the partial-resolution residue)

---

## B24 — The message that announced an outage never said whether it was ours to fix (fixed)

**Observed** while writing up B22 and B23. Both of them ran for days, both were
visible from the outside, and in both cases what the outside said was this:

```
Data auto-update: no successful check of lang-data for 5 days — the tool keeps
running with the data it has.
```

A duration and a consequence. Not one word about the cause — while the cause had
been standing in the container log, one line lower, every night:

```
[data-refresh] lang-data check failed (kept last good state): https://ggpk.exposed/version?poe=1
answered "https://patch.poecdn.com/3.29.3.1.2/" — no patch version in that path; last success …
```

**Why that is a defect and not a cosmetic gap.** An admin has his container log
and may read it. But the sentence that ANNOUNCES the outage has to say whether
there is anything to do, or he has to go and find out whether "five days without
a success" means "the endpoint is briefly away" (wait) or "this build refuses the
answer" (act). Those two have the same shape and opposite remedies.

### What was wrong, in five places

`runTick` (`data-refresher.mjs`) logged `res.reason` and persisted
`lastCheckAt` / `lastOutcome` / `lastSuccessAt` — **no reason**. `dataStatusMsg`
(`server.mjs`) could therefore only forward `source`, `lastSuccessAt` and
`lastOutcome`, and the status line could only age them.

Walking back from there found four more holes of the same kind:

1. **The export's exit code was ignored.** `exportGameData` ran
   `pathofexile-dat` with `stdio: 'inherit'` and looked only at `r.error` — "the
   process could not be STARTED". Whatever it printed and whatever it exited
   with was discarded, so the next thing to fail was the completeness check in
   `loadGameData`, whose message names one possible cause as the finding: *"A
   misspelled language name filters the list empty…"*. That message is right
   about one failure and wrong about every other one — and one of the others is
   **dated and certain**: `exportTables()` compares the schema it downloads
   against the `SCHEMA_VERSION` compiled into `pathofexile-dat-schema` and calls
   `process.exit(1)` when they differ. At the next format change the generation
   dies and the operator is sent to check his spelling of "German".
2. **A run left no provenance anywhere but the log.** `build-info.json` recorded
   the patch and the English fingerprint — enough for the tool's own
   comparison, nothing for a human. "Is this still being generated at all" was
   not answerable from the browser.
3. **An unknown item namespace was silent by construction.** `deriveItems` looks
   the namespace up in `ITEM_NAME_SOURCES`; a namespace that is not in it leaves
   every line of it English. Nothing downstream can see that: the lines exist,
   the refs match, the skew view finds no missing refs, and the coverage checks
   are about stats. The only trace was one entry per line in a `kept English`
   list that has hundreds of them in a normal run.
4. **The escape hatch needed SSH.** `POE_PATCH_VERSION` is the documented
   one-line repair for a failed patch lookup and was not in the settings
   allow-list — so using the hatch that exists to save an SSH session required
   one.

### What was built

- **The reason and its class reach the message.** `check-failure.mjs` defines
  four classes — `unreachable`, `rejected`, `incompatible`, `unknown` — and each
  is set **at the site that fails**, never derived from the wording afterwards.
  The refresher persists reason and class with the check; `data-status` carries
  them; the status line prints the reason plus the sentence that belongs to the
  class. `unknown` prints **no** sentence: a guessed remedy is what this entry is
  about. The reason is foreign text, so it goes through the filter the update
  block already uses for host output (`redactOutput`), is folded to one line and
  cut to `POE_DATA_STATUS_REASON_MAX`.
- **The export is read.** `stdout` stays inherited (the progress is still in the
  log line by line), `stderr` is piped and classified against the three messages
  `pathofexile-dat` actually prints. The schema mismatch is its own named state
  pointing at the update button; a CDN failure is `unreachable`; anything else
  quotes what the child printed and claims nothing. `loadGameData` now tells
  "no tables at all" from "English but not the target language", and only the
  second one blames the translation name — where it is a finding, not a guess.
- **Provenance in the admin area.** `build-info.json` carries the run's own
  numbers (`buildRunSummary`), and the admin area shows when, from which patch,
  how much carries a matcher, what was lost against the previous set, what is
  newly missing, and the item side. Absent numbers are shown as absent.
- **An unknown namespace is loud.** `deriveItems` counts the namespaces it has no
  source for and reports them; the generator warns with a heading of its own, the
  summary carries it, and the admin area gives it a line in warning colour. It is
  a warning and not an error on purpose: an English name is not a wrong price,
  and refusing the run would also throw away every name that WAS translated.
- **`POE_PATCH_VERSION` is settable from the browser.** `live` — proven at the
  read site, `resolvePatchVersion()` reads the environment when it is called,
  once per lang-data tick — and validated with the generator's own expression,
  which moved to `patch-version.mjs` so the form cannot accept what the next
  start refuses.
- **Display-text drift is reported.** English `client_strings.js` is refreshed
  daily, the localized one ships with the image; the key sets are compared at
  every adoption and the difference is named. What is claimed is only what is
  known — which keys differ, not which of them the parser reads.

### What was deliberately NOT built

- **No guessing.** Unresolved matchers are not assembled by similarity, and a
  failure nobody classified stays `unknown` instead of getting the likeliest
  cause attached. Wrongly priced is worse than unpriced, and wrongly diagnosed is
  worse than undiagnosed for the same reason.
- **No automatic league switching, no softening of the regression gate, no
  persisted gap log.** All three were decided against before and stay that way.

**Where to look**
- `backend/v2/check-failure.mjs` — the classes and the reason filter
- `backend/v2/data-refresher.mjs` — `runTick` (what is persisted), `status()`,
  `clientStringDrift()`, the `build-info.json` write
- `backend/v2/server.mjs` — `dataStatusMsg()`, `langBuildInfo()`, `/admin/gaps`
- `backend/v2/lang-data-gen.mjs` — `classifyExportFailure()`, `exportGameData()`,
  `loadGameData()`, `buildRunSummary()`
- `backend/v2/lang-derive.mjs` — `deriveItems()` and `report.unknownNamespaces`
- `backend/v2/patch-version.mjs`, `backend/v2/config-overrides.mjs` — the escape
  hatch and the shared pattern
- `backend/v2/frontend/shell.js`, `settings.js`, `i18n.js` — the status line and
  the admin block
- Tests: `check-failure.test.mjs`, `frontend/data-status-line.test.mjs` (what the
  line says per class, and that `unknown` says nothing), `data-refresher.test.mjs`
  (reason and class persisted, cleared by a success, capped; the drift
  comparison), `lang-data-gen.test.mjs` (the export classes, the two
  incomplete-export shapes, the run summary), `lang-derive.test.mjs` (the unknown
  namespace), `config-override.test.mjs` (the patch version: same validation as
  the start, and live at the read site), `admin-endpoint.test.mjs` (provenance in
  the answer)

---

## B25 — The repairs B24 shipped were unverifiable, and two of them said the wrong thing (fixed)

B24 gave every failed check a **reason** and a **class**, and made
`POE_PATCH_VERSION` settable from the admin form so the one-line repair no longer
needed a shell on the box. An adversarial pass over that work on 2026-08-18 found
four things wrong with it. Three are about a message that is false; the fourth is
about a repair nobody can confirm.

### 1. The filter deleted the sentence it was built to deliver

`cleanReason()` put the reason through `redactOutput()`, and that filter drops
every **line** matching `/SESSID|PASSWORD|TOKEN|SECRET|ACCOUNT|KEY/i`. The reason
**is** one line. So these — all of them producible by this code today — came out
as `[line removed: it names something that could be a credential]` and nothing
else:

- `client_strings.js: shape looks wrong (RARITY_UNIQUE / key count)` → "**key** count"
- `not importable (SyntaxError: Unexpected token …)` → "Unexpected **token**"
- the quoted body of a captive portal, which is the showcase case for `rejected`
  and routinely contains "token" or "key"

The first real `rejected` an operator ever saw would have shown a credential
placeholder in place of its cause — and asserted a credential had been near it.

The filter was not too strict, it was at the wrong **granularity**. Dropping a
line is cheap in a multi-line build log, which is what `redactOutput` filters and
where it is unchanged. A one-line status reason has nothing to spare, so it gets a
filter at value granularity (`secret-keys.mjs`, `maskSecretValues`): the **value**
a credential-shaped name is handed is masked and the words around it stay.

- an explicit separator masks unconditionally — `token=***`, `"api_key": "***"`,
  `Authorization: Bearer ***`, `sessid => ***` — because behind a `=` or a `:` a
  password may well be an ordinary word;
- a bare space masks only a value that is **not** ordinary English: at least
  eight characters from the alphabet credentials are written in, and not a plain
  lower-case word. `POESESSID ***`, but `key count` and `Unexpected token in`
  untouched.

The security claim is unchanged, including its limit: names and shapes are
caught, a bare secret that names nothing is not — which is what `redactOutput`
has always documented about itself.

**The test was half a test.** It checked `token=abcdef` — a real secret — and
nothing from the harmless vocabulary, so the entire class that was being
destroyed was the class nobody had written an assertion for. Both are in it now.

### 2. The pin was a new way to go quiet — twice

Making `POE_PATCH_VERSION` settable from a form makes it easier to set and no
easier to remember. It has two failure modes and both used to look **green**:

**Valid, but not a real patch.** `3.29.9.9` passes `PATCH_RE`. The export asks the
CDN, the CDN refuses, `classifyExportFailure` saw `Failed to fetch … from CDN`,
returned `unreachable`, and the page said *"nothing to do here, the next check
tries again"* — for ever, about a value the operator had typed in themselves.

The classification could do better than that without guessing, and the library
settles it: `pathofexile-dat` prints that line on exactly one branch,
`!response.ok` (`dist/cli/bundle-loaders.js`), so an answer **did** arrive. What
the line does not carry is the status code, so 404 and 503 are indistinguishable —
and that is exactly where the pin decides. Unpinned, the version came from the
lookup and is a patch that exists, so waiting is right (`unreachable`). Pinned,
every retry asks for the same version, so waiting is not a remedy at all
(`rejected`), and the reason names the pin.

**Valid and right, until the next patch.** Then nothing fails. The checks succeed,
report `unchanged`, and a source that is checked daily never goes stale — so the
localized set freezes on last league's data with no warning anywhere.

Fixed by asking the lookup **even when the pin wins** and reporting a
disagreement. That needed a third thing a check can say, because none of
`updated`/`unchanged`/`failed` has a place for "this worked and is drifting": a
**warning**, filtered and capped like a reason, shown whatever the outcome and
whatever the age. The pin still wins — "the pin is stale" and "the lookup is wrong
again" produce the identical difference, and nothing in the tool can tell them
apart. The message says what was seen, not what it means.

### 3. The reasons argued their own remedy

`classifyExportFailure` baked advice into the reason text — *"update the
container"*, *"nothing to fix here, the next check tries again"*, *"Nothing about
the language configuration is involved"* — while the page printed the **class's**
advice next to it. Two authorities for one question, and the reason was the one
that could not be right when the class changed: the CDN reason promised "nothing
to fix" for a failure the operator's own pin can cause.

The reasons state findings now. The advice belongs to the class, `unknown` says
nothing, and the detail that is too specific for a class (a repeated missing
**column** after a container update means `TABLE_COLUMNS` has to move) is in
`docs/admin.md`, where documentation belongs.

### 4. Nothing happened for 24 hours after a repair

Every remedy this tool offers — clear the pin, set the pin, update the container —
takes effect at the next scheduled check, and there is one a day. So a correct
repair and a repair that did nothing looked identical, for up to a day, to exactly
the person the whole B24 pass was written for.

**Settings → admin area → server settings → "Check now"** runs every check
immediately and redraws the status line with the result. Behind the admin password
like the restart button, because it starts outbound traffic on demand. Guarded
twice, for different reasons: **409** while a check is running (the overlap guard
the schedule has always had — a second run would put the generator and
`pruneAptVersions` in the same snapshot dir), and **429** for
`POE_DATA_CHECK_NOW_COOLDOWN_MS` (default 5 min, floor 1 min) after one finished,
because a press costs a patch lookup, four conditional fetches and possibly a
multi-megabyte CDN download — and the person most likely to press it repeatedly is
the person in the middle of a repair. The cooldown clock starts when a run
**finishes**: a four-minute run must not leave a one-minute cooldown behind it.

### The smaller ones, fixed in the same pass

- **`incompatible` waited three days to be seen**, because the reason hung off the
  staleness note. That diagnosis is certain the moment it is made — the data was
  reached and read and the schema does not match this build — so it is shown at
  once. `unreachable`, `rejected` and `unknown` still wait, because there the age
  IS the information.
- **The marks aged silently.** `classifyExportFailure` matches three sentences
  `pathofexile-dat` prints, and every test fed the wording in by hand — so the day
  the library rewords one, the classification would quietly fall back to `unknown`
  with the suite still green. `lang-data-gen-marks.test.mjs` pins them against
  `node_modules/pathofexile-dat`, including the `!response.ok` guard the
  `unreachable`/`rejected` split now rests on. The marks are also matched at the
  **start of a line**: `includes` over the whole stderr could be tripped by a
  bundle NAME containing one of the sentences, which is a finding manufactured out
  of a file name.
- **The drift warning outlived its own remedy.** It was computed only where a new
  English snapshot is adopted, so following its advice (update the container)
  changed nothing on screen until upstream happened to move the English file
  again. It is recomputed at boot, and entries for languages nobody is served in
  are dropped.
- **Persisted reasons were not re-filtered.** "Filtered and capped before it
  reaches a browser" held on the write path only, and `state.json` outlives the
  build that wrote it. Filtering now happens on the way out as well
  (`cleanReason` is idempotent, and there is a test for that), and a `failKind`
  this build does not know is dropped rather than sent.
- **`isFailKind` claimed to keep a stray value off the wire and was called from
  nowhere.** It is called at the wire now (`dataStatusMsg`) and at the read of the
  persisted state.
- **`check-failure.test.mjs` was a binary file** — two literal control characters
  inside a regex — so every diff on it was invisible, on the one file guarding the
  filter this pass rewrote. Escaped. `lang-data-gen.mjs` and
  `networth/stash-pacer.mjs` had the same thing (a literal NUL as a separator) and
  are text again too.

### And a claim that was false

"The suite sends nothing outbound" was stated repeatedly and was not true.
Measured by preloading a recording wrapper around `fetch` and
`http/https.request` into every test process and running the whole suite:

| | requests | to |
|---|---|---|
| before | **55** | poe.ninja, from 11 files |
| after the switch list was applied everywhere | **15** | poe.ninja, from 8 browser-driven files |
| after `POE_LEAGUE_LIST_DISABLED` | **0** | — |

Nothing went to GGG at any point; that half of the claim was checked and held.

**Why the existing instrument could not catch it.** `server-no-network.test.mjs`
replaces `globalThis.fetch` before importing the server, records every call and
rejects anything non-loopback — all of it inside **its own process**, and
`run-tests.mjs` starts one process per file. It was measuring the single file
that was already quiet and reporting on all of them. A guard that lives inside
one of the things it guards cannot see the others.

**Why the switches were not enough on their own.** Every file that booted the
server wrote the switch list out by hand, and each one had a different subset.
That list is `backend/v2/test-quiet-env.mjs` now, imported rather than
remembered, and a static check fails a file that boots the server without it.
Four files turned out to need one of the switches back ON — they price against a
stubbed fetch, or the Faustus store IS what they measure — and they now say so in
a line with a reason attached instead of being quiet by omission.

**And a third kind of traffic nobody had a switch for.** With the list applied
everywhere, 15 requests were left, all `GET /leagues`, all from browser-driven
tests. It is neither a schedule nor a warm-up nor the price check: it is a
**request**, made by the page on every load, so no amount of disabling background
jobs ever touched it. `POE_LEAGUE_LIST_DISABLED` covers it, and it earns its keep
outside the suite too — an installation with no route to poe.ninja was paying for
a failing fetch before its dropdown could be drawn. Disabled, the dropdown is
filled from what the installation knows without asking: the leagues its users are
on, plus the fallbacks.

**The instrument now lives in the runner.** `run-tests.mjs` preloads
`test-net-guard.mjs` into every process it starts, and — via `NODE_OPTIONS` —
into every process those start, so a test that spawns the real server is watched
inside the server too. It blocks rather than watching, because a recorded and
forwarded request is still a request. A file that reaches out is marked `NET` and
turns the run red.

That report had the same defect as the thing it reports on, for one commit: the
guard writes to stderr, node's TAP reporter folds that into a `# ` comment, and
the runner's expression did not allow for the prefix — so it matched nothing and
looked like silence. Found with a negative control, which is now a test: it makes
a real blocked request in a real child process and runs the output past the
runner's own expression, read out of the runner.

**Where to look**
- `backend/v2/secret-keys.mjs` — the vocabulary and `maskSecretValues`
- `backend/v2/check-failure.mjs` — `cleanReason`, and why it is not `redactOutput`
- `backend/v2/lang-data-gen.mjs` — `resolvePatchVersion` (the second opinion),
  `classifyExportFailure` (findings only, and the pin)
- `backend/v2/data-refresher.mjs` — the `warning` channel, `refilterPersistedText`,
  `refreshClientStringDrift`, `checkNow`
- `backend/v2/server.mjs` — `/admin/data-check`, `dataStatusMsg`
- `backend/v2/frontend/shell.js` — `relevantSources`, the three ways onto the line
- Tests: `check-failure.test.mjs` (both vocabulary classes, idempotence),
  `lang-data-gen-marks.test.mjs` (the marks against node_modules),
  `lang-data-gen.test.mjs` (the pin, the CDN split, line-anchored marks),
  `data-refresher.test.mjs` (the warning, the re-filter, the drift, `checkNow`'s
  guards), `frontend/data-status-line.test.mjs` (shown at once vs. shown when
  stale), `update-endpoint.test.mjs` (the gate on `/admin/data-check`),
  `suite-network-silence.test.mjs` (the claim above, measured)
