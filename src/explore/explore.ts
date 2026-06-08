/**
 * Self-exploration pipeline — extract "easy-win" reversal patterns per
 * MCP server and store them as recovery experiences.
 *
 * `chats-sandbox explore [server]` scans the backup history for MCP /
 * remote tools the agent has actually used, then asks the configured
 * model (the same runner the tier-3 subagent uses) to propose the
 * cheapest reversible counterpart for each destructive operation —
 * preferring in-place reversible state changes (delete→archive/private,
 * edit→revert) over the expensive scrape-content-and-recreate default.
 * Results are saved per server and injected into the backup subagent
 * prompt (see explore/experiences.ts + backup/subagent.ts).
 *
 * Lightweight adaptation of NVIDIA ToolShield's experience pipeline,
 * aimed at recoverability instead of safety.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SandboxConfig } from "../types.js";
import {
  serverFromToolName,
  saveExperiences,
  experiencePath,
  type RecoveryPattern,
  type ServerExperiences,
} from "./experiences.js";

/** Scan backup history → map of server → observed tool names. */
export function discoverServers(config: SandboxConfig): Map<string, Set<string>> {
  const servers = new Map<string, Set<string>>();
  const backupRoot = path.resolve(config.backupDir);
  if (!fs.existsSync(backupRoot)) return servers;
  for (const d of fs.readdirSync(backupRoot).filter((x) => x.startsWith("action_"))) {
    const meta = path.join(backupRoot, d, "metadata.json");
    if (!fs.existsSync(meta)) continue;
    try {
      const arr = JSON.parse(fs.readFileSync(meta, "utf-8")) as Array<Record<string, unknown>>;
      for (const a of arr) {
        const tn = typeof a.toolName === "string" ? a.toolName : "";
        const server = serverFromToolName(tn);
        if (!server) continue;
        if (!servers.has(server)) servers.set(server, new Set());
        servers.get(server)!.add(tn);
      }
    } catch { /* skip */ }
  }
  return servers;
}

/** Scan backup history for the remote target (origin URL) this server
 *  was used against — so the explorer probes the real system. */
export function discoverTarget(config: SandboxConfig, server: string): string | null {
  const backupRoot = path.resolve(config.backupDir);
  if (!fs.existsSync(backupRoot)) return null;
  const origins = new Map<string, number>();
  const scan = (text: string): void => {
    const re = /https?:\/\/[^\s"'<>)]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      try {
        const u = new URL(m[0]);
        const origin = u.origin;
        origins.set(origin, (origins.get(origin) ?? 0) + 1);
      } catch { /* skip */ }
    }
  };
  for (const d of fs.readdirSync(backupRoot).filter((x) => x.startsWith("action_"))) {
    for (const f of ["remote-state.json", "instruction.txt"]) {
      const p = path.join(backupRoot, d, f);
      if (fs.existsSync(p)) {
        try { scan(fs.readFileSync(p, "utf-8")); } catch { /* */ }
      }
    }
  }
  let best: string | null = null;
  let max = 0;
  for (const [o, n] of origins) {
    // Skip obvious non-targets (the LLM/provider endpoints).
    if (/openrouter|anthropic|githubusercontent|openai\.com/.test(o)) continue;
    if (n > max) { max = n; best = o; }
  }
  return best;
}

// ── Stage 1: PROPOSE — a model reasons about possible actions and
//    proposes candidate easy-win reversals. No execution. ───────────
function buildProposalPrompt(server: string, tools: string[]): string {
  return `You are the Recovery Experience Curator for CHATS-Sandbox, a backup/restore system for autonomous agents.

An agent uses the "${server}" MCP server. Observed tools:
${tools.map((t) => `  - ${t}`).join("\n")}

CHATS-Sandbox must reverse destructive/mutating remote actions. The default is expensive: scrape the full remote state to local and recreate it on restore — costly and lossy (recreated entities get NEW ids/timestamps).

STAGE 1 — PROPOSE (reason only; do NOT execute anything)
Reason about what destructive or mutating actions a user can take with these tools. For each, PROPOSE the cheapest reversible "EASY-WIN" — an in-place reversible state change that preserves the original entity. Shape of what we want:
  - "delete a post"  → set it to private/draft instead; reverse = set back to public. No content copy; id preserved.
  - "delete a file"  → move to trash/archive; reverse = move back.
  - "edit a page"    → use version history; reverse = restore prior version.
  - "close an issue" → close is itself reversible; reverse = reopen, capture nothing.

These are PROPOSALS to be tested later, so be concrete about HOW to perform the reversal. Output ONLY a JSON object (no fences, no commentary):

{"patterns":[{"action":"<destructive op>","easy_win":"<proposed cheap reversal AND exactly how to do it>","applies_to":"<tool/capability>"}]}

Output 3-8 proposals covering the most common destructive operations.`;
}

