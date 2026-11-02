#!/usr/bin/env node
// Builds a LOCALIZED APT data set (items.ndjson + stats.ndjson) out of two
// inputs: the English snapshot this container is actually using, and the game
// data of the current patch straight from GGG's update servers.
//
// Why locally and not from an upstream: there is no upstream for German. APT
// ships en/ru/ko, nothing else, so every installation makes its own. Nobody
// has to maintain a release for a third party's container to stay current, no
// game data gets redistributed, and the validation runs against exactly the
// English set this container has — not against a presumed one.
//
// The target language is a PARAMETER. `de` is what the project needs, `ru` is
// what proves the generator: upstream ships a Russian set built by APT itself,
// so generating `ru` and diffing it character by character says whether the
// derivation is right without anyone having to read the language.
//
// Usage:
//   node backend/v2/lang-data-gen.mjs --lang de
//   node backend/v2/lang-data-gen.mjs --lang de --dry-run
//   node backend/v2/lang-data-gen.mjs --lang ru --skeleton <dir> --out <dir>
//   node backend/v2/lang-data-gen.mjs --lang de --game-data <dir>   # skip the export
//
// Options:
//   --lang <code>      target language (de, ru, ko, ...). Required.
//   --patch <version>  patch to pull, e.g. 3.29.2.1. Optional — looked up
//                      (resolvePatchVersion below) unless --game-data is given.
//                      POE_PATCH_VERSION overrides the lookup.
//   --skeleton <dir>   English data set used as the skeleton,
//                      default renderer/public/data/en
//   --out <dir>        where to write, default renderer/public/data/<lang>
//   --game-data <dir>  reuse an earlier export instead of downloading
//   --work <dir>       scratch dir for the export, default <out>/../.lang-work
//   --previous <dir>   the set this run replaces, default <out>. It is the
//                      baseline the coverage gate measures against — see
//                      validate() in lang-derive.mjs
//   --max-loss-ratio <n>  how much of the baseline's coverage may fall away
//                      before the run is refused, default 0.01
//                      (POE_LANG_MAX_COVERAGE_LOSS_RATIO on the server path)
//   --dry-run          report only, write nothing
//   --no-index         skip regenerating the *.index.bin
//
// What it writes into <out>:
//   items.ndjson       the English lines with `name` replaced
//   stats.ndjson       the English lines with matcher strings replaced
//   text-pairs.ndjson  target->English line pairs for the repair path, read by
//                      mod-text-pairs.mjs when a localized mod line has to be
//                      brought to GGG's English stat catalogue
//   build-info.json    what this set was built FROM (see BUILD_INFO_FILE)
//   *.index.bin        via apt-index.mjs
// client_strings.js is NEVER touched — it is hand written and checked in.
//
// Three traps that strike silently, all three checked here rather than trusted:
//   - a misspelled language name ("Deutsch" instead of "German") filters the
//     language list empty and the export exits 0 with no output. So the output
//     is checked for existence and plausibility, and NOT ONLY the exit code —
//     which is read as well since 2026-08-18 (docs/bugs.md B24), because
//     ignoring it made every other way the exporter can die arrive as advice
//     about the language name. See classifyExportFailure().
//   - a missing language file makes the tool fall back to English without a
//     word. Detectable only by target and English output being byte identical
//     — which is exactly what gets compared.
//   - `Words.Text` stays English in every language; the translated unique name
//     is in `Text2` (handled in lang-derive.mjs).

