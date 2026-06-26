/**
 * CHATS-Sandbox type definitions.
 *
 * These mirror the JSON schema that Claude Code hooks send/receive.
 */

// ── Hook input (what Claude Code sends on stdin) ─────────────────────

export interface HookContext {
  /** Which hook event fired */
  hook_event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure";
  /** Tool name: "Bash", "FileEdit", "Write", etc. */
  tool_name: string;
  /** Tool arguments the LLM produced */
  tool_input: Record<string, unknown>;
  /** Tool output (only present in PostToolUse / PostToolUseFailure) */
  tool_output?: unknown;
  /** Session ID */
  session_id?: string;
}

/**
 * Normalize a parsed hook-input object into the HookContext shape.
 *
 * Agents differ slightly in field names: Claude Code and the Hermes
 * plugin send `{hook_event, tool_output}`; the OpenHands SDK sends
 * `{event_type, tool_response}`. This accepts both so every agent
 * shares one downstream contract, and hardens against null/missing
 * tool_input (OpenHands types it `dict | null`).
 */
/**
 * Build a compact, human-readable label for a tool call —
 * "Bash(rm x)", "Write(/abs/file.txt)", etc. Picks the most relevant
 * arg per tool: command for shell tools, file path for editors, and a
 * trimmed JSON fallback so non-shell tools (Write/Edit/MCP) never
 * render empty parens.
 */
export function describeToolAction(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  const ti = toolInput ?? {};
  const pick = (k: string): string | undefined =>
    typeof ti[k] === "string" && (ti[k] as string).length > 0 ? (ti[k] as string) : undefined;
  const arg =
    pick("command") ??
    pick("file_path") ?? pick("path") ?? pick("target") ?? pick("destination") ??
    pick("url") ?? pick("element") ??
    (Object.keys(ti).length ? JSON.stringify(ti) : "");
  return `${toolName}(${String(arg).slice(0, 200)})`;
}

/** OpenHands SDK tool names → the Claude-Code names the backup logic
 *  keys on. Applied only to payloads in the SDK's shape (event_type),
 *  so other agents' identically-named tools are unaffected — Hermes
 *  and OpenClaw do this mapping in their plugins instead. */
const OPENHANDS_TOOL_MAP: Record<string, string> = {
  terminal: "Bash",
  file_editor: "Edit",
  planning_file_editor: "Edit",
  apply_patch: "Edit",
  glob: "Glob",
  grep: "Grep",
};

/** Codex CLI payload tool names → canonical. Codex already serializes
 *  shell as "Bash"; file edits arrive as "apply_patch". */
const CODEX_TOOL_MAP: Record<string, string> = {
  apply_patch: "Edit",
};

/** Cursor payload tool names → canonical. Cursor's shell tool has gone
 *  by several names across versions; map the known candidates. */
const CURSOR_TOOL_MAP: Record<string, string> = {
  Shell: "Bash",
  shell: "Bash",
  run_terminal_cmd: "Bash",
  read_file: "Read",
  edit_file: "Edit",
  write_file: "Write",
};

/**
 * Which hook dialect produced this payload — decides both tool-name
 * normalization and (in pre-tool.ts) the OUTPUT shape we must emit.
 *   claude    — Claude Code / Codex (hookSpecificOutput contract)
 *   openhands — OpenHands SDK (allow/deny only; event_type key)
 *   cursor    — Cursor (top-level {permission, updated_input} contract)
 */
export type HookDialect = "claude" | "openhands" | "cursor";

export function detectHookDialect(parsed: unknown): HookDialect {
  const p = (parsed && typeof parsed === "object"
    ? parsed : {}) as Record<string, unknown>;
  if (p.hook_event === undefined && typeof p.event_type === "string") {
    return "openhands";
  }
  // Cursor payloads carry conversation/generation ids and workspace
  // roots; Claude Code and Codex carry session_id/turn_id instead.
  if (p.conversation_id !== undefined || p.generation_id !== undefined ||
      p.workspace_roots !== undefined) {
    return "cursor";
  }
  return "claude";
}

