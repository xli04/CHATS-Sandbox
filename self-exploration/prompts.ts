/**
 * All self-exploration prompts live here.
 *
 *   buildProposalPrompt      — STAGE 1 (tree_generation): a model sorts the
 *                               server's tools into certain read-only tools,
 *                               certain creation-only methods (deterministic
 *                               reverter), and everything-else (reason about
 *                               capabilities, flag the backup-worthy actions).
 *   buildVerificationPrompt  — STAGE 2 (verify): a live agent executes each
 *                               proposed reverter / skill against the real
 *                               backend, tunes the trigger keyword, and fixes
 *                               the skill / capture_tools.
 */

import type { McpTool } from "../dist/explore/list_mcp_tools.js";
import type { RecoveryPattern } from "../dist/explore/experiences.js";
import { serverProfile } from "./server_profiles.js";

// ── Stage 1: PROPOSE — a model reasons about the tools and proposes, per
//    backup-worthy action, the reverter (creation-only) or the skill +
//    capture_tools (everything else). No execution. ────────────────────
export function buildProposalPrompt(
  server: string,
  tools: McpTool[],
  target?: string | null,
  prior?: RecoveryPattern[],
): string {
  // ToolShield-style accumulation: show the model what's ALREADY known so it
  // decides per op to UPDATE an existing pattern (re-emit the same trigger with
  // a better skill/reverter) or ADD a genuinely new one — instead of blindly
  // re-proposing duplicates or overlapping generic + site patterns.
  const priorBlock = (prior && prior.length) ? `
ALREADY-KNOWN patterns for this server (from prior exploration — treat as the current experience):
${prior.map((p) => {
    const how = p.reverter ? `reverter(pin=${p.reverter.pin})` : (p.skill ? p.skill.slice(0, 120) : "(none)");
    return `  - trigger="${p.trigger ?? "?"}" applies_to="${p.applies_to ?? "?"}" : ${how}`;
  }).join("\n")}
DECIDE per op: if one of the above already covers it, RE-EMIT that pattern (SAME "trigger") with any IMPROVEMENT (a cheaper/clearer skill, a fixed reverter) — this UPDATES it. Only ADD a pattern for an op NOT already covered. Do NOT emit a near-duplicate of an existing trigger.
` : "";
  return _buildProposalPromptBody(server, tools, target, priorBlock);
}

