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
import { execFileSync } from "node:child_process";
import type { SandboxConfig } from "../types.js";
import { extractJsonObject } from "../util/extract_json.js";
import {
  serverFromToolName,
  saveExperiences,
  loadExperiences,
  experiencePath,
  type RecoveryPattern,
  type ServerExperiences,
} from "./experiences.js";
import type { McpTool } from "./list_mcp_tools.js";

/** A stdio MCP server (command + args) or an HTTP MCP server (url). */
interface McpServerDef { command?: string; args?: string[]; url?: string; enabled?: boolean; }

/** Lazy-load js-yaml (external dep; may be absent). */
function loadYaml(): { load: (s: string) => unknown } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("js-yaml");
  } catch { return null; }
}

/** Read the MCP config the runner uses. For the hermes runner that's
 *  `~/.hermes/config.yaml` under `mcp_servers.<name>`. Returns the raw
 *  {name → def} map, or {} if unreadable. */
export function readMcpServers(): Record<string, McpServerDef> {
  const cfgPath = path.join(
    process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"),
    "config.yaml",
  );
  const yaml = loadYaml();
  if (!yaml) return {};
  try {
    const cfg = (yaml.load(fs.readFileSync(cfgPath, "utf-8")) ?? {}) as { mcp_servers?: Record<string, McpServerDef> };
    return cfg.mcp_servers ?? {};
  } catch { return {}; }
}

/** Resolve the path to the compiled list_mcp_tools CLI next to this module. */
function listToolsCliPath(): string {
  return path.join(__dirname, "list_mcp_tools.js");
}

/** Live tools/list for a STDIO MCP server — runs the CLI synchronously
 *  (execFileSync) so it slots into the sync runExplore. Returns full tool
 *  objects (name + description + inputSchema). Throws on failure. */
function liveToolsStdio(def: McpServerDef): McpTool[] {
  const out = execFileSync(
    process.execPath,
    [listToolsCliPath(), "--json", def.command!, ...(def.args ?? [])],
    { encoding: "utf-8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out) as McpTool[];
  if (!Array.isArray(parsed)) throw new Error("non-array tools/list");
  return parsed;
}

/** Live tools/list for an HTTP MCP server — POST initialize then tools/list to
 *  the url via curl (synchronous). Carries the mcp-session-id from initialize.
 *  Accept: application/json, text/event-stream. Throws on failure. */
function liveToolsHttp(def: McpServerDef): McpTool[] {
  const url = def.url!;
  const accept = "application/json, text/event-stream";
  const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "chats-sandbox", version: "1" } } });
  // -i to capture response headers (for mcp-session-id).
  const initRaw = execFileSync("curl", [
    "-sS", "-i", "-X", "POST", url,
    "-H", "Content-Type: application/json",
    "-H", `Accept: ${accept}`,
    "-d", initBody,
  ], { encoding: "utf-8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const sid = (initRaw.match(/^mcp-session-id:\s*(.+)$/im)?.[1] ?? "").trim();
  const listBody = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const headers = [
    "-H", "Content-Type: application/json",
    "-H", `Accept: ${accept}`,
  ];
  if (sid) { headers.push("-H", `mcp-session-id: ${sid}`); }
  const listRaw = execFileSync("curl", [
    "-sS", "-X", "POST", url, ...headers, "-d", listBody,
  ], { encoding: "utf-8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  // Response may be plain JSON or an SSE stream (`data: {...}` lines).
  const msg = parseJsonOrSse(listRaw);
  const tools = (msg?.result as { tools?: McpTool[] } | undefined)?.tools;
  if (!Array.isArray(tools)) throw new Error("HTTP tools/list returned no tools");
  return tools.map((t) => ({ name: t.name, description: typeof t.description === "string" ? t.description : undefined, inputSchema: (t as { inputSchema?: unknown }).inputSchema }));
}

/** Parse a JSON-RPC response that may be either bare JSON or an SSE stream. */
function parseJsonOrSse(raw: string): { result?: unknown } | null {
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed) as { result?: unknown }; } catch { /* try SSE */ }
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.+)$/);
    if (m) { try { return JSON.parse(m[1]) as { result?: unknown }; } catch { /* next */ } }
  }
  return null;
}

/** Get the LIVE tool surface for a server from the real MCP connection
 *  (initialize → tools/list). stdio → spawn command/args; http → curl url.
 *  Returns full tool objects. Throws on failure (caller skips the server). */
