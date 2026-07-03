/**
 * STAGE 2 — verify.
 *
 * A live agent actually executes each proposed reverter / skill reversal
 * against the real backend and reports what worked (keep / adjust / delete),
 * tuning the trigger keyword and fixing the skill / capture_tools. Each pattern
 * runs against a freshly SEEDED sandbox (a per-server reset hook) so every test
 * starts from known data. The agent may also HARVEST extra ops it verifies
 * live; a "delete" verdict DROPS the pattern (the no-backup default covers it).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import type { McpTool } from "../dist/explore/list_mcp_tools.js";
import type { RecoveryPattern } from "../dist/explore/experiences.js";
import { subagent } from "./infra.js";
import { buildVerificationPrompt } from "./prompts.js";
import { parsePatterns, reconcileCaptureTools } from "./tree_generation.js";
import { listToolsCliPath } from "./mcp_scan.js";
import { serverProfile } from "./server_profiles.js";
import type { McpServerDef, VerdictPattern } from "./types.js";
import type { SandboxConfig } from "../dist/types.js";

const { runRunnerForText } = subagent;

// ── Per-server RESET hook: re-create a known seeded sandbox state before each
//    pattern is verified, so every pattern tests against fresh, known data. The
//    reset is issued through the real MCP (a tools/call via the list CLI). The
//    re-seed call (which tool + args) lives in the per-server PROFILE — nothing
//    server-specific is hardcoded here. A server whose profile has no `reset`
//    (HTTP/browser, or anything not yet profiled) resets to a no-op (the verify
//    agent creates its own throwaway items). ─────────────────────────────────

/** Issue a single tools/call through the live MCP to reset the sandbox to a
 *  known seeded state for `server`. Returns true if the reset ran (or there is
 *  no reset needed for this server). Best-effort: logs and returns false on
 *  failure so the caller can still attempt verification. */
export function resetSandboxState(server: string, def: McpServerDef): boolean {
  // Only stdio servers (with a command) AND servers whose profile declares a
  // reset hook get a programmatic re-seed; HTTP/browser servers (and unprofiled
  // ones) let the verify agent seed their own throwaway items.
  const profile = serverProfile(server);
  if (profile.reset && def.command) {
    try {
      const out = execFileSync(
        process.execPath,
        [listToolsCliPath(), "--call", profile.reset.tool, JSON.stringify(profile.reset.args), def.command, ...(def.args ?? [])],
        { encoding: "utf-8", timeout: 40000, maxBuffer: 4 * 1024 * 1024 },
      );
      const res = JSON.parse(out) as { ok?: boolean };
      return res.ok === true;
    } catch (e) {
      process.stderr.write(`  [${server}] seed reset failed: ${(e as Error).message}\n`);
      return false;
    }
  }
  return true; // no reset hook for this server — agent seeds its own items
}

const stripVerdict = (p: VerdictPattern): RecoveryPattern => {
  const { verdict, ...rest } = p; void verdict; return rest;
};

/** Match an emitted result back to its candidate (echo) vs. a harvested new op.
 *  The first object whose action overlaps the candidate is the echo. */
const isEchoOf = (p: VerdictPattern, cand: VerdictPattern): boolean =>
  p.action === cand.action ||
  (!!p.trigger && p.trigger === cand.trigger);

export interface VerifyResult {
  finalPatterns: RecoveryPattern[];
  /** Merge keys (trigger-or-action, lowercased — MUST mirror explore.ts keyOf)
   *  of candidates the verifier DELETED this run, so the accumulate step can
   *  RETRACT a matching pattern persisted by an earlier exploration (otherwise
   *  a stale prior entry is carried forward forever). */
  droppedKeys: string[];
  adjusted: number;
  harvested: number;
}

/**
 * VERIFY & ACCUMULATE, ONE PATTERN PER RUN. Each pattern gets its own agent run
 * + a fresh SEEDED sandbox. The agent destructs → reverses → confirms, returning
 * a verdict: keep / adjust (re-test the corrected fix once) / delete (drop the
 * pattern — the no-backup default covers it — and retract any prior persisted
 * entry under the same key). It may also HARVEST extra patterns it verified live.
 */
