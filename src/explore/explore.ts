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
import * as os from "node:os";
import type { SandboxConfig } from "../types.js";
import { extractJsonObject } from "../util/extract_json.js";
import {
  serverFromToolName,
  saveExperiences,
  experiencePath,
  type RecoveryPattern,
  type ServerExperiences,
} from "./experiences.js";
import { loadToolRegistry } from "./tool_registry.js";

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

These are PROPOSALS to be tested later, so be concrete about HOW to perform the reversal.

THE BACKUP-WORTHY TEST — the one rule for whether an action needs a backup: **would the action become IRREVERSIBLE if we do NOT capture state right before it?** Apply it to THIS server's tools, whatever the domain (files, database rows, tickets, cloud resources, messages, documents, …):
  - IRREVERSIBLE without capture → NEEDS a pattern + trigger. The general shapes: destroying data (the content is gone once removed), overwriting prior state (the previous value is lost on update/replace), or creating a resource (you need the new item's identifier to find and remove it on undo).
  - Trivially reversible LIVE without any capture → do NOT propose a pattern. The general shape: any action whose exact inverse is always available with no saved state — a toggle/flag you can flip back, a relationship/membership you can add then remove, a status you can switch and switch back.
For each IRREVERSIBLE action, give a "trigger": a SHORT lowercase keyword that appears in its tool name or the control's label — whatever a user/tool would actually call that mutation on THIS server. The backup system backs up remote actions matching a trigger and ignores the rest. Only propose patterns for genuinely irreversible-without-capture actions.

ALSO propose the READ-ONLY actions in this environment — things a user does that change NOTHING persistent, so they need no backup. The backup system keeps a READ-ONLY LIST and skips any action matching it for free; your job is to extend that list with this environment's specific affordances. Each entry is a TEMPLATE that drops straight into the list:
  - "match": a SHORT lowercase keyword/phrase that appears in the action's description or click label (e.g. "open submission", "sort by", "expand comments", "view profile"). This is what the gate substring-matches.
  - "why": one phrase on why it commits nothing (so a human can eyeball the list).
Do NOT list generic tool reads that start with get/list/view/search/navigate/snapshot — those are already covered by predefined patterns; focus on environment-SPECIFIC UI affordances the predefined list would miss. Be CONSERVATIVE: only actions you are confident commit nothing. NEVER include anything that creates, edits, deletes, votes, submits, subscribes, or sends — when unsure, leave it out (a wrong "read-only" = a lost backup). These will be VERIFIED next (performed live; kept only if nothing changed).

ALSO, from the EXACT tool list shown above, pick the tools that are READ-ONLY — they only read/inspect/list/search/view and never create, change, or delete anything. The runtime skips backups for these tools by name. Copy tool names VERBATIM from the list above into "read_only_tools"; do NOT invent, guess, or rename — only choose from the provided list, and NEVER include a tool that can mutate (when unsure, leave it out).

Output ONLY a JSON object (no fences, no commentary):

{"patterns":[{"action":"<destructive op>","easy_win":"<proposed cheap reversal AND exactly how to do it>","applies_to":"<tool/capability>","trigger":"<short keyword that identifies this mutation>"}],"read_only":[{"match":"<keyword/affordance>","why":"<why it commits nothing>"}],"read_only_tools":["<exact read-only tool name copied verbatim from the list above>"]}

Output 3-8 reversal proposals, 5-12 read_only templates, and the read_only_tools subset of the listed tools.`;
}

// ── Stage 2: VERIFY — a live agent actually executes each proposed
//    reversal against the real target and reports what worked. ──────
function buildVerificationPrompt(
  server: string,
  candidates: RecoveryPattern[],
  target: string | null,
  resultFile: string,
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

After testing, **WRITE your result as a JSON object to this EXACT file path** (use the bash tool or a write-file tool):

  ${resultFile}

This file is how CHATS-Sandbox reads your result — stdout is NOT reliably parsed. The JSON shape (echo each pattern with a verified flag and a one-line note):

{"patterns":[{"action":"...","easy_win":"...","applies_to":"...","verified":true,"verify_note":"<what you observed>"}]}

Set verified=true ONLY if you actually performed the reversal and saw it work; verified=false if it failed or the affordance doesn't exist (say why in verify_note). The LAST thing you do is write that file.`;
}