function liveToolsForServer(def: McpServerDef): McpTool[] {
  if (def.url) return liveToolsHttp(def);
  if (def.command) return liveToolsStdio(def);
  throw new Error("server def has neither command nor url");
}

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
function buildProposalPrompt(server: string, tools: McpTool[]): string {
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
      * read-only keywords (e.g. select, explain, show, describe, with, list) → emit them in "no_backup_patterns" (these arg-shapes need NO backup).
      * backup-needed keywords (e.g. insert, update, delete, drop, truncate, alter, merge, replace) → emit ONE pattern PER keyword, using that keyword as its "trigger".

SECOND, ENUMERATE EXHAUSTIVELY by effect — cover EVERY operation this server exposes, ONE pattern per distinct mutating op; do NOT stop at an arbitrary count. Group by effect so none is missed:
  - READ (e.g. select / show / explain / list / view): returns or displays data and commits NOTHING → NO pattern (its read keywords go to no_backup_patterns). NOTE: merely navigating / scrolling / viewing is a READ (everything stays in place) — but an action that LOOKS like navigation yet submits or saves IS a mutation.
  - CREATE (e.g. insert / create / add): makes NEW persistent state → needs a pattern + trigger.
  - UPDATE (e.g. update / edit / replace): overwrites prior state → needs a pattern + trigger.
  - DELETE (e.g. delete / drop / truncate / remove): removes data → needs a pattern + trigger.
  - OTHER PERSISTENT SIDE-EFFECT (e.g. grant / revoke permissions, schema / DDL changes, config): a durable change that isn't row-level create/update/delete → needs a pattern + trigger ANYWAY (even if it cannot be safely verified live later — "unsafe to verify" does NOT mean "no trigger").
  Hybrids (upsert / merge = create + update) → emit a trigger for BOTH shapes.

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
function buildVerificationPrompt(
  server: string,
  candidates: RecoveryPattern[],
  target: string | null,
  resultFile: string,
): string {
  const targetLine = target
    ? `TARGET (a disposable test system — safe to mutate): ${target}`
    : `No URL target was given — the "${server}" MCP operates on its own configured backend (e.g. a database). Use the MCP tools directly against that backend to test. Treat it as disposable: create/clean up throwaway items, don't touch real-looking production data.`;
  const seedLine = server === "postgres"
    ? `A fresh seeded table is ALREADY in place for you to mutate: chats_probe_seed(id serial pk, name text, status text) with 3 rows (alpha/active, beta/active, gamma/inactive). Test the destructive op + reversal against THIS table (or another chats_probe_* item you create).`
    : `Create a throwaway item (prefix names with "chats_probe_") to test against.`;
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

SAFETY (critical — the target is shared infrastructure):
  - Operate ONLY on throwaway items prefixed "chats_probe_" (the seeded table is one). Never touch existing real data, tables, or schemas.
  - NEVER modify authentication or access: no ALTER USER/ROLE, CREATE/DROP ROLE, GRANT/REVOKE, password changes, pg_hba, or system catalogs. Doing so will break the connection for everyone.
  - If a proposed reversal would require any of the above to test, mark verdict "delete" with the reason "unsafe to test".

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

/** A pattern carrying the transient stage-2 verdict (keep/adjust/delete). The
 *  verdict is consumed by the accumulate loop and not persisted to disk. */
type VerdictPattern = RecoveryPattern & { verdict?: string };

function parsePatterns(raw: string): VerdictPattern[] | null {
  // Pick the LAST balanced {...} object carrying a patterns[] — the final
  // verdict, not an earlier echoed proposal. A greedy first-`{`-to-last-`}`
  // match merges the two and fails to parse (dropping the verified flag).
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

/** Extract the MIXED-tool read-only ARG keywords ("no_backup_patterns") from a
 *  STAGE-1 proposal — e.g. select/explain/show for an execute_sql. These extend
 *  the no-backup keyword list (an action whose arg-shape matches commits nothing,
 *  so the gate can skip the backup). Drop any keyword carrying a mutating verb. */
function parseNoBackupPatterns(raw: string): string[] {
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

// ── Per-server RESET hook: re-create a known seeded sandbox state before each
//    pattern is verified, so every pattern tests against fresh, known data. The
//    reset is issued through the real MCP (a tools/call via the list CLI). For
//    postgres = a small seeded probe table. Servers without a hook reset to a
//    no-op (the verify agent creates its own throwaway items). ───────────────
const POSTGRES_SEED_SQL =
  "DROP TABLE IF EXISTS chats_probe_seed; " +
  "CREATE TABLE chats_probe_seed(id serial primary key, name text, status text); " +
  "INSERT INTO chats_probe_seed(name, status) VALUES " +
  "('alpha','active'),('beta','active'),('gamma','inactive');";

/** Issue a single tools/call through the live MCP to reset the sandbox to a
 *  known seeded state for `server`. Returns true if the reset ran (or there is
 *  no reset needed for this server). Best-effort: logs and returns false on
 *  failure so the caller can still attempt verification. */
function resetSandboxState(server: string, def: McpServerDef): boolean {
  // Only stdio servers (with a command) get a programmatic reset; HTTP/browser
  // servers let the verify agent seed their own throwaway items.
  if (server === "postgres" && def.command) {
    try {
      const out = execFileSync(
        process.execPath,
        [listToolsCliPath(), "--call", "execute_sql", JSON.stringify({ sql: POSTGRES_SEED_SQL }), def.command, ...(def.args ?? [])],
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

  // Tool acquisition is now LIVE: read the runner's MCP config and ask each
  // server's real connection (initialize → tools/list) for its full tool
  // surface (name + description + schema). No backup-history / cached-registry
  // path — exploration reflects the ACTUAL tools, not what prior runs called.
  const mcpServers = readMcpServers();
  let serverNames: string[];
  if (serverArg) {
    serverNames = [serverArg];
  } else {
    // Enumerate from the MCP config (not from backup history).
    serverNames = Object.keys(mcpServers).filter((n) => mcpServers[n]?.enabled !== false);
  }

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

    // ── Stage 1: propose (reasoning) ──────────────────────────────
    // Stage-1 output is occasionally unparseable (the model sometimes wraps
    // the JSON in extra prose / emits a malformed object). Retry a few times
    // rather than abandoning the whole server on one bad generation.
    let proposalText: string | null = null;
    let candidates: VerdictPattern[] | null = null;
    for (let attempt = 0; attempt < 4 && (!candidates || !candidates.length); attempt++) {
      proposalText = runRunnerForText(buildProposalPrompt(server, liveTools), genConfig, 180);
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

    // ── Stage 2: VERIFY & ACCUMULATE, ONE PATTERN PER RUN ─────────
    // Each pattern gets its own agent run + a fresh SEEDED sandbox (the
    // per-server reset hook). The agent destructs → reverses → confirms,
    // and returns a verdict: keep / adjust (re-test the corrected fix once)
    // / delete. It may also HARVEST extra patterns it verified live.
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

    // Match an emitted result back to its candidate (echo) vs. a harvested new
    // op. The first object whose action overlaps the candidate is the echo.
    const isEchoOf = (p: VerdictPattern, cand: VerdictPattern): boolean =>
      p.action === cand.action ||
      (!!p.trigger && p.trigger === cand.trigger);

    const finalPatterns: RecoveryPattern[] = [];
    let adjusted = 0;
    let harvested = 0;
    const stripVerdict = (p: VerdictPattern): RecoveryPattern => {
      const { verdict, ...rest } = p; void verdict; return rest;
    };

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
    const mixedNoBackup = proposalText ? parseNoBackupPatterns(proposalText) : [];
    noBackupPatterns = [...new Set([...noBackupPatterns, ...mixedNoBackup])];

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
    const mergedReadOnlyTools = [...new Set([...(prior?.readOnlyTools ?? []), ...readOnlyTools])];
    const mergedNoBackup = [...new Set([...(prior?.noBackupPatterns ?? []), ...noBackupPatterns])];

    const data: ServerExperiences = {
      server, generated: nowIso, observed_tools: tools, patterns: mergedPatterns,
      ...(mergedNoBackup.length ? { noBackupPatterns: mergedNoBackup } : {}),
      ...(mergedReadOnlyTools.length ? { readOnlyTools: mergedReadOnlyTools } : {}),
    };
    const p = saveExperiences(config, data);
    if (adjusted || harvested) {
      process.stderr.write(`  [${server}] stage-2: ${adjusted} adjusted, ${harvested} harvested\n`);
    }
    outcomes.push({
      server, tools, target, saved: true, path: p,
      proposed: candidates.length,
      verified: mergedPatterns.filter((x) => x.verified === true).length,
    });
  }
  return outcomes;
}

export { experiencePath };
