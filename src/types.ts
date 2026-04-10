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
    /** Replace tool input before execution */
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
  /** Max interaction folders to keep before pruning oldest */
  maxInteractions: number;
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
}

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  backupMode: "smart",
  backupDir: ".chats-sandbox/backups",
  maxInteractions: 50,
  effectManifest: true,
  effectLogPath: ".chats-sandbox/effects.jsonl",
  denyPatterns: [
    "rm\\s+-rf\\s+/(?!tmp)",
    "mkfs\\.",
    "dd\\s+if=.+of=/dev/",
    ":(\\)\\{\\s*:|\\(\\)\\s*\\{)",  // fork bomb
  ],
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
  strategy: "file_copy" | "git_tag" | "pip_freeze" | "npm_list" | "env_snapshot" | "git_snapshot" | "subagent";
  /** Where the backup artifact lives */
  artifactPath: string;
  /** Size in bytes (if applicable) */
  sizeBytes?: number;
  /** Commands the subagent ran to create this backup (tier 3 only) */
  subagentCommands?: string[];
  /** The original action that was about to execute (for restore context) */
  originalAction?: string;
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