// ── Read-only verification: cheap because confirming "this changed
//    nothing" is just do-it-and-compare (no setup→destroy→reverse). One
//    batch run covers the whole candidate list. ──────────────────────
function buildReadOnlyVerifyPrompt(
  server: string,
  readOnly: ReadOnlyTemplate[],
  target: string | null,
  resultFile: string,
): string {
  const targetLine = target
    ? `TARGET (a disposable test system — safe to operate): ${target}`
    : `The "${server}" MCP operates on its own configured backend. Use the MCP tools directly; treat it as disposable.`;
  const list = readOnly.map((r, i) => `  ${i + 1}. "${r.match}"${r.why ? ` — ${r.why}` : ""}`).join("\n");
  return `You are the Read-Only Verification agent for CHATS-Sandbox. You have LIVE access to the "${server}" MCP tools.

${targetLine}

STAGE 2 (read-only) — CONFIRM each candidate action changes NOTHING persistent. This is cheap: do it and check nothing changed.
For EACH candidate below:
  1. Read/snapshot the small piece of state the action would plausibly touch.
  2. Perform the action ONCE through the real tools/UI.
  3. Re-read and compare. verified=true ONLY if nothing persistent changed (no vote registered, no field saved, no item created/edited). verified=false if anything changed OR the affordance doesn't exist.
Operate only on existing or throwaway items — never create real data just to test. Be strict: when in doubt, verified=false (a wrong read-only silently loses a backup).

CANDIDATES:
${list}

Write your result as JSON to this EXACT file path (stdout is not reliably parsed):

  ${resultFile}

{"read_only":[{"match":"<same keyword>","verified":true,"why":"<what you checked stayed unchanged>"}]}

Echo every candidate with its verified flag. The LAST thing you do is write that file.`;
}

function parsePatterns(raw: string): RecoveryPattern[] | null {
  // Pick the LAST balanced {...} object carrying a patterns[] — the final
  // verdict, not an earlier echoed proposal. A greedy first-`{`-to-last-`}`
  // match merges the two and fails to parse (dropping the verified flag).
  const obj = extractJsonObject<{ patterns?: unknown }>(
    raw,
    (o) => !!o && typeof o === "object" && Array.isArray((o as { patterns?: unknown }).patterns),
  );
  if (!obj || !Array.isArray(obj.patterns)) return null;
  const out: RecoveryPattern[] = [];
  for (const p of obj.patterns) {
    if (p && typeof p === "object") {
      const r = p as Record<string, unknown>;
      if (typeof r.action === "string" && typeof r.easy_win === "string") {
        out.push({
          action: r.action,
          easy_win: r.easy_win,
          applies_to: typeof r.applies_to === "string" ? r.applies_to : undefined,
          trigger: typeof r.trigger === "string" ? r.trigger.trim().toLowerCase() : undefined,
          verified: typeof r.verified === "boolean" ? r.verified : undefined,
          verify_note: typeof r.verify_note === "string" ? r.verify_note : undefined,
        });
      }
    }
  }
  return out.length ? out : null;
}

/** A proposed/verified read-only affordance for the read-only list. */
export interface ReadOnlyTemplate {
  /** The keyword/phrase the gate substring-matches in an action's label. */
  match: string;
  /** Why it commits nothing (human-eyeball + verify note). */
  why?: string;
  /** Did the live verify pass confirm it changed nothing? */
  verified?: boolean;
}

// A read-only "match" must never carry a mutating verb — a wrong entry here
// silently drops a backup. This is the hard filter at parse time.
const READONLY_BANNED = /\b(create|delete|remove|edit|update|submit|post|vote|send|publish|save|drop|ban|destroy|insert|write|add|reply|comment|subscribe|unsubscribe|upload|rename|move|merge|approve|reject)\b/i;

/** Extract the read-only TOOL NAMES from a STAGE-1 proposal. Hardened against
 *  hallucination: an entry is kept ONLY if it is one of the tools we actually
 *  provided (`tools`, case-insensitive) AND its name carries no mutating verb.
 *  These extend the runtime read-only-tool skip-list (matched by tool name). */
