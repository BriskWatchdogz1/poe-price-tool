// The first thing the process does.
//
// `config-overrides.mjs` is a library — importing it must have no effect, or it
// could not be tested. But the overrides have to be in `process.env` BEFORE the
// first module-level `process.env.POE_…` read anywhere in the import graph, and
// an ESM module body cannot run "before its imports": the imports run first, in
// source order.
//
// So the side effect lives here, in a module whose ENTIRE job is to run early,
// and server.mjs imports it as its FIRST import. Today every module-level env
// read in the backend happens to be in server.mjs's own body (which runs after
// all imports anyway), so this is belt and braces — but it is the kind of belt
// that keeps holding when somebody later adds `const X = process.env.Y` at the
// top of a helper module. One file, no logic, no way to get the ordering wrong.
//
// Consequence for tests: importing this module reads the real
// POE_CONFIG_OVERRIDES path. Tests of the mechanism import config-overrides.mjs
// and call applyConfigOverrides() themselves; only the end-to-end test spawns a
// server with POE_CONFIG_OVERRIDES pointing into a temp dir.

import { applyConfigOverrides } from './config-overrides.mjs'

export const configOverrideState = applyConfigOverrides()