/** Map dialect-specific event names ("preToolUse", "PreToolUse") onto
 *  the canonical PascalCase set. */
function canonicalEvent(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const k = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (k === "pretooluse") return "PreToolUse";
  if (k === "posttooluse") return "PostToolUse";
  if (k === "posttoolusefailure") return "PostToolUseFailure";
  if (k === "userpromptsubmit") return "UserPromptSubmit";
  return raw;
}

export function normalizeHookContext(parsed: unknown): HookContext {
  const p = (parsed && typeof parsed === "object"
    ? parsed : {}) as Record<string, unknown>;
  const dialect = detectHookDialect(parsed);
  const hookEvent = canonicalEvent(p.hook_event ?? p.hook_event_name ?? p.event_type);
  let toolName = typeof p.tool_name === "string" ? p.tool_name : "";
  let toolInput = (p.tool_input && typeof p.tool_input === "object")
    ? p.tool_input as Record<string, unknown> : {};

  if (dialect === "openhands") {
    toolName = OPENHANDS_TOOL_MAP[toolName] ?? toolName;
  } else if (dialect === "cursor") {
    toolName = CURSOR_TOOL_MAP[toolName] ?? toolName;
    // Cursor's beforeShellExecution-style payloads put the command at
    // the top level; surface it as tool_input.command for the rules.
    if (toolInput.command === undefined && typeof p.command === "string") {
      toolInput = { ...toolInput, command: p.command };
      if (!toolName) toolName = "Bash";
    }
  } else {
    toolName = CODEX_TOOL_MAP[toolName] ?? toolName;
  }
  // Editor tools on several agents use "path" where Claude Code uses
  // "file_path" — mirror it so path-keyed logic sees the usual key.
  if (typeof toolInput.path === "string" && toolInput.file_path === undefined) {
    toolInput = { ...toolInput, file_path: toolInput.path };
  }

  return {
    hook_event: (hookEvent ?? "PreToolUse") as HookContext["hook_event"],
    tool_name: toolName,
    tool_input: toolInput,
    tool_output: p.tool_output ?? p.tool_response,
    session_id: typeof p.session_id === "string" ? p.session_id : undefined,
  };
}

// ── Hook output (what we write to stdout) ────────────────────────────

export interface PreToolHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    /** "allow" | "deny" | "ask" */
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    /** Replace tool input before execution — Claude Code honors this to
     *  swap in our tier-0 rewrite (rm → mv-to-trash, etc.). */
    updatedInput?: Record<string, unknown>;
    /** Extra context injected into the conversation */
    additionalContext?: string;
  };
}

export interface PostToolHookOutput {
  hookSpecificOutput: {
    hookEventName: "PostToolUse" | "PostToolUseFailure";
    additionalContext?: string;
  };
}

// ── Sandbox config ───────────────────────────────────────────────────

export type BackupMode = "always" | "smart" | "off";