function _buildProposalPromptBody(server: string, tools: McpTool[], target: string | undefined | null, priorBlock: string): string {
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

CHATS-Sandbox reverses out-of-workspace mutations. It **defaults to NO backup** — an action is backed up ONLY if you flag it below. So you never enumerate the "safe" actions; you only name the ones that genuinely need reversing.
${target ? `
**A TARGET SITE is driven through this server's tools: ${target}**
**The unit of enumeration is the SITE ACTION (affordance), NOT the tool.** Generic browser tools (click / fill / type / navigate) are only the vehicle — the SAME click can submit a post, delete a comment, or cast a vote, and each needs a DIFFERENT reversal. So:
  - Enumerate the mutating AFFORDANCES this kind of site exposes (create a post/submission, comment/reply, edit content, delete content, vote, subscribe, change profile/bio, moderate, ...) and emit **one pattern per affordance**.
  - **"trigger"** = a short lowercase keyword from the affordance's UI LABEL (e.g. "submit", "delete", "upvote", "biography") — the runtime matches it against the CLICKED ELEMENT's text, not just the tool name.
  - **"applies_to"** = the driving tool (browser_click, browser_fill_form, ...).
  - A **creation-only affordance** (submitting a brand-new post / comment) belongs in bucket 2: give it a "reverter" pinned by the typed content ("title" for a post, the full text for a comment), with the delete as prose "commands" (the runtime fills the pin from what the agent typed).
  ALSO still emit the generic TOOL-level capture recipes (evaluate / type / fill / upload ...) as additional patterns — both layers are useful; the site affordances are the PRIMARY output.
` : ""}${priorBlock}
STAGE 1 — PROPOSE (reason only; do NOT execute anything)

Sort the tools into three buckets:

**1. Certain read-only tools -> "read_only_tools".** List a tool here ONLY if you are **100% sure** it can NEVER create, change, or delete anything (it only reads / lists / searches / views). Copy the name VERBATIM from the list above. When unsure, leave it out.

**2. Certain creation-only methods -> a "reverter".** A method that ONLY ever creates a brand-new entity and can NEVER update or replace an existing one has an unconditional inverse: **delete exactly the entity it just created**. For each such method, emit a pattern carrying a **"reverter"** (shape below) so the runtime undoes it deterministically, with NO backup agent. Only when you are **100% sure** it is creation-only — an upsert / merge / replace can touch existing state, so it is NOT creation-only and gets no reverter.

**3. Everything else -> a capture "skill".** For the remaining backup-worthy actions (update / edit / overwrite / **delete** / durable side effect), the reversal is CAPTURE-then-RESTORE: read the affected state BEFORE the action, let the action run untouched, restore AFTER. Actions that only read or move the view — open a page, scroll, sort, **switch page**, view a profile — change nothing and need NO pattern (default no-backup). **MIXED tools:** if a SINGLE tool mutates only for certain verbs/args (a SQL runner where SELECT reads but UPDATE/DELETE/DROP write; a code executor), emit **ONE pattern PER mutating verb** — "trigger" = that verb keyword (insert/update/delete/drop/truncate/alter), NEVER the tool name — so read verbs (select/explain) match no trigger and are skipped by default. For each backup-worthy action emit a pattern with:
   - **"trigger"**: a SHORT lowercase keyword that appears in the tool name or the control's label (for a MIXED tool, the MUTATING VERB) — what this mutation is actually called on THIS server. The runtime matches remote actions against triggers.
   - **"skill"**: your HYPOTHESIS for the cheapest CAPTURE-restore, ONE sentence — read the prior state, restore it after. Shapes: overwrite/edit -> read the current content first, restore it after; update a field/row -> read (SELECT) the old value first, write it back; delete -> read the entity's full content/rows first, recreate on restore (say so if lossy: new id). Avoid the expensive scrape-and-recreate unless nothing cheaper is plausible. **Cheapest also means FEWEST TOOL CALLS**: prefer the one-call read form (e.g. one code-execution / SQL call).
   - **"capture_tools"**: the MINIMAL set (**2 to 5**, verbatim tool names from the list above) a backup step needs to (a) **READ** the affected entity's current value and (b) **RESTORE** it — normally two, the read tool then the write/inverse tool, e.g. ["read_text_file","write_file"] or ["get_page","update_page"].

The **"reverter"** shape (bucket 2 only):
   - **"pin"**: the STABLE identifier to target the created entity by — its "id" if one is returned, else a UNIQUE input attribute (an exact "title" / "name" / "key" the caller supplies). This is the value the runtime fills in to aim the delete.
   - the inverse, EXACTLY ONE of:
       * **"mcp_calls"** (PREFERRED): a fixed delete call on THIS server, e.g. [{"tool":"delete_submission","args":{"id":"<captured id>"}}] — "<...>" is the placeholder the runtime fills; copy the tool name VERBATIM from the list above.
       * **"commands"**: a prose inverse when no single MCP delete fits, e.g. ["delete the submission whose title == '<title>'"].
   SAFETY — the reverter deletes ONLY the just-created entity, pinned by that captured identifier. NEVER pin by position or recency ("the latest", "the most recent", "the first") — that deletes the WRONG entity.
   A creation-only pattern STILL needs a "trigger" (and "applies_to") so the runtime can match it; it needs no "skill" / "capture_tools" — the reverter IS its backup.

CRITICAL OUTPUT FORMAT — respond with ONLY a single JSON object and NOTHING else: NO prose, NO explanation, NO markdown, NO code fences. Emit it EXACTLY ONCE and stop immediately after the final }. Your ENTIRE response MUST begin with { and end with }. Keep it COMPACT (each "skill" is ONE sentence — the verifier fills in details later). Use EXACTLY this shape:
{"read_only_tools":["<verbatim read-only tool name>"],"patterns":[{"action":"<update/edit/delete/side-effect op>","trigger":"<short keyword or MIXED verb>","applies_to":"<tool>","skill":"<cheapest capture-restore, ONE sentence>","capture_tools":["<read tool>","<write/inverse tool>"]},{"action":"<creation-only op>","trigger":"<short keyword>","applies_to":"<tool>","reverter":{"pin":"<id|title>","mcp_calls":[{"tool":"<delete tool>","args":{"id":"<captured>"}}]}}]}
Per pattern, "skill"+"capture_tools" and "reverter" are MUTUALLY EXCLUSIVE — never both. Use "reverter" ONLY for a **creation-only** op (delete-the-created); use "skill"+"capture_tools" for update/edit/delete/side-effect. EVERY pattern has "action" + "trigger" + "applies_to".`;
}

// ── Stage 2: VERIFY — a live agent actually executes each proposed reverter
//    or skill against the real target, tunes the trigger, and fixes the
//    skill / capture_tools. ─────────────────────────────────────────────
export function buildVerificationPrompt(
  server: string,
  candidates: RecoveryPattern[],
  target: string | null,
  resultFile: string,
): string {
  const targetLine = target
    ? `TARGET (a disposable test system — safe to mutate): ${target}`
    : `No URL target was given — the "${server}" MCP operates on its own configured backend (e.g. a database or file store). Use the MCP tools directly against that backend to test. Treat it as disposable: create/clean up throwaway items, do not touch real-looking production data.`;
  // Server-specific setup + safety come from the per-server profile, so this
  // prompt stays domain-general and each server sees ONLY its own info.
  const profile = serverProfile(server);
  const seedLine = profile.seed;
  const list = candidates.map((c, i) => {
    let entry = `  ${i + 1}. action: ${c.action}  [trigger: ${c.trigger ?? "?"}, applies_to: ${c.applies_to ?? "?"}]`;
    if (c.reverter) {
      entry += `\n     proposed reverter (creation-only): ${JSON.stringify(c.reverter)}`;
    } else {
      entry += `\n     proposed skill: ${c.skill}`;
      if (c.capture_tools?.length) entry += `\n     proposed capture_tools: ${JSON.stringify(c.capture_tools)}`;
    }
    return entry;
  }).join("\n");
  return `You are the Recovery Verification agent for CHATS-Sandbox. You have LIVE access to the "${server}" MCP tools.

