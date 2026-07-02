/**
 * STAGE 1 — tree generation (PROPOSE).
 *
 * A model reasons over the server's LIVE tool surface and proposes, per
 * backup-worthy action, a deterministic reverter (creation-only) or a backup
 * SKILL + capture_tools, plus the read-only tool names. No execution here —
 * every proposal is tested later in verify.ts. This file owns the stage-1
 * runner and the parsers that turn the model's JSON into typed candidates
 * (hardened against hallucinated tool names).
 */

import * as fs from "node:fs";
import type { SandboxConfig } from "../dist/types.js";
import type { McpTool } from "../dist/explore/list_mcp_tools.js";
import type { RecoveryPattern } from "../dist/explore/experiences.js";
import { extractJson, subagent } from "./infra.js";
import { buildProposalPrompt } from "./prompts.js";
import type { VerdictPattern } from "./types.js";

const { extractJsonObject } = extractJson;
const { runRunnerForText } = subagent;

// A read-only "match" must never carry a mutating verb — a wrong entry here
// silently drops a backup. This is the hard filter at parse time.
export const READONLY_BANNED = /\b(create|delete|remove|edit|update|submit|post|vote|send|publish|save|drop|ban|destroy|insert|write|add|reply|comment|subscribe|unsubscribe|upload|rename|move|merge|approve|reject)\b/i;

/** Parse the OPTIONAL `capture_tools` — the learned minimal backup toolset
 *  (read + inverse). Keep string entries only, dedupe, cap at 5. Returns
 *  undefined when absent/empty so the runtime falls back to its heuristic. */
function parseCaptureTools(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of v) {
    const name = typeof e === "string" ? e.trim() : "";
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= 5) break;
  }
  return out.length ? out : undefined;
}

/** Parse the OPTIONAL `reverter` — the DETERMINISTIC inverse of a CREATE
 *  (delete exactly the created entity, pinned by a stable identifier). Mirrors
 *  parseCaptureTools' defensive style: validate shapes, drop garbage, and return
 *  undefined when absent or malformed. We do NOT re-derive whether the pattern
 *  is a create here — the EXPLORER self-identifies that at the tool level and
 *  emits a `reverter` ONLY for a create (the proposal prompt classifies each
 *  tool and forbids a reverter on edit/update/delete). Keyword-sniffing the
 *  action prose was both redundant and wrong (it misread nouns like "a post").
 *  We only shape-check: a `pin` (the identifier to pin at create time) and
 *  exactly ONE non-empty inverse (commands OR mcp_calls). SAFETY: the pin is a
 *  stable-identifier name (the prompt forbids positional pins) and the runtime
 *  additionally guards any shell command via isDangerousRecoveryCommand. */
function parseReverter(
  v: unknown,
): RecoveryPattern["reverter"] | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const pin = typeof o.pin === "string" ? o.pin.trim() : "";
  if (!pin) return undefined;                                     // no identifier to pin → unusable

  // commands: keep non-empty string entries, cap a few.
  let commands: string[] | undefined;
  if (Array.isArray(o.commands)) {
    const cmds: string[] = [];
    for (const c of o.commands) {
      const s = typeof c === "string" ? c.trim() : "";
      if (s) cmds.push(s);
      if (cmds.length >= 5) break;
    }
    if (cmds.length) commands = cmds;
  }

  // mcp_calls: keep entries with a string tool + plain-object args, cap a few.
  let mcpCalls: { tool: string; args: Record<string, unknown> }[] | undefined;
  if (Array.isArray(o.mcp_calls)) {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    for (const e of o.mcp_calls) {
      if (!e || typeof e !== "object" || Array.isArray(e)) continue;
      const c = e as Record<string, unknown>;
      const tool = typeof c.tool === "string" ? c.tool.trim() : "";
      if (!tool) continue;
      const args = (c.args && typeof c.args === "object" && !Array.isArray(c.args))
        ? (c.args as Record<string, unknown>) : {};
      calls.push({ tool, args });
      if (calls.length >= 5) break;
    }
    if (calls.length) mcpCalls = calls;
  }

  // action_rewrite: reversal replaces the destructive action with a reversible
  // soft form (e.g. delete -> move-to-trash) rather than running at restore.
  const ar = o.action_rewrite === true ? { action_rewrite: true } : {};

  // Exactly ONE inverse — no inverse is unusable; prefer mcp_calls when both
  // were emitted (a fixed MCP call is safer than free-form prose).
  if (!commands && !mcpCalls) return undefined;
  if (mcpCalls) return { mcp_calls: mcpCalls, pin, ...ar };
  return { commands, pin, ...ar };
}