import { readFile, writeFile, mkdir, rm, readdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { parseStatDescriptions } from './lang-statdesc.mjs'
import {
  createResolver, deriveStats, deriveItems, buildTextPairs, validate, REQUIRED_TABLES,
  DEFAULT_MAX_COVERAGE_LOSS_RATIO
} from './lang-derive.mjs'
import { TEXT_PAIRS_FILE } from './mod-text-pairs.mjs'
import { buildIndexBins } from './apt-index.mjs'
import { PATCH_RE, PATCH_EXAMPLE } from './patch-version.mjs'
import { FAIL_KIND, failure } from './check-failure.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDERER_DATA = path.join(HERE, '../../renderer/public/data')
const PSEUDO_TABLE = path.join(HERE, 'lang-pseudo-matchers.json')

/**
 * Language code -> the name pathofexile-dat accepts. That list is hardcoded in
 * its CLI (dist/cli/export-tables.js); a name outside it silently produces
 * nothing, so an unknown code fails here instead.
 */
export const LANGUAGE_NAMES = {
  de: 'German',
  ru: 'Russian',
  ko: 'Korean',
  fr: 'French',
  ja: 'Japanese',
  pt: 'Portuguese',
  es: 'Spanish',
  th: 'Thai',
  'cmn-Hant': 'Traditional Chinese'
}

/** Description files to pull. The name-slot templates live spread over all of
 *  them, not just stat_descriptions.txt. */
export const STAT_DESCRIPTION_FILES = [
  'active_skill_gem_stat_descriptions.txt',
  'advanced_mod_stat_descriptions.txt',
  'atlas_relic_stat_descriptions.txt',
  'atlas_stat_descriptions.txt',
  'aura_skill_stat_descriptions.txt',
  'banner_aura_skill_stat_descriptions.txt',
  'beam_skill_stat_descriptions.txt',
  'brand_skill_stat_descriptions.txt',
  'buff_skill_stat_descriptions.txt',
  'chest_stat_descriptions.txt',
  'curse_skill_stat_descriptions.txt',
  'debuff_skill_stat_descriptions.txt',
  'deepwater_applied_adjacent_stat_descriptions.txt',
  'deepwater_explicit_stat_descriptions.txt',
  'deepwater_implicit_stat_descriptions.txt',
  'deepwater_stat_descriptions.txt',
  'expedition_relic_stat_descriptions.txt',
  'gem_stat_descriptions.txt',
  'graft_stat_descriptions.txt',
  'heist_equipment_stat_descriptions.txt',
  'leaguestone_stat_descriptions.txt',
  'map_stat_descriptions.txt',
  'mercenary_support_stat_descriptions.txt',
  'minion_attack_skill_stat_descriptions.txt',
  'minion_skill_stat_descriptions.txt',
  'minion_spell_damage_skill_stat_descriptions.txt',
  'minion_spell_skill_stat_descriptions.txt',
  'mirage_stat_descriptions.txt',
  'monster_stat_descriptions.txt',
  'necropolis_stat_descriptions.txt',
  'offering_skill_stat_descriptions.txt',
  'passive_skill_aura_stat_descriptions.txt',
  'passive_skill_stat_descriptions.txt',
  'primordial_altar_stat_descriptions.txt',
  'sanctum_relic_stat_descriptions.txt',
  'secondary_debuff_skill_stat_descriptions.txt',
  'sentinel_stat_descriptions.txt',
  'single_minion_spell_skill_stat_descriptions.txt',
  'skill_stat_descriptions.txt',
  'skillpopup_stat_filters.txt',
  'stat_descriptions.txt',
  'tincture_stat_descriptions.txt',
  'vaal_side_area_stat_descriptions.txt',
  'variable_duration_skill_stat_descriptions.txt',
  'village_stat_descriptions.txt'
]

/** Columns to export per table — everything the derivation joins on. */
export const TABLE_COLUMNS = {
  ActiveSkills: ['Id', 'DisplayedName'],
  AfflictionRewardTypeVisuals: ['Id', 'Name'],
  BaseItemTypes: ['Id', 'Name'],
  ClientStrings: ['Id', 'Text'],
  ExpeditionFactions: ['Id', 'Name'],
  IncursionRooms: ['Id', 'Name'],
  IndexableNonActiveSupportGems: ['Index', 'Name'],
  IndexableSkillGems: ['Index', 'Name1', 'Name2'],
  IndexableSupportGems: ['Index', 'Name'],
  ItemClasses: ['Id', 'Name'],
  LakeRooms: ['Id', 'Name'],
  Mods: ['Id', 'Name'],
  MonsterVarieties: ['Id', 'Name'],
  PassiveSkills: ['Id', 'Name'],
  Words: ['Text', 'Text2'],
  WorldAreas: ['Id', 'Name']
}

const ndjson = text => text.split('\n').filter(Boolean).map(l => JSON.parse(l))
const toNdjson = lines => lines.map(l => JSON.stringify(l)).join('\n') + '\n'

// --------------------------------------------------------- patch version

/**
 * Where the CURRENT patch version comes from.
 *
 * There is no endpoint of GGG's that this project may ask: patch.poecdn.com
 * answers 404/403 to every guess at a listing (it only serves
 * /<patch>/Bundles2/… once you already know the version), and pathofexile.com
 * is off limits here — this tool has paid for a ban once and does not go near
 * the site or the trade API for anything but a price check.
 *
 * ggpk.exposed publishes the CDN base of the current patch as ONE line of
 * text. That is not a random third party: it is the endpoint the repoe-fork
 * export pipeline resolves its own version with
 * (repoe-fork/dat-export, .github/workflows/update_schema.yml), and that
 * pipeline's output — base_items.json — is already a daily dependency of this
 * tool (base-names-gen.mjs). So the German data set leans on the same
 * ecosystem the net-worth bridge already leans on, not on a new one.
 *
 * The answer is NOT trusted blind: the host has to be patch.poecdn.com and the
 * version has to be digits and dots — however many parts it carries, see
 * PATCH_RE — because the string ends up inside a CDN URL. And the whole lookup
 * is overridable — POE_PATCH_VERSION wins outright,
 * which is the escape hatch when the endpoint is gone or answers wrong.
 */
export const PATCH_VERSION_URL = 'https://ggpk.exposed/version?poe=1'
export const PATCH_CDN_HOST = 'patch.poecdn.com'
/**
 * What counts as a patch version lives in patch-version.mjs — the settings page
 * validates `POE_PATCH_VERSION` with the same expression, and two copies of it
 * would be a form that accepts what the next start refuses.
 */
export { PATCH_RE }
const PATCH_UA = 'poe-price-tool/0.1 (language data generator, personal LAN tool)'

/** The value of `source` when the version comes from the pin, not the lookup. */
export const PATCH_SOURCE_PIN = 'POE_PATCH_VERSION'

/**
 * The lookup on its own: `{ patch }` or `{ error, kind }`, never a throw.
 *
 * Split out because it now has two callers with opposite needs. Unpinned, a
 * failed lookup is a failed check and has to travel as a classified error.
 * Pinned, the same failure is not a problem at all — the pin exists for exactly
 * that case — and must not turn a working tick into a failing one.
 */
async function lookUpPatch (fetchImpl, url) {
  let body
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': PATCH_UA } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    body = (await res.text()).trim()
  } catch (e) {
    return {
      error: `the current patch version could not be looked up at ${url} (${e?.message || e})`,
      kind: FAIL_KIND.UNREACHABLE
    }
  }
  // From here the service ANSWERED and the answer is the problem — a captive
  // portal, an error page, or a CDN base whose last segment is not a version.
  // Waiting does not help with any of the three, so they are `rejected` and the
  // status line says so; the remedy is POE_PATCH_VERSION (settable from the
  // admin area) or a fix to PATCH_RE, see docs/admin.md.
  let parsed
  try { parsed = new URL(body) } catch { parsed = null }
  if (!parsed || parsed.host !== PATCH_CDN_HOST) {
    return {
      error: `${url} answered ${JSON.stringify(body.slice(0, 120))} — expected a https://${PATCH_CDN_HOST}/<patch>/ URL`,
      kind: FAIL_KIND.REJECTED
    }
  }
  const patch = parsed.pathname.split('/').filter(Boolean).pop() || ''
  if (!PATCH_RE.test(patch)) {
    return {
      error: `${url} answered ${JSON.stringify(body.slice(0, 120))} — no patch version in that path`,
      kind: FAIL_KIND.REJECTED
    }
  }
  return { patch }
}