export interface SandboxConfig {
  /** Master switch */
  enabled: boolean;
  /** "always" = backup every tool call, "smart" = rule + precaution, "off" = disabled */
  backupMode: BackupMode;
  /** Directory for backup artifacts */
  backupDir: string;
  /** Max action folders to keep before pruning oldest. 0 = disabled. */
  maxActions: number;
  /** Max total size of action folders in MB. 0 = disabled. Oldest pruned
   *  first until the total is under the cap. Does NOT include the shared
   *  shadow git repo (that has its own lifecycle). */
  maxTotalSizeMB: number;
  /** Max age of action folders in hours. 0 = disabled. Folders older
   *  than this are pruned, regardless of count. */
  maxAgeHours: number;
  /** Enable effect manifest logging */
  effectManifest: boolean;
  /** Path to effect log */
  effectLogPath: string;
  /** Custom deny rules (regex patterns for Bash commands) */
  denyPatterns: string[];
  /** Patterns that always require backup (even in "smart" mode) */
  alwaysBackupPatterns: string[];
  /** Verbose logging */
  verbose: boolean;
  /** Enable tier-3 subagent backup for out-of-workspace actions */
  subagentEnabled: boolean;
  /** Model to use for the subagent ("haiku", "sonnet", "opus", "inherit") */
  subagentModel: "haiku" | "sonnet" | "opus" | "inherit";
  /** Max seconds to wait for the subagent before giving up */
  subagentTimeoutSeconds: number;
  /** Permission mode passed to claude -p for the subagent.
   *  "bypassPermissions" (default) — full freedom, needed for git push,
   *    curl, ssh, aws, gcloud, etc. Wide blast radius — only safe to
   *    use if you trust the parent prompt and your sandbox config.
   *  "acceptEdits" — auto-approve filesystem ops only (mkdir, cp, mv,
   *    sed, git). Blocks network calls and arbitrary shell. Smaller
   *    blast radius but may fail for backups that need network access.
   */
  subagentPermissionMode: "bypassPermissions" | "acceptEdits";
  /** Which runner spawns the tier-3 subagent.
   *  "claude"   — `claude -p` CLI (default; for Claude Code deployments).
   *  "hermes"   — headless `hermes chat` subagent (for Hermes
   *    deployments). The OpenRouter/provider API key is read from the
   *    environment of the parent process, never stored in config.
   *  "openclaw" — headless `openclaw agent --local` one-shot turn (for
   *    OpenClaw deployments). Provider keys come from the environment.
   *  "codex"    — headless `codex exec` one-shot turn (for Codex
   *    deployments). Uses the user's existing codex login. */
  subagentRunner: "claude" | "hermes" | "openclaw" | "codex";
  /** For subagentRunner="hermes": model id passed to `hermes chat -m`
   *  (e.g. "anthropic/claude-haiku-4.5"). Ignored for the claude runner. */
  subagentHermesModel: string;
  /** For subagentRunner="hermes": provider passed to `hermes chat
   *  --provider` (e.g. "openrouter"). Ignored for the claude runner. */
  subagentHermesProvider: string;
  /** For subagentRunner="openclaw": model id passed to `openclaw agent
   *  --model` (e.g. "openrouter/anthropic/claude-haiku-4.5"). Empty =
   *  the OpenClaw agent's own default model. */
  subagentOpenclawModel: string;
  /** For subagentRunner="codex": model id passed to `codex exec -m`
   *  (e.g. "gpt-5.5-codex"). Empty = codex's own default model. */
  subagentCodexModel: string;
  /** Path to an MCP config JSON (claude `--mcp-config`) handed to the
   *  LIVE-RESTORE subagent only, so it can reverse remote/UI state through
   *  the same tools the agent used (e.g. a playwright browser). Not given
   *  to backup-time subagents — they would collide with the agent's still
   *  active browser. Empty/unset = no MCP servers for the subagent. */
  subagentMcpConfig?: string;
  /** Maps an MCP SERVER to the EXPERIENCE that covers it, for cases where
   *  the experience name differs from the tool's server — e.g. a website
   *  driven through the browser: `{ "playwright": "reddit" }`. At backup
   *  time the subagent looks up the action's server here to inject the right
   *  learned reversal patterns. Without an entry, the server name is used
   *  as the experience name (dedicated MCPs like postgres → postgres). */
  experienceForServer?: Record<string, string>;
  /** Optional STRONGER model for the live-restore subagent only (backup stays
   *  on subagentModel). Restore must perform precise multi-step UI actions a
   *  cheap model can't. For the claude runner: haiku|sonnet|opus; for hermes a
   *  full model id. Unset = use subagentModel for restore too. */
  subagentRestoreModel?: string;
}

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  backupMode: "smart",
  backupDir: ".chats-sandbox/backups",
  maxActions: 50,
  // Size and age retention default OFF — keep maxActions as the only
  // enabled limit unless the user opts in.
  maxTotalSizeMB: 0,
  maxAgeHours: 0,
  effectManifest: true,
  effectLogPath: ".chats-sandbox/effects.jsonl",
  // Deny is opt-in. Claude Code and the underlying model already refuse
  // obviously destructive commands (rm -rf /, fork bombs, etc.), so the
  // sandbox ships with no default deny rules. Users who want policy
  // enforcement can add their own patterns via `chats-sandbox config`.
  denyPatterns: [],
  alwaysBackupPatterns: [
    "rm\\s",
    "git\\s+push",
    "git\\s+rebase",
    "git\\s+reset",
    "git\\s+commit\\s+--amend",
    "pip\\s+install",
    "pip\\s+uninstall",
    "npm\\s+install",
    "npm\\s+uninstall",
    "apt\\s+install",
    "apt\\s+remove",
    "docker\\s+rm",
    "DROP\\s+TABLE",
    "TRUNCATE",
    "DELETE\\s+FROM",
  ],
  verbose: false,
  // Tier-3 subagent is enabled by default. It shells out to `claude -p
  // --model haiku` when an out-of-workspace action is detected that
  // no targeted manifest can cover. Users who want zero subagent
  // overhead can disable it via `chats-sandbox config set subagentEnabled false`.
  subagentEnabled: true,
  subagentModel: "haiku",
  // Measured: warm `claude -p` backups take 20-35s, but a cold start can
  // exceed 90s — 60s timed out in stress testing, losing the backup.
  subagentTimeoutSeconds: 120,
  // Default to bypassPermissions so the subagent has full freedom to
  // run any backup commands it needs (git push, curl, ssh, etc.).
  // Users who want a smaller blast radius can switch to "acceptEdits"
  // via `chats-sandbox config set subagentPermissionMode acceptEdits`.
  subagentPermissionMode: "bypassPermissions",
  // Default runner is the claude CLI. `chats-sandbox install hermes`
  // overwrites this with "hermes" so non-Claude agents get a working
  // tier-3 subagent.
  subagentRunner: "claude",
  subagentHermesModel: "anthropic/claude-haiku-4.5",
  subagentHermesProvider: "openrouter",
  // Empty = use the OpenClaw agent's default model for the subagent.
  subagentOpenclawModel: "",
  // Empty = use codex's default model for the subagent.
  subagentCodexModel: "",
};