/** Parse the patterns[] out of a stage-1 proposal OR a stage-2 verify result.
 *  Picks the LAST balanced {...} object carrying a patterns[] — the final
 *  verdict, not an earlier echoed proposal. A greedy first-`{`-to-last-`}`
 *  match merges the two and fails to parse (dropping the verified flag). */
export function parsePatterns(raw: string): VerdictPattern[] | null {
  const obj = extractJsonObject<{ patterns?: unknown }>(
    raw,
    (o) => !!o && typeof o === "object" && Array.isArray((o as { patterns?: unknown }).patterns),
  );
  if (!obj || !Array.isArray(obj.patterns)) return null;
  const out: VerdictPattern[] = [];
  for (const p of obj.patterns) {
    if (p && typeof p === "object") {
      const r = p as Record<string, unknown>;
      // Accept the canonical `skill` field; tolerate a legacy `easy_win` key
      // from older generations so a stale proposal still parses.
      const skill = typeof r.skill === "string" ? r.skill
        : (typeof r.easy_win === "string" ? r.easy_win : undefined);
      // OPTIONAL deterministic create-inverse — the explorer attaches it ONLY
      // to creation-only ops, which carry NO skill (the reverter IS their
      // backup). So a pattern is valid with a skill OR a parsed reverter.
      const reverter = parseReverter(r.reverter);
      if (typeof r.action === "string" && (typeof skill === "string" || reverter)) {
        out.push({
          action: r.action,
          ...(typeof skill === "string" ? { skill } : {}),
          // OPTIONAL verified concrete reversal recipe (reference example).
          ...(typeof r.recipe === "string" && r.recipe.trim() ? { recipe: r.recipe.trim().slice(0, 800) } : {}),
          applies_to: typeof r.applies_to === "string" ? r.applies_to : undefined,
          trigger: typeof r.trigger === "string" ? r.trigger.trim().toLowerCase() : undefined,
          verified: typeof r.verified === "boolean" ? r.verified : undefined,
          verify_note: typeof r.verify_note === "string" ? r.verify_note : undefined,
          // OPTIONAL learned minimal backup toolset (read + restore), capped 5.
          capture_tools: parseCaptureTools(r.capture_tools),
          reverter,
          verdict: typeof r.verdict === "string" ? r.verdict.trim().toLowerCase() : undefined,
        } as RecoveryPattern & { verdict?: string });
      }
    }
  }
  return out.length ? out : null;
}

/** Extract the read-only TOOL NAMES from a STAGE-1 proposal. Hardened against
 *  hallucination: an entry is kept ONLY if it is one of the tools we actually
 *  provided (`tools`, case-insensitive) AND its name carries no mutating verb.
 *  These extend the runtime read-only-tool skip-list (matched by tool name). */
export function parseReadOnlyTools(raw: string, tools: string[]): string[] {
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

/** The parsed result of stage 1. */
export interface Proposal {
  candidates: VerdictPattern[];
  readOnlyTools: string[];
  /** Raw text of the (last) generation, or null if the runner failed. */
  proposalText: string | null;
}

/**
 * Run STAGE 1 for one server. Stage-1 output is occasionally unparseable (the
 * model sometimes wraps the JSON in extra prose / emits a malformed object), so
 * retry a few times rather than abandoning the whole server on one bad gen.
 */
export function proposePatterns(
  server: string,
  liveTools: McpTool[],
  genConfig: SandboxConfig,
  target?: string | null,
  prior?: RecoveryPattern[],
): Proposal {
  const tools = liveTools.map((t) => t.name);
  let proposalText: string | null = null;
  let candidates: VerdictPattern[] | null = null;
  for (let attempt = 0; attempt < 4 && (!candidates || !candidates.length); attempt++) {
    proposalText = runRunnerForText(buildProposalPrompt(server, liveTools, target, prior), genConfig, 180);
    try { if (process.env.CHATS_EXPLORE_DEBUG) fs.writeFileSync(`/tmp/gen-debug-${server}-${attempt}.txt`, String(proposalText ?? "(null)")); } catch { /* ignore */ }
    candidates = proposalText ? parsePatterns(proposalText) : null;
    if (!candidates || !candidates.length) process.stderr.write(`  [${server}] stage-1 attempt ${attempt + 1} unparseable — retrying\n`);
  }
  return {
    candidates: candidates ?? [],
    // Read-only TOOLS: the explorer's pick of which provided tools never mutate
    // (validated against the actual tool list — no hallucinated names).
    readOnlyTools: proposalText ? parseReadOnlyTools(proposalText, tools) : [],
    proposalText,
  };
}