/**
 * resolvePatchVersion() -> { patch, source, pinned, lookedUp, mismatch }
 *
 * `source` names where the value came from, so the log line says it out loud
 * instead of leaving the operator guessing which of the two paths was taken.
 * Throws when neither works — a run on a guessed version would build a data
 * set nobody can trace back.
 *
 * THE LOOKUP IS ASKED EVEN WHEN THE PIN WINS. `POE_PATCH_VERSION` became
 * settable from the admin form, and the form makes the pin's two silent
 * failures MORE likely than the compose file did, not less:
 *
 *   valid but not a real patch          `3.29.9.9` passes PATCH_RE. Every file
 *                                       the CDN is asked for comes back refused,
 *                                       for ever, and the cause is our own value.
 *   valid and right, until the next patch   everything stays green ("built from
 *                                       patch X"), the set freezes, nobody is told.
 *
 * Neither is visible without a second opinion, and the lookup is the only one
 * there is. So it is asked, its answer is compared, and a difference travels
 * back as `mismatch` — a WARNING, never a correction: the pin still wins,
 * because "the pin is stale" and "the lookup is wrong again" produce the same
 * difference and nothing here can tell them apart. The message says what was
 * seen, not what it means.
 *
 * A lookup that fails while pinned costs nothing and says nothing: it is the
 * situation the pin was set for. `lookedUp` is null then, and the caller's line
 * names the pin.
 */
export async function resolvePatchVersion ({
  fetchImpl = fetch,
  env = process.env,
  url = PATCH_VERSION_URL
} = {}) {
  const configured = String(env.POE_PATCH_VERSION || '').trim()
  if (configured) {
    if (!PATCH_RE.test(configured)) {
      // Set by a human, refused by us: `rejected`, because no later tick makes
      // it right on its own.
      throw failure(
        `POE_PATCH_VERSION=${JSON.stringify(configured)} is not a patch version (expected e.g. ${PATCH_EXAMPLE})`,
        FAIL_KIND.REJECTED)
    }
    const second = await lookUpPatch(fetchImpl, url)
    const lookedUp = second.patch ?? null
    return {
      patch: configured,
      source: PATCH_SOURCE_PIN,
      pinned: configured,
      lookedUp,
      mismatch: lookedUp && lookedUp !== configured
        ? `POE_PATCH_VERSION pins the patch to ${configured}; ${url} reports ${lookedUp}. ` +
          `The localized set is built from ${configured} until the pin is changed or cleared.`
        : null
    }
  }
  const r = await lookUpPatch(fetchImpl, url)
  if (r.error) {
    throw failure(
      // The finding, and nothing but the finding. What to do about it belongs
      // to the CLASS (check-failure.mjs) and to the settings row that offers the
      // escape hatch — a reason that argues its own remedy is how a status line
      // ends up shipping advice the class then contradicts.
      r.error,
      r.kind)
  }
  return { patch: r.patch, source: url, pinned: null, lookedUp: r.patch, mismatch: null }
}

// --------------------------------------------------------- build provenance

/**
 * What a localized set says it was built FROM. Written next to the data, so it
 * travels with the tree when a snapshot carries it forward, and read back by
 * the data refresher: it compares this pair against the current state on every
 * tick and regenerates when they drift apart (a LEVEL, not an edge — a run that
 * failed leaves the difference standing, so the next tick tries again instead
 * of reporting "nothing to do").
 *
 *   { lang, patch, enFingerprint, builtAt }
 */
export const BUILD_INFO_FILE = 'build-info.json'

/**
 * The numbers of ONE run, in the shape build-info.json carries them.
 *
 * Why they are written next to the data at all: the skew view (lang-skew.mjs)
 * measures the distance between the live sets and says nothing about WHEN or
 * FROM WHAT the localized one was made, so "is this still being maintained" was
 * a question only the container log could answer. Every number here is already
 * produced by the run — nothing is recomputed and nothing is estimated.
 *
 *   statsEn / statsCovered / statsUncovered  the coverage of the set that was
 *       written, as validate() counted it.
 *   baselineCovered  what the set this run REPLACED covered, or null on a first
 *       build (there is no baseline then, and 0 would be a lie).
 *   regressed / newGaps  the two halves of the gap, in the same split the
 *       adoption rule uses: what this run LOST, and what it never had.
 *   items*  the item side, which the stat numbers say nothing about.
 *   unknownNamespaces  namespaces with no name source at all — the gap that used
 *       to be invisible (see deriveItems in lang-derive.mjs).
 */