export function verifyAndAccumulate(
  server: string,
  def: McpServerDef,
  candidates: VerdictPattern[],
  liveTools: McpTool[],
  target: string | null,
  verifyConfig: SandboxConfig,
  /** Called after EACH candidate's verdict lands (echo + harvest applied) with
   *  the patterns/dropped-keys so far — the caller persists them immediately,
   *  so a killed run keeps every pattern verified up to that point instead of
   *  losing the whole in-memory accumulation. */
  onCheckpoint?: (patternsSoFar: RecoveryPattern[], droppedKeysSoFar: string[]) => void,
): VerifyResult {
  let idx = 0;

  // Run ONE verify pass for a single candidate against a freshly-seeded
  // sandbox. Returns every pattern object the agent emitted, each carrying its
  // `verdict`. ONLY the echo of the candidate inherits the candidate's fields
  // (so an omitted trigger/skill is preserved); a HARVESTED new op is kept
  // exactly as emitted — inheriting the candidate's skill/capture_tools/
  // reverter/trigger would contaminate it AND make isEchoOf misclassify it as
  // the echo (losing the harvest).
  const runOneVerify = (cand: VerdictPattern): VerdictPattern[] => {
    resetSandboxState(server, def); // fresh known state before each test
    const resultFile = path.join(os.tmpdir(), `chats-verify-${process.pid}-${idx++}.json`);
    try { fs.rmSync(resultFile, { force: true }); } catch { /* ignore */ }
    const verifyText = runRunnerForText(
      buildVerificationPrompt(server, [cand], target, resultFile), verifyConfig, 600,
      { neededServer: server, toolAllow: liveTools.map((t) => t.name) },
    );
    let parsed: VerdictPattern[] | null = null;
    try {
      if (fs.existsSync(resultFile)) parsed = parsePatterns(fs.readFileSync(resultFile, "utf-8"));
    } catch { /* ignore */ }
    if (!parsed) parsed = verifyText ? parsePatterns(verifyText) : null;
    // ARCHIVE the raw per-pattern verdict file (don't delete): the trail under
    // <cwd>/.chats-sandbox/verdicts/ is the inspectable evidence of what each
    // verify run actually reported. Copy+rm (rename can EXDEV across /tmp).
    try {
      if (fs.existsSync(resultFile)) {
        const vdir = path.join(process.cwd(), ".chats-sandbox", "verdicts");
        fs.mkdirSync(vdir, { recursive: true });
        fs.copyFileSync(resultFile, path.join(vdir, `${server}-${path.basename(resultFile)}`));
      }
      fs.rmSync(resultFile, { force: true });
    } catch { /* best-effort */ }
    if (!parsed || !parsed.length) return [];
    const merged = parsed.map((pp) => (
      isEchoOf(pp, cand)
        ? { ...cand, ...pp, trigger: pp.trigger || cand.trigger }
        : pp
    ));
    // Consistency invariant (same as stage 1): after the verifier's final
    // skill/recipe wording lands, capture_tools must still cover every live
    // tool that prose references — the runtime narrows the subagent to
    // capture_tools, and a recipe step naming an excluded tool is unfollowable.
    for (const pp of merged) reconcileCaptureTools(pp, liveTools.map((t) => t.name));
    return merged;
  };

  // Merge key — MUST mirror keyOf in explore.ts (trigger else action, lowercased)
  // so a dropped key retracts the matching prior-file entry.
  const keyOf = (p: VerdictPattern): string => (p.trigger || p.action || "").toLowerCase();

  const finalPatterns: RecoveryPattern[] = [];
  const droppedKeys: string[] = [];
  let adjusted = 0;
  let harvested = 0;

  const MAX_ATTEMPTS = 3;   // verify up to 3x; if never confirmed, DROP the pattern
  for (const cand of candidates) {
    // Attempt loop: keep re-testing (feeding the verifier's corrections back)
    // until we get a CONFIRMED verified=true keep, an explicit delete, or we
    // exhaust the attempt budget. Only a confirmed pattern is shipped — an
    // unverified proposal (flaky, or a reversal that never actually worked) is
    // removed from the experience, not persisted as an unverified guess.
    let echo: VerdictPattern | undefined;
    let current: VerdictPattern = cand;
    let confirmed = false;
    let deleted = false;
    let attempt = 0;
    const allResults: VerdictPattern[] = [];
    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      const results = runOneVerify(current);
      for (const r of results) allResults.push(r);
      echo = results.find((p) => isEchoOf(p, current) || isEchoOf(p, cand));
      if (echo && echo.verdict === "delete") { deleted = true; break; }
      if (echo && echo.verdict === "keep" && echo.verified === true) { confirmed = true; break; }
      // "adjust" (or an unconfirmed keep): feed ALL the verifier's corrections
      // back and re-test, until the attempt budget runs out.
      if (echo) {
        if (echo.verdict === "adjust") adjusted++;
        const { verdict: _v, ...corrected } = echo; void _v;
        current = { ...cand, ...corrected } as VerdictPattern;
      }
    }
    if (confirmed && echo) {
      finalPatterns.push(stripVerdict(echo));
    } else {
      // explicit delete OR never confirmed after MAX_ATTEMPTS → drop + retract.
      if (!deleted && attempt >= MAX_ATTEMPTS) {
        process.stderr.write(`  [${server}] dropped after ${MAX_ATTEMPTS} unconfirmed attempts: ${keyOf(cand)}\n`);
      }
      droppedKeys.push(keyOf(cand));
      if (echo) droppedKeys.push(keyOf(echo));
    }
    // HARVEST: any extra pattern the agent reported (not the echo), across all
    // attempts — already verified live by the agent. Keep keep+verified ones.
    const seenHarvest = new Set<string>();
    for (const extra of allResults) {
      if (echo && (extra === echo || isEchoOf(extra, cand))) continue;
      if (extra.verdict !== "delete" && extra.verified === true) {
        const k = keyOf(extra);
        if (seenHarvest.has(k)) continue;
        seenHarvest.add(k);
        harvested++;
        finalPatterns.push(stripVerdict(extra));
      }
    }
    // CHECKPOINT: persist everything verified so far — a kill after this point
    // loses at most the pattern currently being tested, never completed work.
    try {
      onCheckpoint?.([...finalPatterns], [...new Set(droppedKeys)].filter(Boolean));
    } catch (e) {
      process.stderr.write(`  [${server}] checkpoint save failed: ${(e as Error).message}\n`);
    }
  }

  return { finalPatterns, droppedKeys: [...new Set(droppedKeys)].filter(Boolean), adjusted, harvested };
}
