// What counts as a PoE patch version — one expression, two readers.
//
// It lived in lang-data-gen.mjs, where it validates the answer of the patch
// lookup and the `POE_PATCH_VERSION` a deployment sets. Since that variable is
// settable from the admin area as well (config-overrides.mjs, the escape hatch
// for exactly the case where the lookup is gone), a SECOND reader has to apply
// the SAME rule: a form that accepts a value the next start refuses would be a
// settings page that lies.
//
// Its own module rather than an import of lang-data-gen.mjs for the mechanical
// reason secret-keys.mjs was split out for: config-overrides.mjs is applied
// synchronously at boot, before the first `process.env` read in the process, and
// lang-data-gen.mjs drags the whole derivation (lang-derive, lang-statdesc,
// apt-index) in behind it. An expression with no imports of its own cannot cost
// anything at boot and cannot be part of an import cycle.
//
// THE RULE: digits and dots, at least two parts, and NO upper bound on how many.
// The part count is not ours to fix — GGG ships a hotfix on a hotfix and the
// version grows a fifth part (see docs/bugs.md, B22: a `{1,3}` tail rejected
// exactly that and froze the localized set for four days). Deliberately no
// looser than that: the string is pasted into a CDN path, so anything with a
// letter (`latest`), a path segment (`../../etc`) or no digit at all still has
// to be refused — that is what the guard is for.
export const PATCH_RE = /^\d+(?:\.\d+)+$/

/** A version this rule accepts, for a message that has to show one. */
export const PATCH_EXAMPLE = '3.29.2.1'