export function buildRunSummary (run) {
  const c = run?.result?.counts
  const ir = run?.items?.report
  if (!c && !ir) return null
  return {
    statsEn: c?.statsEn ?? null,
    statsCovered: c?.covered ?? null,
    statsUncovered: c?.uncovered ?? null,
    baselineCovered: c?.baselineCovered ?? null,
    regressed: c?.regressedRefs?.length ?? null,
    newGaps: c?.newGapRefs?.length ?? null,
    itemsTotal: ir?.total ?? null,
    itemsTranslated: ir?.translated ?? null,
    itemsKeptEnglish: ir?.kept?.length ?? null,
    unknownNamespaces: ir?.unknownNamespaces ?? []
  }
}

/**
 * Identity of the English skeleton a localized set was derived from — a hash
 * over exactly the two files the derivation reads, NOT the name of the snapshot
 * dir they happen to sit in. The dir name would be useless here: writing the
 * localized set creates a new snapshot dir, so a set would look outdated the
 * instant it was written, and every tick afterwards would regenerate it.
 */
export function buildFingerprint (itemsNdjson, statsNdjson) {
  return createHash('sha256')
    .update(itemsNdjson).update('\0').update(statsNdjson)
    .digest('hex')
}

// --------------------------------------------------------------- game data

/**
 * The three failures of pathofexile-dat that are RECOGNISABLE — quoted from its
 * own source (node_modules/pathofexile-dat/dist/cli/*.js), each of them followed
 * by `process.exit(1)`, each printed on stderr.
 *
 * The first one is the timed bomb this pass was written for: `exportTables()`
 * compares the schema it downloads against the `SCHEMA_VERSION` compiled into
 * `pathofexile-dat-schema` and exits when they differ. That WILL happen at some
 * future format change, the run will die, and until 2026-08-18 the message that
 * reached the operator was the one from `loadGameData()` below — advice about a
 * misspelled language name. For a stranger that is the most expensive wrong
 * answer this tool can give.
 *
 * Matching text rather than an exit code is a compromise and is admitted as one:
 * the exit code is 1 for all of them. So the text decides, and anything that
 * matches NONE of the three stays unclassified — the reason then carries what
 * the process printed and the status line offers no remedy at all.
 */
export const EXPORT_MARKS = Object.freeze({
  // Its wording, verbatim, minus the trailing advice.
  schema: 'Schema has format not compatible with this package',
  cdn: /^Failed to fetch (.+) from CDN\./,
  column: /^Table "([^"]+)" doesn't have a column named "([^"]+)"\./
})

/** How much of the child's stderr is kept for the reason. */
export const EXPORT_STDERR_MAX_BYTES = 256 * 1024

/**
 * Does a LINE of the child's stderr BEGIN with this mark?
 *
 * Both halves of that matter, and `includes` over the whole excerpt had
 * neither. The export names every file it downloads, and a bundle whose name
 * contained the schema sentence would have turned a CDN refusal into a version
 * conflict — a wrong finding produced by a file name. Each of the three marks
 * is a `console.error` of its own in the library, so each one starts a line,
 * and that is exactly what is asked. `EXPORT_MARKS_PINNED` in
 * lang-data-gen-marks.test.mjs holds that claim against the installed copy.
 */
function markedLine (stderr, mark) {
  return String(stderr).split('\n').some(line => line.trimStart().startsWith(mark))
}

/** The first line that BEGINS with a capturing mark, matched. */
function markMatch (stderr, re) {
  for (const line of String(stderr).split('\n')) {
    const m = re.exec(line.trimStart())
    if (m) return m
  }
  return null
}

/**
 * What a failed export means, from what it printed. Returns { reason, kind }, or
 * null when the run succeeded.
 *
 * THE REASON IS A FINDING, THE ADVICE BELONGS TO THE CLASS. Until 2026-08-18
 * these reasons argued their own remedy — "update the container", "nothing to
 * fix here, the next check tries again" — while the status line ALSO printed
 * the advice of the class next to it. Two authorities for one question, one of
 * which was wrong the moment the class was (the CDN case below is exactly that:
 * its reason promised "nothing to fix" for a failure the operator's own pin can
 * cause). So the sentences here say what was seen, `kind` decides what to do,
 * and `unknown` says nothing at all.
 *
 * `status === 0` is NOT taken as success on its own — that trap is older than
 * this function (a language filter that matches nothing exits 0 with no output)
 * and is still caught by the file checks in loadGameData(). What is new is that a
 * NON-zero exit is no longer ignored.
 *
 * `patchSource` is what resolvePatchVersion() said about where the version came
 * from. It only matters in the CDN branch, and it matters there completely; see
 * the comment on that branch.
 */
