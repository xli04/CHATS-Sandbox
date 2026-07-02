/**
 * Self-exploration pipeline — learn the backup SKILL (reversal patterns) per
 * MCP server and store it as recovery experiences.
 *
 * `chats-sandbox explore [server]` reads the runner's LIVE MCP connections,
 * then asks the configured model (the same runner the tier-3 subagent uses) to
 * propose the cheapest reversible counterpart for each destructive operation —
 * preferring in-place reversible state changes (delete→archive/private,
 * edit→revert) over the expensive scrape-content-and-recreate default.
 *
 * Two stages per server (modeled on NVIDIA ToolShield's experience pipeline,
 * aimed at recoverability instead of safety):
 *   Stage 1 PROPOSE  (tree_generation.ts) — a model reasons about destructive
 *                    actions and proposes a candidate backup skill for each.
 *   Stage 2 VERIFY   (verify.ts) — a live agent actually executes each proposed
 *                    reversal against the real backend and reports what worked.
 *
 * Results are saved per server (into the runtime experiences dir, where the
 * backup subagent reads them — see ../src/explore/experiences.ts +
 * ../src/backup/subagent.ts) AND archived under self-exploration/results/.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SandboxConfig } from "../dist/types.js";
import type { McpTool } from "../dist/explore/list_mcp_tools.js";
import type { RecoveryPattern, ServerExperiences } from "../dist/explore/experiences.js";
import { experiences } from "./infra.js";
import { readMcpServers, liveToolsForServer, discoverTarget } from "./mcp_scan.js";
import { proposePatterns } from "./tree_generation.js";
import { verifyAndAccumulate } from "./verify.js";
import type { ExploreOutcome } from "./types.js";

const { loadExperiences, saveExperiences, experiencePath } = experiences;

// Re-exported so the CLI (cli.ts) can keep its single require("…/explore.js").
export { readMcpServers, experiencePath };
export type { ExploreOutcome };

/** Where to archive a copy of each server's explored experiences for human
 *  inspection — self-exploration/results/<server>.json. Overridable via
 *  CHATS_SELF_EXPLORATION_RESULTS. Defaults to the repo's source dir, computed
 *  from this compiled file (dist/self-exploration → repo root). */
function resultsDir(): string {
  return process.env.CHATS_SELF_EXPLORATION_RESULTS
    || path.join(__dirname, "..", "..", "self-exploration", "results");
}

/**
 * Assemble the server-level SKILL playbook — the generic backup procedure
 * refined to this server's VERIFIED tool surface — from the per-pattern branch
 * guidance Stage 2 produced. One entry per verified pattern: the in-place
 * reversal how-to or the capture recipe (a mutating op's `skill`), or the
 * deterministic-reverter note (a creation-only op). Deterministic string
 * assembly, no LLM. Empty string when nothing is verified.
 */
export function assemblePlaybook(server: string, patterns: RecoveryPattern[]): string {
  const usable = patterns.filter((p) => p.verified === true);
  if (!usable.length) return "";
  const lines = usable.map((p) => {
    const head = `- ${p.action}${p.trigger ? ` (trigger: ${p.trigger})` : ""}: `;
    // A verified concrete recipe is appended as a REFERENCE example (adapt, do
    // not replay blindly — the live env is dynamic).
    const ref = p.recipe ? `\n    verified reversal (reference, adapt to the live page): ${p.recipe}` : "";
    if (p.skill) return head + p.skill + ref;
    if (p.reverter) {
      const inv = p.reverter.mcp_calls
        ? p.reverter.mcp_calls.map((c) => `${c.tool}(${JSON.stringify(c.args)})`).join("; ")
        : (p.reverter.commands ?? []).join("; ");
      return head + `creation-only — the runtime reverses it deterministically (delete the created entity pinned by "${p.reverter.pin}": ${inv}); capture nothing.`;
    }
    return head + "(verified, no branch guidance recorded)";
  });
  return `How to back up mutations on the "${server}" server — every entry was VERIFIED live and is the fewest-calls approach found. Apply the matching entry's method directly (do NOT re-explore for alternatives); where a "verified reversal (reference)" recipe is given, use it as a known-good starting point and ADAPT its concrete calls to the live page (refs/layout may have shifted):\n${lines.join("\n")}`;
}