${targetLine}

${seedLine}

STAGE 2 — VERIFY & TUNE (actually execute against the seeded sandbox)
Below are PROPOSED backup patterns. For EACH one, test it live and return a verdict, correcting whatever is wrong.

**If the pattern has a "reverter" (a creation-only op):** verify the deterministic inverse actually works —
  1. Perform the create, noting the EXACT args you passed.
  2. Run the reverter's delete against the pinned identifier.
  3. Confirm the created entity is GONE (re-read). If the delete tool or args are wrong, CORRECT them and set verdict "adjust".

**Otherwise (a mutating op):** the proposed "skill" is a HYPOTHESIS — it may name an affordance that does not exist on this server. Test it and REWRITE it as the verified branch:
  1. Re-read the seeded item (its original state).
  2. **Try the hypothesis first** — does the proposed cheap reversal actually exist here (a private/hide/archive toggle, version history, a trash/restore pair, ...)?
     - **EXISTS and faithfully reverses** (you performed it, reversed it, and the original entity came back with id and content intact): rewrite "skill" as CONCRETE guidance — **which tool/action, how to perform it, how to reverse it**, ending with "capture nothing". Set "capture_tools" to the tools this branch actually uses.
     - **DOES NOT EXIST, or does not faithfully reverse**: rewrite "skill" as the CAPTURE recipe bound to this server — **which fields to capture (id, title, body, ...) with which read tool (one call)**, and how the restore recreates/restores from that capture; say so explicitly when a recreate is lossy (new id). Then verify THIS branch end to end: capture pre-state with the read tool, perform the destructive action, restore from the capture, confirm the original state is back.
  3. **MINIMIZE the call count.** The runtime backup agent has a hard budget of about 3 tool calls, so the recipe you record must be the **fewest-calls form you actually executed successfully**: if the same move can be done in ONE call (e.g. a single code-execution / SQL call) instead of several UI steps, TEST the one-call form and record THAT one. State the exact call sequence in "skill" (which tool, doing what) so the backup agent can follow it verbatim without exploring.
  4. Emit the MINIMAL "capture_tools" (**2-5, verbatim tool names**) the VERIFIED branch actually uses.
  The "skill" you emit must be the **verified branch guidance**, never the untested hypothesis.

**TUNE the "trigger".** The proposed keyword may not match how the mutation really appears — correct it to a short lowercase keyword that truly identifies this action. If a proposed pattern turns out NOT to mutate or is not worth backing up, set verdict **"delete"** (it will be DROPPED — the no-backup default then covers it). If while testing you find a **MISSED** mutating op worth backing up, ADD it as an extra pattern (verdict "keep", verified, with a filled verify_note) — this is how missing pieces get added.

Verdicts:
  - **"keep"**: the branch you are emitting was EXECUTED and SEEN to work (this includes a rewritten skill — hypothesis confirmed, or capture fallback verified end to end). Rewriting the skill to what you verified does NOT make it an "adjust".
  - **"adjust"**: you corrected something (trigger / skill / capture_tools / reverter) but could NOT verify the corrected version live — it will be re-tested.
  - **"delete"**: not mutating, or no working reversal exists — dropped.
Set "verified"=true ONLY for a "keep" you actually executed and saw work. Do NOT invent success.

**RECORD the "recipe"** for every "keep": the EXACT tool call(s) / command(s) you ACTUALLY RAN to reverse the action, verbatim, in order — but replace the specific captured values (ids, titles, original field text) with **<PLACEHOLDER>** tokens so it generalizes. This is stored as a VERIFIED reference example the runtime backup agent adapts to the live page — so it must be concrete and correct (a real call you saw work), not a paraphrase. Example: "browser_run_code({code: \`await page.goto('<EDIT_URL>'); await page.getByRole('textbox',{name:'Biography'}).fill('<ORIGINAL_BIO>'); await page.getByRole('button',{name:'Save'}).click();\`})".

${profile.safety}

PROPOSED PATTERNS:
${list}

After testing, **WRITE your result as a JSON object to this EXACT file path** (use the bash tool or a write-file tool):

  ${resultFile}

This file is how CHATS-Sandbox reads your result — stdout is NOT reliably parsed. The JSON shape:

{"patterns":[{"action":"...","trigger":"...","applies_to":"...","verdict":"keep|adjust|delete","verified":true,"verify_note":"<what you observed>","skill":"<for a mutating op>","recipe":"<exact reversal call(s) you ran, values as <PLACEHOLDER>>","capture_tools":["<read tool used>","<inverse/write tool used>"],"reverter":{"pin":"...","mcp_calls":[{"tool":"...","args":{}}]}}]}

Per pattern echo its verdict; include "skill" + "capture_tools" for a mutating op, or "reverter" for a creation-only op. Add any harvested ops. The LAST thing you do is write that file.`;
}
