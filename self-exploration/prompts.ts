/**
 * All self-exploration prompts live here.
 *
 *   buildProposalPrompt        — STAGE 1 (tree_generation): a model enumerates
 *                                 the server's mutating ops and proposes the
 *                                 cheapest reversible "easy-win" for each.
 *   buildVerificationPrompt    — STAGE 2 (verify): a live agent executes each
 *                                 proposed reversal against the real backend.
 *   buildReadOnlyVerifyPrompt  — STAGE 2 (verify, read-only): confirm a set of
 *                                 candidate actions change nothing persistent.
 */

import type { McpTool } from "../dist/explore/list_mcp_tools.js";
import type { RecoveryPattern } from "../dist/explore/experiences.js";
import type { ReadOnlyTemplate } from "./types.js";
import { serverProfile } from "./server_profiles.js";

// ── Stage 1: PROPOSE — a model reasons about possible actions and
//    proposes candidate easy-win reversals. No execution. ───────────
export function buildProposalPrompt(server: string, tools: McpTool[]): string {
  const toolLines = tools.map((t) => {
    const desc = (t.description ?? "").replace(/\s+/g, " ").trim();
    // Surface key parameter names so the proposer reasons about the real
    // tool surface, not just the name.
    const props = (t.inputSchema && typeof t.inputSchema === "object")
      ? (t.inputSchema as { properties?: Record<string, unknown> }).properties
      : undefined;
    const params = props ? Object.keys(props).slice(0, 8).join(", ") : "";
    const descPart = desc ? ` — ${desc.slice(0, 300)}` : "";
    const paramPart = params ? ` (params: ${params})` : "";
    return `  - ${t.name}${descPart}${paramPart}`;
  }).join("\n");
  return `You are the Recovery Experience Curator for CHATS-Sandbox, a backup/restore system for autonomous agents.

An agent uses the "${server}" MCP server. Live tools (from the server's tools/list):
${toolLines}

CHATS-Sandbox must reverse destructive/mutating remote actions. The default is expensive: scrape the full remote state to local and recreate it on restore — costly and lossy (recreated entities get NEW ids/timestamps).

STAGE 1 — PROPOSE (reason only; do NOT execute anything)

FIRST, CLASSIFY each listed tool as exactly one of:
  - READ-ONLY: only reads/inspects/lists/searches/views; never creates, changes, or deletes anything → put its EXACT name in "read_only_tools".
  - MUTATING: every use changes/destroys persistent state (always backup-worthy).
  - MIXED: whether it mutates depends on its ARGUMENTS — e.g. a generic SQL/command runner where a SELECT only reads but an UPDATE/DELETE/DROP mutates. For a MIXED tool, derive TWO keyword sets from its arguments:
      * read-only keywords (e.g. select, explain, show, describe, list) → emit them in "no_backup_patterns" (these arg-shapes need NO backup). Do NOT emit generic SQL words that can wrap a write (e.g. "with" — a data-modifying CTE like WITH … UPDATE mutates).
      * backup-needed keywords (e.g. insert, update, delete, drop, truncate, alter, merge, replace) → emit ONE pattern PER keyword, using that keyword as its "trigger".

SECOND, ENUMERATE EXHAUSTIVELY by effect — cover EVERY operation this server exposes, ONE pattern per distinct mutating op; do NOT stop at an arbitrary count. Use THIS server's OWN domain vocabulary — the examples below are illustrative across domains (a database, a forum, a file store, an issue tracker, a cloud API), NOT a checklist; pick the words that actually appear in this server's tools. Group by effect so none is missed:
  - READ (e.g. get / list / view / search / a SQL SELECT / open a page): returns or displays data and commits NOTHING → NO pattern (any read keyword goes to no_backup_patterns). NOTE: merely navigating / scrolling / viewing is a READ (everything stays in place) — but an action that LOOKS like navigation yet submits or saves IS a mutation.
  - CREATE (e.g. create / add / insert / submit / post / upload): makes NEW persistent state → needs a pattern + trigger.
  - UPDATE (e.g. update / edit / rename / replace / vote): overwrites prior state → needs a pattern + trigger.
  - DELETE (e.g. delete / remove / drop / truncate): removes data → needs a pattern + trigger.
  - OTHER PERSISTENT SIDE-EFFECT (e.g. change permissions, subscribe, send, schema/config changes): a durable change that isn't a plain create/update/delete → needs a pattern + trigger ANYWAY (even if it cannot be safely verified live later — "unsafe to verify" does NOT mean "no trigger").
  Hybrids (an upsert / merge = create + update) → emit a trigger for BOTH shapes.

For every op in CREATE / UPDATE / DELETE / OTHER above (a MUTATING tool, or each backup-needed keyword of a MIXED tool), PROPOSE the cheapest reversible "EASY-WIN" — an in-place reversible state change or cheap capture that preserves the original entity.

Shape of what we want:
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

Cover ONE pattern per mutating op you enumerated above (every CREATE / UPDATE / DELETE / OTHER op — do NOT cap at a fixed count), the read-only arg keywords of any MIXED tool in no_backup_patterns, 5-12 read_only templates, and the read_only_tools subset of the listed tools.

CRITICAL OUTPUT FORMAT — respond with ONLY a single JSON object and NOTHING else: NO prose, NO explanation, NO reasoning, NO markdown, NO code fences. Emit the object EXACTLY ONCE — no duplicate copies — and stop IMMEDIATELY after the final }. Your ENTIRE response MUST begin with the character { and end with the character }. Keep it COMPACT so it is never truncated: each "easy_win" is ONE sentence (the verifier fills in details later). Use EXACTLY this shape:
{"patterns":[{"action":"<destructive op, short>","easy_win":"<cheap reversal + how, ONE sentence>","applies_to":"<tool>","trigger":"<short keyword>"}],"read_only":[{"match":"<keyword/affordance>","why":"<short>"}],"no_backup_patterns":["<read-only arg keyword of a MIXED tool, e.g. select>"],"read_only_tools":["<exact read-only tool name copied verbatim from the list above>"]}`;
}