export function classifyExportFailure ({
  status, signal, stderr = '', languageName = '', patch = '', patchSource = ''
} = {}) {
  if (!signal && (status === 0 || status == null)) return null
  const err = String(stderr || '')
  const tail = err.trim().split('\n').slice(-3).join(' ').trim()
  if (signal) {
    return {
      reason: `the game-data export was killed by ${signal}${tail ? ` (last output: ${tail})` : ''}`,
      kind: FAIL_KIND.UNKNOWN
    }
  }
  if (markedLine(err, EXPORT_MARKS.schema)) {
    return {
      reason: 'the game-data export refuses this build: pathofexile-dat says the dat schema has a format ' +
        'its version cannot read.',
      kind: FAIL_KIND.INCOMPATIBLE
    }
  }
  const col = markMatch(err, EXPORT_MARKS.column)
  if (col) {
    return {
      reason: `the game-data export found no column "${col[2]}" in table "${col[1]}" — the column list this ` +
        'build asks for no longer matches the schema.',
      kind: FAIL_KIND.INCOMPATIBLE
    }
  }
  const cdn = markMatch(err, EXPORT_MARKS.cdn)
  if (cdn) {
    // WHAT THIS MARK ACTUALLY MEANS. pathofexile-dat prints it on ONE branch:
    // the response arrived and `response.ok` was false (bundle-loaders.js). It
    // is never printed when nobody answered — a connection that fails throws
    // out of the fetch instead. So "the CDN answered and refused the file" is a
    // fact here, not a reading, and the reason may say it.
    //
    // What the mark does NOT carry is the status code, so 404 (this patch does
    // not exist) and 503 (it does, the CDN is unwell) look identical. That is
    // where the pin decides, and it decides without guessing:
    //
    //   no pin       the version came from the lookup, so it is a patch that
    //                exists. Waiting is the right move -> `unreachable`.
    //   pinned       the version in that URL is a value somebody typed into the
    //                admin form. Every retry asks for the same one, so "the next
    //                check tries again" is false for as long as the pin stands.
    //                -> `rejected`, and the reason NAMES the pin, because a
    //                failure whose cause is our own configuration must not be
    //                reported as weather.
    const pinned = patchSource === PATCH_SOURCE_PIN
    return {
      reason: `the game-data export asked the patch CDN for ${cdn[1]} and was refused` +
        (pinned
          ? `. The patch version ${patch} it asked for comes from POE_PATCH_VERSION, not from the lookup — ` +
            'every check repeats the same request until that pin is changed or cleared.'
          : '.'),
      kind: pinned ? FAIL_KIND.REJECTED : FAIL_KIND.UNREACHABLE
    }
  }
  return {
    reason: `the game-data export exited with code ${status}${tail ? `: ${tail}` : ' and printed nothing on stderr'}`,
    kind: FAIL_KIND.UNKNOWN
  }
}

/**
 * Runs pathofexile-dat with a generated config.
 *
 * WHAT IS TRUSTED AND WHAT IS NOT. The exit code alone never meant success — the
 * tool answers 0 when the language filter matched nothing — and the file checks
 * in loadGameData() are still the proof that a run produced something. But a
 * non-ZERO exit was ignored outright until 2026-08-18, so every way this child
 * can die arrived at the operator as loadGameData()'s "a misspelled language
 * name filters the list empty" (docs/bugs.md B24). It is read now, and its
 * stderr with it: `stdout` stays INHERITED so the export's progress is still in
 * the container log line by line, `stderr` is piped so the reason can be
 * classified (classifyExportFailure above) — all three recognisable failures
 * print there.
 */
export async function exportGameData ({ workDir, languageName, patch, patchSource = '', run = spawnSync }) {
  if (!patch) {
    // Last guard, not the normal path: generate() resolves the version before
    // it gets here (resolvePatchVersion). Reaching this means a caller went
    // straight to the export without one, and pathofexile-dat cannot build a
    // CDN path from nothing.
    throw new Error(
      'the patch version is missing. Pass --patch <version> (e.g. --patch 3.29.2.1), ' +
      `set POE_PATCH_VERSION, or let it be looked up at ${PATCH_VERSION_URL}.`
    )
  }
  await mkdir(workDir, { recursive: true })
  const config = {
    patch,
    translations: ['English', languageName],
    tables: REQUIRED_TABLES.map(name => ({
      name,
      columns: TABLE_COLUMNS[name] ?? ['Id', 'Name']
    })),
    files: STAT_DESCRIPTION_FILES.map(f => `Metadata/StatDescriptions/${f}`)
  }
  await writeFile(path.join(workDir, 'config.json'), JSON.stringify(config, null, 2))
  const bin = fileURLToPath(await import.meta.resolve('pathofexile-dat/dat.js'))
  const cli = path.join(path.dirname(bin), 'cli/run.js')
  const r = run(process.execPath, [cli], {
    cwd: workDir,
    stdio: ['ignore', 'inherit', 'pipe'],
    encoding: 'utf8',
    maxBuffer: EXPORT_STDERR_MAX_BYTES
  }) || {}
  if (r.error) {
    throw failure(`pathofexile-dat could not be started: ${r.error.message}`, FAIL_KIND.UNKNOWN)
  }
  const stderr = String(r.stderr || '')
  // The child's stderr is not swallowed just because it is being classified:
  // whoever has the container log open should see it where it happened.
  if (stderr.trim()) console.error(stderr.trimEnd())
  const bad = classifyExportFailure({
    status: r.status, signal: r.signal, stderr, languageName, patch, patchSource
  })
  if (bad) throw failure(bad.reason, bad.kind)
  return workDir
}

/**
 * Reads the exported tables and description files back in.
 *
 * THE MESSAGE NAMES WHAT IS ACTUALLY MISSING. It used to say "a misspelled
 * language name filters the list empty" for every shape of incomplete export,
 * which is one possible cause stated as the finding (docs/bugs.md B24). The
 * export writes one directory per translation, so the two sides can simply be
 * told apart:
 *
 *   neither side there   the export wrote no tables at all — that is not about
 *                        the language, and the reason says so.
 *   only English there   the target translation produced nothing. THAT is the
 *                        misspelled/unaccepted language name, and here it is a
 *                        finding rather than a guess.
 *   a single table gone  neither of the two; named as itself.
 */