function parseReadOnlyTools(raw: string, tools: string[]): string[] {
  const obj = extractJsonObject<{ read_only_tools?: unknown }>(
    raw,
    (o) => !!o && typeof o === "object" && Array.isArray((o as { read_only_tools?: unknown }).read_only_tools),
  );
  const arr = obj && Array.isArray(obj.read_only_tools) ? obj.read_only_tools : [];
  const allowed = new Set(tools.map((t) => t.toLowerCase()));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    const name = String(v ?? "").trim();
    const lc = name.toLowerCase();
    if (!lc || seen.has(lc)) continue;
    if (!allowed.has(lc)) continue;          // must be a tool we provided — no hallucinated names
    if (READONLY_BANNED.test(lc)) continue;  // never a mutating-named tool
    seen.add(lc);
    out.push(name);
  }
  return out;
}

/** Extract read-only TEMPLATES ({match, why}) from a STAGE-1 proposal or a
 *  verify result. Conservative: drop anything with a mutating verb. */
function parseReadOnly(raw: string): ReadOnlyTemplate[] {
  const obj = extractJsonObject<{ read_only?: unknown }>(
    raw,
    (o) => !!o && typeof o === "object" && Array.isArray((o as { read_only?: unknown }).read_only),
  );
  const arr = obj && Array.isArray(obj.read_only) ? obj.read_only : [];
  const out: ReadOnlyTemplate[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    const o: Record<string, unknown> = (v && typeof v === "object") ? v as Record<string, unknown> : { match: v };
    const match = String(o.match ?? "").trim().toLowerCase();
    if (match.length < 3 || match.length > 60 || READONLY_BANNED.test(match) || seen.has(match)) continue;
    seen.add(match);
    out.push({
      match,
      why: typeof o.why === "string" ? o.why : undefined,
      verified: typeof o.verified === "boolean" ? o.verified : undefined,
    });
    if (out.length >= 30) break;
  }
  return out;
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
  genModel?: string,
  verifyModel?: string,
): ExploreOutcome[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runRunnerForText } = require("../backup/subagent.js");

  // Per-stage model overrides (e.g. Opus to propose, Haiku to verify).
  const withModel = (m?: string): SandboxConfig =>
    m ? { ...config, subagentHermesModel: m } : config;
  const genConfig = withModel(genModel);
  const verifyConfig = withModel(verifyModel);

  const discovered = discoverServers(config);
  let servers: Array<[string, string[]]>;
  if (serverArg) {
    // COLD-START: prefer the server's tools observed in backup history, but
    // fall back to the committed/default tool registry (tools/list) when the
    // server has never been used. This decouples exploration from prior
    // activity — a freshly-injected server can be explored from its schema +
    // target (ToolShield-style), no need to exercise the tool first to seed
    // history. (The registry carries tool NAMES; richer per-tool descriptions
    // via a live tools/list would need an async path — a follow-up.)
    const fromHistory = discovered.get(serverArg);
    let toolList = fromHistory ? [...fromHistory] : [];
    if (!toolList.length) {
      const reg = loadToolRegistry(config);
      toolList = reg[serverArg] ?? [];
    }
    servers = [[serverArg, toolList]];
  } else {
    servers = [...discovered.entries()].map(([s, t]) => [s, [...t]] as [string, string[]]);
  }

  const outcomes: ExploreOutcome[] = [];
  for (const [server, tools] of servers) {
    const target = targetArg ?? discoverTarget(config, server);

    // ── Stage 1: propose (reasoning) ──────────────────────────────
    // Stage-1 output is occasionally unparseable (the model sometimes wraps
    // the JSON in extra prose / emits a malformed object). Retry a few times
    // rather than abandoning the whole server on one bad generation.
    let proposalText: string | null = null;
    let candidates: RecoveryPattern[] | null = null;
    for (let attempt = 0; attempt < 4 && (!candidates || !candidates.length); attempt++) {
      proposalText = runRunnerForText(buildProposalPrompt(server, tools), genConfig, 180);
      try { if (process.env.CHATS_EXPLORE_DEBUG) fs.writeFileSync(`/tmp/gen-debug-${server}-${attempt}.txt`, String(proposalText ?? "(null)")); } catch { /* ignore */ }
      candidates = proposalText ? parsePatterns(proposalText) : null;
      if (!candidates || !candidates.length) process.stderr.write(`  [${server}] stage-1 attempt ${attempt + 1} unparseable — retrying\n`);
    }
    const proposedReadOnly = proposalText ? parseReadOnly(proposalText) : [];
    // Read-only TOOLS: the explorer's pick of which provided tools never mutate
    // (validated against the actual tool list — no hallucinated names).
    const readOnlyTools = proposalText ? parseReadOnlyTools(proposalText, tools) : [];
    if (!candidates || !candidates.length) {
      outcomes.push({
        server, tools, target, saved: false, proposed: 0, verified: 0,
        error: proposalText ? "stage-1 produced no parseable proposals" : "stage-1 model runner failed",
      });
      continue;
    }

    // ── Stage 2: verify (execution), ONE PATTERN PER RUN ──────────
    // Each pattern gets its own agent run + full budget to set up →
    // destruct → reverse → confirm → emit. Batching all patterns into a
    // single run never finished (the agent ran out of turns mid-marathon
    // and emitted no verified flags). One-by-one fixes that.
    const finalPatterns: RecoveryPattern[] = [];
    let idx = 0;
    for (const cand of candidates) {
      // Each verify writes its verdict to a FILE — read from disk (immune
      // to hermes' TUI-decorated stdout, which was dropping the `verified`
      // flag). Fall back to stdout parsing if no file appears.
      const resultFile = path.join(os.tmpdir(), `chats-verify-${process.pid}-${idx++}.json`);
      try { fs.rmSync(resultFile, { force: true }); } catch { /* ignore */ }
      const verifyText = runRunnerForText(
        buildVerificationPrompt(server, [cand], target, resultFile), verifyConfig, 600,
      );
      let parsed: RecoveryPattern[] | null = null;
      try {
        if (fs.existsSync(resultFile)) parsed = parsePatterns(fs.readFileSync(resultFile, "utf-8"));
      } catch { /* ignore */ }
      if (!parsed) parsed = verifyText ? parsePatterns(verifyText) : null;
      try { fs.rmSync(resultFile, { force: true }); } catch { /* ignore */ }
      // Preserve the Stage-1 `trigger`: the verify prompt's schema omits it,
      // so parsed[0].trigger is undefined and a blind spread would clobber the
      // candidate's trigger → the learned backup-worthy allowlist silently
      // empties (aggregateBackupTriggerRegex returns null). Keep cand.trigger
      // unless the verifier explicitly supplied a (non-empty) one.
      finalPatterns.push(
        parsed && parsed.length
          ? { ...cand, ...parsed[0], trigger: parsed[0].trigger || cand.trigger }
          : cand,
      );
    }

    // ── Read-only verify (ONE batch run — confirming "nothing changed" is
    //    cheap, so all candidates go in a single agent pass) ──────────
    let noBackupPatterns: string[] = [];
    if (proposedReadOnly.length) {
      const rf = path.join(os.tmpdir(), `chats-ro-verify-${process.pid}.json`);
      try { fs.rmSync(rf, { force: true }); } catch { /* ignore */ }
      const vtext = runRunnerForText(
        buildReadOnlyVerifyPrompt(server, proposedReadOnly, target, rf), verifyConfig, 600,
      );
      let verified: ReadOnlyTemplate[] = [];
      try { if (fs.existsSync(rf)) verified = parseReadOnly(fs.readFileSync(rf, "utf-8")); } catch { /* ignore */ }
      if (!verified.length && vtext) verified = parseReadOnly(vtext);
      try { fs.rmSync(rf, { force: true }); } catch { /* ignore */ }
      // Keep ONLY entries the live pass confirmed unchanged. A flaky/failed
      // verify yields an empty list rather than admitting unverified guesses.
      noBackupPatterns = verified.filter((r) => r.verified === true).map((r) => r.match);
    }

    const data: ServerExperiences = {
      server, generated: nowIso, observed_tools: tools, patterns: finalPatterns,
      ...(noBackupPatterns.length ? { noBackupPatterns } : {}),
      ...(readOnlyTools.length ? { readOnlyTools } : {}),
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
