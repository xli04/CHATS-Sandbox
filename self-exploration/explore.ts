/**
 * Self-exploration pipeline — extract "easy-win" reversal patterns per MCP
 * server and store them as recovery experiences.
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
 *                    actions and proposes candidate easy-win reversals.
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

    // ── Stage 1: PROPOSE (tree generation) ────────────────────────
    const proposal = proposePatterns(server, liveTools, config);
    if (!proposal.candidates.length) {
      outcomes.push({
        server, tools, target, saved: false, proposed: 0, verified: 0,
        error: proposal.proposalText ? "stage-1 produced no parseable proposals" : "stage-1 model runner failed",
      });
      continue;
    }

    // ── Stage 2: VERIFY & ACCUMULATE ──────────────────────────────
    const { finalPatterns, noBackupPatterns, adjusted, harvested } = verifyAndAccumulate(
      server, def, proposal.candidates, proposal.proposedReadOnly, proposal.mixedNoBackup,
      liveTools, target, config,
    );

    // ── ACCUMULATE: union the newly-verified patterns into any prior verified
    //    ones (don't blow away earlier hard-won verifications). Keyed by trigger
    //    (else action). A new verified=true entry wins; otherwise a prior
    //    verified entry is preserved. ──────────────────────────────────────
    const prior = loadExperiences(config, server);
    const byKey = new Map<string, RecoveryPattern>();
    const keyOf = (p: RecoveryPattern) => (p.trigger || p.action || "").toLowerCase();
    for (const p of prior?.patterns ?? []) byKey.set(keyOf(p), p);
    for (const p of finalPatterns) {
      const k = keyOf(p);
      const existing = byKey.get(k);
      // Keep a prior VERIFIED entry if the new one for the same key is unverified.
      if (existing && existing.verified === true && p.verified !== true) continue;
      byKey.set(k, p);
    }
    const mergedPatterns = [...byKey.values()];
    const mergedReadOnlyTools = [...new Set([...(prior?.readOnlyTools ?? []), ...proposal.readOnlyTools])];
    const mergedNoBackup = [...new Set([...(prior?.noBackupPatterns ?? []), ...noBackupPatterns])];

    const data: ServerExperiences = {
      server, generated: nowIso, observed_tools: tools, patterns: mergedPatterns,
      ...(mergedNoBackup.length ? { noBackupPatterns: mergedNoBackup } : {}),
      ...(mergedReadOnlyTools.length ? { readOnlyTools: mergedReadOnlyTools } : {}),
    };
    const p = saveExperiences(config, data);  // runtime experiences dir (backup injection reads here)
    archiveResult(data);                      // + human-inspectable copy under self-exploration/results/
    if (adjusted || harvested) {
      process.stderr.write(`  [${server}] stage-2: ${adjusted} adjusted, ${harvested} harvested\n`);
    }
    outcomes.push({
      server, tools, target, saved: true, path: p,
      proposed: proposal.candidates.length,
      verified: mergedPatterns.filter((x) => x.verified === true).length,
    });
  }
  return outcomes;
}
