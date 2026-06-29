/**
 * STAGE 2 — verify.
 *
 * A live agent actually executes each proposed easy-win reversal against the
 * real backend and reports what worked (keep / adjust / delete). Each pattern
 * runs against a freshly SEEDED sandbox (a per-server reset hook) so every test
 * starts from known data. The agent may also HARVEST extra ops it verifies live.
 * Read-only candidates get one cheap batch pass (confirming "nothing changed").
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import type { McpTool } from "../dist/explore/list_mcp_tools.js";
import type { RecoveryPattern } from "../dist/explore/experiences.js";
import { subagent } from "./infra.js";
import { buildVerificationPrompt, buildReadOnlyVerifyPrompt } from "./prompts.js";
import { parsePatterns, parseReadOnly } from "./tree_generation.js";
import { listToolsCliPath } from "./mcp_scan.js";
import { serverProfile } from "./server_profiles.js";
import type { McpServerDef, ReadOnlyTemplate, VerdictPattern } from "./types.js";
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
  noBackupPatterns: string[];
  adjusted: number;
  harvested: number;
}

/**
 * VERIFY & ACCUMULATE, ONE PATTERN PER RUN. Each pattern gets its own agent run
 * + a fresh SEEDED sandbox. The agent destructs → reverses → confirms, returning
 * a verdict: keep / adjust (re-test the corrected fix once) / delete. It may also
 * HARVEST extra patterns it verified live. Read-only candidates get one cheap
 * batch run at the end.
 */
export function verifyAndAccumulate(
  server: string,
  def: McpServerDef,
  candidates: VerdictPattern[],
  proposedReadOnly: ReadOnlyTemplate[],
  mixedNoBackup: string[],
  liveTools: McpTool[],
  target: string | null,
  verifyConfig: SandboxConfig,
): VerifyResult {
  let idx = 0;

  // Run ONE verify pass for a single candidate against a freshly-seeded
  // sandbox. Returns every pattern object the agent emitted (echoed +
  // harvested), each carrying its `verdict`. Preserves the Stage-1 trigger
  // when the verifier omits it.
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
    try { fs.rmSync(resultFile, { force: true }); } catch { /* ignore */ }
    if (!parsed || !parsed.length) return [];
    return parsed.map((pp) => ({
      ...cand, ...pp,
      trigger: pp.trigger || cand.trigger,
    }));
  };

  const finalPatterns: RecoveryPattern[] = [];
  let adjusted = 0;
  let harvested = 0;

  for (const cand of candidates) {
    const results = runOneVerify(cand);
    // The echoed verdict for THIS candidate.
    let echo = results.find((p) => isEchoOf(p, cand));
    // "adjust": the agent supplied a corrected easy_win — re-test ONCE.
    if (echo && echo.verdict === "adjust") {
      adjusted++;
      const retry = runOneVerify({ ...cand, easy_win: echo.easy_win });
      const re = retry.find((p) => isEchoOf(p, cand));
      if (re) echo = re;
    }
    // keep the candidate's record (deleted ones are recorded as verified=false
    // so the backup trigger still fires — over-back-up is the safe direction).
    if (echo) {
      const verdict = echo.verdict;
      finalPatterns.push(stripVerdict({
        ...echo,
        verified: verdict === "delete" ? false : echo.verified,
      }));
    } else {
      finalPatterns.push(stripVerdict(cand));
    }
    // HARVEST: any extra pattern the agent reported (not the echo) — already
    // verified live by the agent. Keep ones marked keep+verified.
    for (const extra of results) {
      if (extra === echo || isEchoOf(extra, cand)) continue;
      if (extra.verdict !== "delete" && extra.verified === true) {
        harvested++;
        finalPatterns.push(stripVerdict(extra));
      }
    }
  }

  // ── Read-only verify (ONE batch run — confirming "nothing changed" is
  //    cheap, so all candidates go in a single agent pass) ──────────
  let noBackupPatterns: string[] = [];
  if (proposedReadOnly.length) {
    const rf = path.join(os.tmpdir(), `chats-ro-verify-${process.pid}.json`);
    try { fs.rmSync(rf, { force: true }); } catch { /* ignore */ }
    const vtext = runRunnerForText(
      buildReadOnlyVerifyPrompt(server, proposedReadOnly, target, rf), verifyConfig, 600,
      { neededServer: server, toolAllow: liveTools.map((t) => t.name) },
    );
    let verified: ReadOnlyTemplate[] = [];
    try { if (fs.existsSync(rf)) verified = parseReadOnly(fs.readFileSync(rf, "utf-8")); } catch { /* ignore */ }
    if (!verified.length && vtext) verified = parseReadOnly(vtext);
    try { fs.rmSync(rf, { force: true }); } catch { /* ignore */ }
    // Keep ONLY entries the live pass confirmed unchanged. A flaky/failed
    // verify yields an empty list rather than admitting unverified guesses.
    noBackupPatterns = verified.filter((r) => r.verified === true).map((r) => r.match);
  }
  // MIXED-tool read-only ARG keywords (e.g. execute_sql SELECT/EXPLAIN/SHOW):
  // the proposer derived these as the no-backup half of a MIXED tool. They
  // need no live read-only pass (a SELECT shape is self-evidently a read), so
  // union them straight into the no-backup list.
  noBackupPatterns = [...new Set([...noBackupPatterns, ...mixedNoBackup])];

  return { finalPatterns, noBackupPatterns, adjusted, harvested };
}