export async function loadGameData (dir, languageName) {
  const enDir = path.join(dir, 'tables/English')
  const tgDir = path.join(dir, 'tables', languageName)
  if (!existsSync(enDir) && !existsSync(tgDir)) {
    throw new Error(
      `export incomplete: ${dir}/tables holds neither English nor ${languageName}. ` +
      'The exporter wrote no tables at all — this is not about the language name.'
    )
  }
  if (!existsSync(tgDir)) {
    throw new Error(
      `export incomplete: ${dir}/tables has English but no ${languageName}. ` +
      `pathofexile-dat did not accept "${languageName}" as a translation name: it filters its ` +
      'hardcoded list with it and exits 0 when nothing matches. Check LANGUAGE_NAMES in ' +
      'lang-data-gen.mjs against the list in pathofexile-dat/dist/cli/export-tables.js.'
    )
  }
  const tables = {}
  for (const name of REQUIRED_TABLES) {
    const en = path.join(enDir, `${name}.json`)
    const tg = path.join(tgDir, `${name}.json`)
    if (!existsSync(en) || !existsSync(tg)) {
      throw new Error(
        `export incomplete: ${name}.json is missing for ` +
        `${existsSync(en) ? languageName : 'English'} — both translations were exported, this one table was not.`
      )
    }
    tables[name] = {
      en: JSON.parse(await readFile(en, 'utf8')),
      tg: JSON.parse(await readFile(tg, 'utf8'))
    }
    if (tables[name].en.length !== tables[name].tg.length) {
      throw new Error(`${name}: row count differs between English (${tables[name].en.length}) and ${languageName} (${tables[name].tg.length}) — the index join would be wrong`)
    }
  }
  const filesDir = path.join(dir, 'files')
  const names = await readdir(filesDir)
  const blocks = []
  let fileCount = 0
  for (const f of names) {
    if (!f.endsWith('.txt')) continue
    // UTF-16LE, all languages in one file.
    const text = (await readFile(path.join(filesDir, f))).toString('utf16le')
    blocks.push(...parseStatDescriptions(text))
    fileCount++
  }
  if (!fileCount) throw new Error(`no description files in ${filesDir}`)
  return { tables, blocks, fileCount }
}

// ------------------------------------------------------------------ report

function summarise (report) {
  const rows = [...report.byStrategy].sort((a, b) => b[1] - a[1])
  const lines = rows.map(([k, v]) => `    ${String(v).padStart(6)}  ${k}`)
  return lines.join('\n')
}

// -------------------------------------------------------------------- main

