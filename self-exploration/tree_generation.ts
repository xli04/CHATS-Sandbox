/**
 * STAGE 1 — tree generation (PROPOSE).
 *
 * A model reasons over the server's LIVE tool surface and proposes candidate
 * easy-win reversals (the "tree" of recovery experiences), plus the read-only
 * affordances and read-only tool names. No execution here — every proposal is
 * tested later in verify.ts. This file owns the stage-1 runner and all the
 * parsers that turn the model's JSON into typed candidates (hardened against
 * hallucinated tool names and mutating-verb read-only entries).
 */

import * as fs from "node:fs";
import type { SandboxConfig } from "../dist/types.js";
import type { McpTool } from "../dist/explore/list_mcp_tools.js";
import type { RecoveryPattern } from "../dist/explore/experiences.js";
import { extractJson, subagent } from "./infra.js";
import { buildProposalPrompt } from "./prompts.js";
import type { ReadOnlyTemplate, VerdictPattern } from "./types.js";

const { extractJsonObject } = extractJson;
const { runRunnerForText } = subagent;

// A read-only "match" must never carry a mutating verb — a wrong entry here
// silently drops a backup. This is the hard filter at parse time.
export const READONLY_BANNED = /\b(create|delete|remove|edit|update|submit|post|vote|send|publish|save|drop|ban|destroy|insert|write|add|reply|comment|subscribe|unsubscribe|upload|rename|move|merge|approve|reject)\b/i;

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
      if (typeof r.action === "string" && typeof r.easy_win === "string") {
        out.push({
          action: r.action,
          easy_win: r.easy_win,
          applies_to: typeof r.applies_to === "string" ? r.applies_to : undefined,
          trigger: typeof r.trigger === "string" ? r.trigger.trim().toLowerCase() : undefined,
          verified: typeof r.verified === "boolean" ? r.verified : undefined,
          verify_note: typeof r.verify_note === "string" ? r.verify_note : undefined,
          verdict: typeof r.verdict === "string" ? r.verdict.trim().toLowerCase() : undefined,
        } as RecoveryPattern & { verdict?: string });
      }
    }
  }
  return out.length ? out : null;
}

/** Extract read-only TEMPLATES ({match, why}) from a STAGE-1 proposal or a
 *  verify result. Conservative: drop anything with a mutating verb. */
export function parseReadOnly(raw: string): ReadOnlyTemplate[] {
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

/** Extract the MIXED-tool read-only ARG keywords ("no_backup_patterns") from a
 *  STAGE-1 proposal — e.g. select/explain/show for an execute_sql. These extend
 *  the no-backup keyword list (an action whose arg-shape matches commits nothing,
 *  so the gate can skip the backup). Drop any keyword carrying a mutating verb. */
export function parseNoBackupPatterns(raw: string): string[] {
  const obj = extractJsonObject<{ no_backup_patterns?: unknown }>(
    raw,
    (o) => !!o && typeof o === "object" && Array.isArray((o as { no_backup_patterns?: unknown }).no_backup_patterns),
  );
  const arr = obj && Array.isArray(obj.no_backup_patterns) ? obj.no_backup_patterns : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    const k = String(v ?? "").trim().toLowerCase();
    if (k.length < 3 || k.length > 60 || seen.has(k) || READONLY_BANNED.test(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** The parsed result of stage 1. */
export interface Proposal {
  candidates: VerdictPattern[];
  proposedReadOnly: ReadOnlyTemplate[];
  readOnlyTools: string[];
  mixedNoBackup: string[];
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
): Proposal {
  const tools = liveTools.map((t) => t.name);
  let proposalText: string | null = null;
  let candidates: VerdictPattern[] | null = null;
  for (let attempt = 0; attempt < 4 && (!candidates || !candidates.length); attempt++) {
    proposalText = runRunnerForText(buildProposalPrompt(server, liveTools), genConfig, 180);
    try { if (process.env.CHATS_EXPLORE_DEBUG) fs.writeFileSync(`/tmp/gen-debug-${server}-${attempt}.txt`, String(proposalText ?? "(null)")); } catch { /* ignore */ }
    candidates = proposalText ? parsePatterns(proposalText) : null;
    if (!candidates || !candidates.length) process.stderr.write(`  [${server}] stage-1 attempt ${attempt + 1} unparseable — retrying\n`);
  }
  return {
    candidates: candidates ?? [],
    proposedReadOnly: proposalText ? parseReadOnly(proposalText) : [],
    // Read-only TOOLS: the explorer's pick of which provided tools never mutate
    // (validated against the actual tool list — no hallucinated names).
    readOnlyTools: proposalText ? parseReadOnlyTools(proposalText, tools) : [],
    mixedNoBackup: proposalText ? parseNoBackupPatterns(proposalText) : [],
    proposalText,
  };
}
