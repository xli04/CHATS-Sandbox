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
  subagentTimeoutSeconds: 60,
  // Default to bypassPermissions so the subagent has full freedom to
  // run any backup commands it needs (git push, curl, ssh, etc.).
  // Users who want a smaller blast radius can switch to "acceptEdits"
  // via `chats-sandbox config set subagentPermissionMode acceptEdits`.
  subagentPermissionMode: "bypassPermissions",
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