/** Best-effort archive of a server's result into self-exploration/results/. */
function archiveResult(data: ServerExperiences): void {
  try {
    const dir = resultsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${data.server}.json`), JSON.stringify(data, null, 2));
  } catch (e) {
    process.stderr.write(`  [${data.server}] could not archive to results/: ${(e as Error).message}\n`);
  }
}

/**
 * `nowIso` is passed in because the runtime forbids new Date() in some
 * contexts; callers stamp it.
 */
export function runExplore(
  config: SandboxConfig,
  nowIso: string,
  serverArg?: string,
  targetArg?: string,
  /** Experience NAME to save under (e.g. "reddit"): the experience identity is
   *  the SITE when a browser MCP drives many sites — the file is named
   *  <experience>.json, its `server` field is the experience name, and
   *  `appliesTo` routes it to the driving MCP server. Without it, the MCP
   *  server's own name is used (dedicated servers like postgres). */
  experienceArg?: string,
): ExploreOutcome[] {
  // One model (in `config`) drives BOTH stages — the runner/model/provider were
  // chosen from CLI args by the caller; there is no separate verify model.
  // Tool acquisition is LIVE off the runner's MCP config (initialize →
  // tools/list). Enumerate / validate against `mcp_servers` in that config.
  const mcpServers = readMcpServers();
  const serverNames = serverArg
    ? [serverArg]
    : Object.keys(mcpServers).filter((n) => mcpServers[n]?.enabled !== false);

  const outcomes: ExploreOutcome[] = [];
  for (const server of serverNames) {
    // Live tools/list off the real MCP connection. On failure: log + SKIP this
    // server — never silently fall back to history.
    const def = mcpServers[server];
    if (!def) {
      process.stderr.write(`  [${server}] not found in MCP config (mcp_servers) — skipping\n`);
      outcomes.push({ server, tools: [], target: targetArg ?? null, saved: false, proposed: 0, verified: 0, error: "server not in MCP config" });
      continue;
    }
    let liveTools: McpTool[];
    try {
      liveTools = liveToolsForServer(def);
      if (!liveTools.length) throw new Error("tools/list returned no tools");
    } catch (e) {
      process.stderr.write(`  [${server}] live tools/list failed — skipping (${(e as Error).message})\n`);
      outcomes.push({ server, tools: [], target: targetArg ?? null, saved: false, proposed: 0, verified: 0, error: `live tools/list failed: ${(e as Error).message}` });
      continue;
    }
    const tools = liveTools.map((t) => t.name);
    const target = targetArg ?? discoverTarget(config, server);

    // Experience identity: the explicit --experience name (the SITE, for a
    // browser MCP driving many sites) else the MCP server's own name. Prior
    // merges, the saved filename, and the playbook heading all key off it.
    const expName = experienceArg || server;
    const keyOf = (p: RecoveryPattern) => (p.trigger || p.action || "").toLowerCase();

    // ── Stage 1: PROPOSE (tree generation) ────────────────────────
    // ToolShield-style accumulation: hand the proposer the EXISTING experience
    // so it decides per op to UPDATE (re-emit same trigger, improved) or ADD a
    // new one — avoiding duplicate/overlapping patterns across re-explorations.
    const priorPatterns = loadExperiences(config, expName)?.patterns ?? [];
    const proposal = proposePatterns(server, liveTools, config, target, priorPatterns);
    if (!proposal.candidates.length) {
      outcomes.push({
        server, tools, target, saved: false, proposed: 0, verified: 0,
        error: proposal.proposalText ? "stage-1 produced no parseable proposals" : "stage-1 model runner failed",
      });
      continue;
    }

    // ── MERGE + SAVE (write-through) ──────────────────────────────
    // Union the given patterns into the ON-DISK prior (re-loaded every call,
    // so successive checkpoints merge into the file they just wrote — the
    // by-key overwrite makes this idempotent). Keyed by trigger (else action);
    // a new verified=true entry wins, a prior verified entry is preserved
    // against an unverified newcomer, and a key the verifier DELETED is
    // RETRACTED (keyOf MUST mirror verify.ts's). Rebuilds the playbook and
    // saves to BOTH sinks. No force-complete-coverage: the runtime defaults
    // to no-backup, so only explorer-flagged actions are covered.
    const mergeAndSave = (pats: RecoveryPattern[], dropped: string[]): { path: string; verified: number } => {
      const prior = loadExperiences(config, expName);
      const byKey = new Map<string, RecoveryPattern>();
      for (const p of prior?.patterns ?? []) byKey.set(keyOf(p), p);
      for (const k of dropped) byKey.delete(k);
      for (const p of pats) {
        const k = keyOf(p);
        const existing = byKey.get(k);
        if (existing && existing.verified === true && p.verified !== true) continue;
        byKey.set(k, p);
      }
      const mergedPatterns = [...byKey.values()];
      const mergedReadOnlyTools = [...new Set([...(prior?.readOnlyTools ?? []), ...proposal.readOnlyTools])];
      // appliesTo routing: a SITE-named experience routes to its driving server.
      const appliesTo = [...new Set([
        ...(prior?.appliesTo ?? []),
        ...(expName !== server ? [server] : []),
      ])];
      const data: ServerExperiences = {
        server: expName, generated: nowIso, observed_tools: tools, patterns: mergedPatterns,
        ...(mergedReadOnlyTools.length ? { readOnlyTools: mergedReadOnlyTools } : {}),
        ...(appliesTo.length ? { appliesTo } : {}),
        // PRESERVE learned fields this pipeline does not (re)produce.
        ...(prior?.noBackupPatterns?.length ? { noBackupPatterns: prior.noBackupPatterns } : {}),
      };
      const playbook = assemblePlaybook(expName, mergedPatterns);
      if (playbook) data.skill = playbook;
      const p = saveExperiences(config, data);  // runtime experiences dir (backup injection reads here)
      archiveResult(data);                      // + human-inspectable copy under self-exploration/results/
      return { path: p, verified: mergedPatterns.filter((x) => x.verified === true).length };
    };

    // ── Stage 2: VERIFY, checkpointing to disk after EVERY pattern ──
    // Nothing accumulates only in memory: a killed run keeps all completed
    // verifications, and a re-run resumes from the merged on-disk prior.
    let ckpt = 0;
    const { finalPatterns, droppedKeys, adjusted, harvested } = verifyAndAccumulate(
      server, def, proposal.candidates, liveTools, target, config,
      (pats, dropped) => {
        const saved = mergeAndSave(pats, dropped);
        ckpt++;
        process.stderr.write(`  [${server}] checkpoint ${ckpt}/${proposal.candidates.length}: ${saved.verified} verified so far → ${saved.path}\n`);
      },
    );

    // Final save — idempotent with the last checkpoint; also covers the
    // zero-candidate case where no checkpoint ever fired.
    const finalSave = mergeAndSave(finalPatterns, droppedKeys);
    if (adjusted || harvested) {
      process.stderr.write(`  [${server}] stage-2: ${adjusted} adjusted, ${harvested} harvested\n`);
    }
    outcomes.push({
      server, tools, target, saved: true, path: finalSave.path,
      proposed: proposal.candidates.length,
      verified: finalSave.verified,
    });
  }
  return outcomes;
}