// ── Backup artifact ──────────────────────────────────────────────────

export interface BackupArtifact {
  /** Unique ID */
  id: string;
  /** ISO timestamp */
  timestamp: string;
  /** What triggered the backup */
  trigger: "rule" | "precaution" | "always";
  /** Tool that was about to run */
  toolName: string;
  /** Human-readable description of what was backed up */
  description: string;
  /** Strategy used */
  strategy: "file_copy" | "git_tag" | "pip_freeze" | "npm_list" | "env_snapshot" | "git_snapshot" | "subagent" | "policy_rewrite";
  /** Where the backup artifact lives */
  artifactPath: string;
  /** Size in bytes (if applicable) */
  sizeBytes?: number;
  /** Commands the subagent ran to create this backup (tier 3 only) */
  subagentCommands?: string[];
  /** The original action that was about to execute (for restore context) */
  originalAction?: string;
  /** Full git commit hash (for git_snapshot strategy — references shared shadow repo) */
  commitHash?: string;
  /** Subagent-only: if true, the recorded subagentCommands are NOT a
   *  reliable inverse (e.g. remote state that drifts). On restore, the
   *  plugin will spawn a fresh subagent to reason about current state
   *  rather than executing the canned commands. */
  liveRestore?: boolean;
  /** policy_rewrite-only: commands that reverse the rewrite. Runs via
   *  execSync on restore — same contract as subagent's recovery_commands. */
  recoveryCommands?: string[];
  /** policy_rewrite-only: the rule id that fired (for debugging, UI). */
  policyRuleId?: string;
}

// ── Effect manifest entry ────────────────────────────────────────────

export interface EffectEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Session ID */
  sessionId?: string;
  /** Tool name */
  toolName: string;
  /** Tool input summary */
  toolInput: Record<string, unknown>;
  /** Exit code (for Bash) */
  exitCode?: number;
  /** Files created/modified/deleted */
  filesCreated?: string[];
  filesModified?: string[];
  filesDeleted?: string[];
  /** Backup artifact ID (if backup was taken) */
  backupId?: string;
  /** Duration in ms */
  durationMs?: number;
  /** Whether the tool succeeded */
  success: boolean;
}