export async function generate (opts = {}) {
  const lang = opts.lang
  const languageName = LANGUAGE_NAMES[lang]
  if (!languageName) {
    throw new Error(`unknown language code ${JSON.stringify(lang)}. Known: ${Object.keys(LANGUAGE_NAMES).join(', ')}`)
  }
  const skeletonDir = opts.skeleton ?? path.join(RENDERER_DATA, 'en')
  const outDir = opts.out ?? path.join(RENDERER_DATA, lang)
  const workDir = opts.work ?? path.join(RENDERER_DATA, '.lang-work')

  const enItemsText = await readFile(path.join(skeletonDir, 'items.ndjson'), 'utf8')
  const enStatsText = await readFile(path.join(skeletonDir, 'stats.ndjson'), 'utf8')
  const enItems = ndjson(enItemsText)
  const enStats = ndjson(enStatsText)
  console.log(`Skeleton ${skeletonDir}: ${enItems.length} item lines, ${enStats.length} stat lines`)

  // The set this run would REPLACE — the yardstick for "did the derivation
  // break", as opposed to "is the English side ahead of the game data" (see the
  // coverage section of validate()). By default that is the output dir itself,
  // because a plain run writes over the live set; the data refresher builds into
  // a fresh snapshot dir and therefore has to name the live one explicitly.
  // Absent is a legitimate answer — a first build has nothing to be measured
  // against and says so instead of pretending to a baseline of zero.
  const previousDir = opts.previous ?? outDir
  const maxLossRatio = opts.maxLossRatio ?? DEFAULT_MAX_COVERAGE_LOSS_RATIO
  let previousStats = null
  try {
    previousStats = ndjson(await readFile(path.join(previousDir, 'stats.ndjson'), 'utf8'))
  } catch { previousStats = null }
  console.log(previousStats
    ? `Baseline ${previousDir}: ${previousStats.length} stat lines — the loss bar (${(maxLossRatio * 100).toFixed(2)} %) applies to what they cover`
    : `Baseline: no previous set at ${previousDir} — the loss bar (${(maxLossRatio * 100).toFixed(2)} %) applies to the English set as a whole`)

  // The patch is looked up when it was not passed — the run has to know it
  // anyway (it goes into the CDN path AND into build-info.json), and requiring
  // a human to type it every league is exactly the maintenance this project
  // wants at zero. A reused --game-data export skips the lookup: nothing is
  // downloaded, so there is nothing to version, and the provenance stays honest
  // by recording no patch at all.
  let patch = opts.patch
  // Where it came from travels with it: the export's CDN failure means one
  // thing when the version was looked up and another when it was typed into the
  // admin form, and classifyExportFailure() cannot tell them apart on its own.
  let patchSource = opts.patchSource ?? ''
  if (!patch && !opts.gameData) {
    const r = await resolvePatchVersion({ fetchImpl: opts.fetchImpl })
    patch = r.patch
    patchSource = r.source
    console.log(`Patch ${patch} (from ${r.source})`)
    if (r.mismatch) console.warn(`[lang-data] ${r.mismatch}`)
  }

  const gameDir = opts.gameData ?? await exportGameData({ workDir, languageName, patch, patchSource })
  const { tables, blocks, fileCount } = await loadGameData(gameDir, languageName)
  console.log(`Game data ${gameDir}: ${fileCount} description files, ${blocks.length} blocks, ${REQUIRED_TABLES.length} tables`)

  const pseudoRaw = JSON.parse(await readFile(PSEUDO_TABLE, 'utf8'))
  const pseudo = new Map()
  for (const [en, byLang] of Object.entries(pseudoRaw.matchers)) {
    if (byLang[lang] != null) pseudo.set(en, byLang[lang])
  }
  console.log(`Pseudo matcher hand table: ${pseudo.size} of ${Object.keys(pseudoRaw.matchers).length} entries carry ${lang}`)

  const resolver = createResolver({ blocks, targetLang: languageName, tables })
  console.log(`Line index ${resolver.lineIndex.size}, templates ${resolver.templates.length}, frames ${resolver.frames.length}`)

  const stats = deriveStats(enStats, resolver.resolve, pseudo)
  const items = deriveItems(enItems, tables)
  const textPairs = buildTextPairs(blocks, languageName)

  console.log(`\nMatchers ${stats.report.matchers} (${stats.report.pseudo} pseudo). Resolved by:`)
  console.log(summarise(stats.report))
  console.log(`  splits +${stats.report.split}, collapses ${stats.report.collapsed.length}, collapse conflicts ${stats.report.collapseConflicts.length}`)
  console.log(`  ambiguous ${stats.report.ambiguous.length}, unresolved ${stats.report.misses.length}, pseudo without hand entry ${stats.report.pseudoMisses.length}`)
  console.log(`  advanced ${stats.report.advancedTotal}, of those unresolved ${stats.report.advancedMissing.length}`)
  console.log(`Items ${items.report.total}: ${items.report.translated} translated, ${items.report.kept.length} kept English, ${items.report.ambiguous.length} ambiguous`)
  // A namespace the derivation has no name source for, said out loud instead of
  // dissolving into `kept English` (docs/bugs.md B24). Its own line, its own
  // heading, and it goes into result.warnings below so the run's summary carries
  // it too.
  if (items.report.unknownNamespaces.length) {
    console.warn(`\nUNKNOWN ITEM NAMESPACE (${items.report.unknownNamespaces.length}): no entry in ITEM_NAME_SOURCES, so every line of it keeps its English name:`)
    for (const u of items.report.unknownNamespaces) console.warn(`    ${u.namespace}  ${u.lines} lines`)
  }
  console.log(`Text pair table: ${textPairs.size} target lines`)

  const result = validate({
    enStats,
    deStats: stats.lines,
    enItems,
    deItems: items.lines,
    previousStats,
    maxLossRatio
  })

  // Coverage gaps are listed in full, never summarised — same hardness
  // apt-data-update.mjs applies to removed entries. Split by the distinction
  // that decides the run: what this run LOST, and what it simply cannot supply.
  const oneLine = r => '    ' + String(r).replace(/\n/g, ' \\n ')
  if (result.counts.baselineCovered != null) {
    if (result.counts.regressedRefs.length) {
      console.warn(`\nCOVERAGE LOST against ${previousDir}: ${result.counts.regressedRefs.length} refs the previous set covered have no matcher now:`)
      for (const r of result.counts.regressedRefs) console.warn(oneLine(r))
    }
    if (result.counts.newGapRefs.length) {
      console.warn(`\nCOVERAGE GAP (new, the previous set did not carry these either): ${result.counts.newGapRefs.length} English refs have no matcher at all:`)
      for (const r of result.counts.newGapRefs) console.warn(oneLine(r))
    }
  } else if (result.counts.uncovered) {
    console.warn(`\nCOVERAGE GAP: ${result.counts.uncovered} English refs have no matcher at all:`)
    for (const r of result.counts.uncoveredRefs) console.warn(oneLine(r))
  }
  if (stats.report.misses.length) {
    // Split by whether the stat is NEW to this run, because that is the one
    // question the operator asks next and the log used to make him answer by
    // hand (docs/bugs.md B23). Matchers on refs the previous set already had are
    // texts the derivation used to manage and does not any more — a defect here.
    // Matchers on refs that only just arrived with an English update are texts
    // the game data may simply not contain yet, which is upstream's schedule and
    // not a defect. Same list, sorted by which of the two it is.
    const known = previousStats
      ? new Set(previousStats.flatMap(l => (l.stats ? l.stats : [l])).map(s => s?.ref).filter(Boolean))
      : null
    const onKnown = known ? stats.report.misses.filter(m => known.has(m.ref)) : stats.report.misses
    const onNew = known ? stats.report.misses.filter(m => !known.has(m.ref)) : []
    console.warn(`\nUnresolved matchers (${stats.report.misses.length}):`)
    if (known) console.warn(`  on stats the previous set already had (${onKnown.length}):`)
    for (const m of onKnown) console.warn('    ' + m.string.replace(/\n/g, ' \\n '))
    if (known && onNew.length) {
      console.warn(`  on stats that are new since the previous set (${onNew.length}) — these have no target text in the game data of this patch:`)
      for (const m of onNew) console.warn('    ' + m.string.replace(/\n/g, ' \\n '))
    }
  }
  if (stats.report.pseudoMisses.length) {
    console.warn(`\nPseudo matchers without a ${lang} hand entry (${stats.report.pseudoMisses.length}):`)
    for (const m of stats.report.pseudoMisses) console.warn('    ' + JSON.stringify(m))
  }

  const itemsText = toNdjson(items.lines)
  const statsText = toNdjson(stats.lines)

  // The silent English fallback: identical output means the language files
  // never arrived.
  if (itemsText === enItemsText) result.errors.push('items.ndjson is byte identical to the English one — silent English fallback')
  if (statsText === enStatsText) result.errors.push('stats.ndjson is byte identical to the English one — silent English fallback')
  if (result.counts.longer > result.counts.statsEn) result.errors.push('more target matchers than English ones in nearly every stat — the derivation is producing forms without a template')
  // A WARNING, not an error, and the direction is argued: an English name is not
  // a wrong price, while refusing the run would also throw away every name that
  // WAS translated. What it must not be is silent (docs/bugs.md B24).
  for (const u of items.report.unknownNamespaces) {
    result.warnings.push(
      `item namespace ${u.namespace} has no entry in ITEM_NAME_SOURCES — its ${u.lines} lines keep their English name`)
  }

  console.log('\nValidation:')
  const split = result.counts.baselineCovered != null
    ? ` (${result.counts.regressedRefs.length} lost against the previous set of ${result.counts.baselineCovered} covered, ${result.counts.newGapRefs.length} the previous set had no matcher for either)`
    : ''
  console.log(`  stats ${result.counts.statsEn} -> ${result.counts.statsDe}, without matcher ${result.counts.uncovered}${split}`)
  console.log(`  matcher list longer ${result.counts.longer}, shorter ${result.counts.shorter} (${result.counts.shorterToZero} of them down to no matcher at all, ${result.counts.shorter - result.counts.shorterToZero} still covered)`)
  console.log(`  stats with advanced but none in the target ${result.counts.advMissing}`)
  console.log(`  namespaces ${JSON.stringify(result.counts.namespaces)}`)
  for (const w of result.warnings) console.warn('  WARNING: ' + w)

  if (result.errors.length) {
    for (const e of result.errors) console.error('  ERROR: ' + e)
    throw new Error(`validation failed with ${result.errors.length} error(s) — nothing written`)
  }
  console.log('  no errors.')

  if (opts.dryRun) {
    console.log('\n--dry-run: nothing written.')
    return { stats, items, result }
  }

  // tmp and rename — the pattern the refresher uses for its snapshots. A
  // half-written data dir must never become visible.
  const tmp = outDir + '.tmp'
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  await writeFile(path.join(tmp, 'items.ndjson'), itemsText)
  await writeFile(path.join(tmp, 'stats.ndjson'), statsText)
  await writeFile(path.join(tmp, TEXT_PAIRS_FILE), toNdjson(
    [...textPairs].map(([target, en]) => ({ t: target, en: [...en] }))
  ))
  // What this set was built from, written WITH the set so the two can never
  // drift apart. The refresher reads it back to decide whether a regeneration
  // is due; a set without it counts as unknown provenance and is rebuilt.
  await writeFile(path.join(tmp, BUILD_INFO_FILE), JSON.stringify({
    lang,
    patch: patch ?? null,
    enFingerprint: buildFingerprint(enItemsText, enStatsText),
    builtAt: new Date().toISOString(),
    // What this run measured, so the admin area can answer "is this still being
    // maintained, and how complete is it" without a log (buildRunSummary above).
    run: buildRunSummary({ stats, items, result })
  }, null, 2) + '\n')
  await mkdir(outDir, { recursive: true })
  for (const f of ['items.ndjson', 'stats.ndjson', TEXT_PAIRS_FILE, BUILD_INFO_FILE]) {
    await rename(path.join(tmp, f), path.join(outDir, f))
  }
  await rm(tmp, { recursive: true, force: true })
  console.log(`\nWritten: ${outDir}/{items,stats,text-pairs}.ndjson + ${BUILD_INFO_FILE} (client_strings.js untouched)`)

  if (opts.index !== false) {
    // Same generator the refresher runs after every adopted snapshot — FNV-1a
    // over UTF-8, offsets in UTF-16 code units, language agnostic.
    const bins = buildIndexBins({ itemsNdjson: itemsText, statsNdjson: statsText })
    for (const [name, buf] of Object.entries(bins)) {
      await writeFile(path.join(outDir, name), Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
    }
    console.log(`Index files regenerated (${Object.keys(bins).join(', ')}).`)
  }
  return { stats, items, result }
}

function parseArgs (argv) {
  const o = { index: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--no-index') o.index = false
    else if (a === '--lang') o.lang = argv[++i]
    else if (a === '--patch') o.patch = argv[++i]
    else if (a === '--skeleton') o.skeleton = path.resolve(argv[++i])
    else if (a === '--out') o.out = path.resolve(argv[++i])
    else if (a === '--game-data') o.gameData = path.resolve(argv[++i])
    else if (a === '--work') o.work = path.resolve(argv[++i])
    else if (a === '--previous') o.previous = path.resolve(argv[++i])
    else if (a === '--max-loss-ratio') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error('--max-loss-ratio takes a fraction between 0 and 1')
      o.maxLossRatio = n
    }
    else throw new Error(`unknown option ${a}`)
  }
  if (!o.lang) throw new Error('--lang is required (e.g. --lang de)')
  // --patch stays optional: generate() looks it up (POE_PATCH_VERSION first,
  // then PATCH_VERSION_URL) and fails loudly if neither answers.
  return o
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generate(parseArgs(process.argv.slice(2))).catch(err => {
    console.error('ERROR:', err.message)
    process.exit(1)
  })
}
