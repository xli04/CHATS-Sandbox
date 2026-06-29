/**
 * Bridge to the main CHATS-Sandbox build.
 *
 * The self-exploration module is compiled on its own (self-exploration/*.ts →
 * dist/self-exploration/*.js) so it can live in one obvious place, but it reuses
 * the project's shared runtime modules instead of duplicating them. Those modules
 * are emitted by the MAIN build as siblings under dist/ (dist/explore, dist/backup,
 * dist/util), so from dist/self-exploration/infra.js a relative require("../<x>")
 * resolves straight into them.
 *
 * The `require()` paths are runtime-correct (as if this file sits in
 * dist/self-exploration). The `as typeof import("../dist/...")` casts are
 * COMPILE-only: the compiler resolves them against the emitted .d.ts files
 * (../dist relative to THIS source dir) for full type-safety, then erases them.
 * That dual path is the whole reason this bridge exists in one place.
 */

export const experiences =
  require("../explore/experiences.js") as typeof import("../dist/explore/experiences.js");

export const subagent =
  require("../backup/subagent.js") as typeof import("../dist/backup/subagent.js");

export const extractJson =
  require("../util/extract_json.js") as typeof import("../dist/util/extract_json.js");