// ── Stage 2: VERIFY — a live agent actually executes each proposed
//    reversal against the real target and reports what worked. ──────
export function buildVerificationPrompt(
  server: string,
  candidates: RecoveryPattern[],
  target: string | null,
  resultFile: string,
): string {
  const targetLine = target
    ? `TARGET (a disposable test system — safe to mutate): ${target}`
    : `No URL target was given — the "${server}" MCP operates on its own configured backend (e.g. a database). Use the MCP tools directly against that backend to test. Treat it as disposable: create/clean up throwaway items, don't touch real-looking production data.`;
  // Server-specific setup + safety come from the per-server profile, so this
  // prompt stays domain-general and each server sees ONLY its own info.
  const profile = serverProfile(server);
  const seedLine = profile.seed;
  const list = candidates.map(
    (c, i) => `  ${i + 1}. action: ${c.action}\n     proposed easy-win: ${c.easy_win}`,
  ).join("\n");
  return `You are the Recovery Verification agent for CHATS-Sandbox. You have LIVE access to the "${server}" MCP tools.

${targetLine}

${seedLine}

STAGE 2 — VERIFY & ACCUMULATE (actually execute)
Below are PROPOSED easy-win reversal patterns. For EACH one, actually TEST it with the MCP against the seeded sandbox:
  1. Note the original state (re-read the seeded item).
  2. Perform the destructive action on it.
  3. Perform the PROPOSED easy-win reversal.
  4. Confirm the original state is restored (re-read and compare).
  5. Clean up any extra throwaway items you created.

Give EACH pattern a verdict:
  - "keep": the proposed reversal actually worked (you saw the original state restored).
  - "adjust": the reversal is close but the exact command is wrong. Put the CORRECTED easy_win in "easy_win" and set verdict "adjust" — it will be re-tested. Use this when you know the right fix.
  - "delete": the action is NOT actually mutating, OR there is no working reversal (say why).
Set "verified"=true ONLY for a "keep" you actually executed and saw work. Do NOT invent success.

HARVEST: if while testing you discover (a) a CHEAPER or otherwise valid reversal for one of these ops, or (b) a MISSED mutating op on this server worth backing up, ADD it as an extra pattern object with "verdict":"keep" and a filled verify_note describing the live test you ran — only add ops you actually verified.

${profile.safety}

PROPOSED PATTERNS:
${list}

After testing, **WRITE your result as a JSON object to this EXACT file path** (use the bash tool or a write-file tool):

  ${resultFile}

This file is how CHATS-Sandbox reads your result — stdout is NOT reliably parsed. The JSON shape:

{"patterns":[{"action":"...","easy_win":"...","applies_to":"...","verdict":"keep|adjust|delete","verified":true,"verify_note":"<what you observed>"}]}

Echo every proposed pattern with a verdict, plus any harvested patterns. The LAST thing you do is write that file.`;
}

// ── Read-only verification: cheap because confirming "this changed
//    nothing" is just do-it-and-compare (no setup→destroy→reverse). One
//    batch run covers the whole candidate list. ──────────────────────
export function buildReadOnlyVerifyPrompt(
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