// ── Stage 2: VERIFY — a live agent actually executes each proposed
//    reversal against the real target and reports what worked. ──────
function buildVerificationPrompt(
  server: string,
  candidates: RecoveryPattern[],
  target: string | null,
): string {
  const targetLine = target
    ? `TARGET (a disposable test system — safe to mutate): ${target}`
    : `No URL target was given — the "${server}" MCP operates on its own configured backend (e.g. a database). Use the MCP tools directly against that backend to test. Treat it as disposable: create/clean up throwaway items, don't touch real-looking production data.`;
  const list = candidates.map(
    (c, i) => `  ${i + 1}. action: ${c.action}\n     proposed easy-win: ${c.easy_win}`,
  ).join("\n");
  return `You are the Recovery Verification agent for CHATS-Sandbox. You have LIVE access to the "${server}" MCP tools.

${targetLine}

STAGE 2 — VERIFY (actually execute)
Below are PROPOSED easy-win reversal patterns. For EACH one, actually TEST it with the MCP against the target:
  1. Set up a throwaway item if needed (e.g. create a test post / a test table named chats_probe_*).
  2. Perform the destructive action on it.
  3. Perform the PROPOSED easy-win reversal.
  4. Confirm the original state is restored (re-read / snapshot to check).
  5. Clean up any throwaway items you created.
Record whether the reversal actually WORKED. If the proposed affordance does not exist, mark it verified=false with a short reason. Do NOT invent success.

SAFETY (critical — the target is shared infrastructure):
  - Operate ONLY on throwaway items you create (prefix names with "chats_probe_"). Never touch existing data, tables, or schemas.
  - NEVER modify authentication or access: no ALTER USER/ROLE, CREATE/DROP ROLE, GRANT/REVOKE, password changes, pg_hba, or system catalogs. Doing so will break the connection for everyone.
  - If a proposed reversal would require any of the above to test, mark it verified=false with the reason "unsafe to test" rather than running it.

PROPOSED PATTERNS:
${list}

After testing, output ONLY a JSON object (no fences, no commentary). Echo each pattern with a verified flag and a one-line note:

{"patterns":[{"action":"...","easy_win":"...","applies_to":"...","verified":true,"verify_note":"<what you observed>"}]}`;
}

function parsePatterns(raw: string): RecoveryPattern[] | null {
  // Find the first {...} block and parse it.
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { patterns?: unknown };
    if (!Array.isArray(obj.patterns)) return null;
    const out: RecoveryPattern[] = [];
    for (const p of obj.patterns) {
      if (p && typeof p === "object") {
        const r = p as Record<string, unknown>;
        if (typeof r.action === "string" && typeof r.easy_win === "string") {
          out.push({
            action: r.action,
            easy_win: r.easy_win,
            applies_to: typeof r.applies_to === "string" ? r.applies_to : undefined,
            verified: typeof r.verified === "boolean" ? r.verified : undefined,
            verify_note: typeof r.verify_note === "string" ? r.verify_note : undefined,
          });
        }
      }
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

export interface ExploreOutcome {
  server: string;
  tools: string[];
  target: string | null;
  saved: boolean;
  path?: string;
  proposed: number;
  verified: number;
  error?: string;
}

/**
 * Two-stage exploration per server (modeled on ToolShield):
 *   Stage 1 PROPOSE  — a model reasons about possible destructive
 *                      actions and proposes candidate easy-win reversals.
 *   Stage 2 VERIFY   — a live agent actually executes each proposed
 *                      reversal against the real target and reports what
 *                      worked. Skipped (proposals kept unverified) when
 *                      no target is available.
 *
 * `nowIso` is passed in because the runtime forbids new Date() in some
 * contexts; callers stamp it.
 */
export function runExplore(
  config: SandboxConfig,
  nowIso: string,
  serverArg?: string,
  targetArg?: string,
): ExploreOutcome[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runRunnerForText } = require("../backup/subagent.js");

  const discovered = discoverServers(config);
  let servers: Array<[string, string[]]>;
  if (serverArg) {
    const tools = discovered.get(serverArg);
    servers = [[serverArg, tools ? [...tools] : []]];
  } else {
    servers = [...discovered.entries()].map(([s, t]) => [s, [...t]] as [string, string[]]);
  }

  const outcomes: ExploreOutcome[] = [];
  for (const [server, tools] of servers) {
    const target = targetArg ?? discoverTarget(config, server);

    // ── Stage 1: propose (reasoning) ──────────────────────────────
    const proposalText = runRunnerForText(buildProposalPrompt(server, tools), config, 180);
    const candidates = proposalText ? parsePatterns(proposalText) : null;
    if (!candidates || !candidates.length) {
      outcomes.push({
        server, tools, target, saved: false, proposed: 0, verified: 0,
        error: proposalText ? "stage-1 produced no parseable proposals" : "stage-1 model runner failed",
      });
      continue;
    }

    // ── Stage 2: verify (execution) ───────────────────────────────
    // Always attempt — the runner has the server's MCP tools, so the
    // verifier can execute against either a URL target or the MCP's own
    // backend (e.g. a database). Falls back to stage-1 proposals if
    // stage-2 output doesn't parse.
    let finalPatterns = candidates;
    const verifyText = runRunnerForText(
      buildVerificationPrompt(server, candidates, target), config, 600,
    );
    const verified = verifyText ? parsePatterns(verifyText) : null;
    if (verified && verified.length) finalPatterns = verified;

    const data: ServerExperiences = {
      server, generated: nowIso, observed_tools: tools, patterns: finalPatterns,
    };
    const p = saveExperiences(config, data);
    outcomes.push({
      server, tools, target, saved: true, path: p,
      proposed: candidates.length,
      verified: finalPatterns.filter((x) => x.verified === true).length,
    });
  }
  return outcomes;
}

export { experiencePath };
