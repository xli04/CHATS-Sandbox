/**
 * Rule engine — decides whether a tool call needs backup, denial, or pass-through.
 *
 * Check order:
 *   1. Deny rules       → block the call entirely
 *   2. Precaution field  → the LLM explicitly set precaution=true
 *   3. Rule-based list   → pattern match against known destructive commands
 *   4. Default           → backup everything (safe default)
 *
 * The only way to get "pass" is backupMode="off".
 * When backupMode="smart" or "always", unrecognized actions still get backed up.
 */

import type { HookContext, SandboxConfig } from "../types.js";

export type Decision = "deny" | "backup" | "pass";

export interface RuleResult {
  decision: Decision;
  reason: string;
  trigger: "deny_rule" | "backup_rule" | "precaution_field" | "default_backup" | "none";
}

/** Tools that are read-only — never need backup */
const READ_ONLY_TOOLS = new Set([
  "Read",
  "read_file",
  "search_files",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "TodoRead",
  "process",   // process list/poll — read-only
]);

export function evaluate(ctx: HookContext, config: SandboxConfig): RuleResult {
  const toolName = ctx.tool_name;
  const toolInput = ctx.tool_input;

  if (config.backupMode === "off") {
    return { decision: "pass", reason: "backupMode=off", trigger: "none" };
  }

  const commandStr = extractCommandString(toolName, toolInput);

  // ── 1. Deny rules ──────────────────────────────────────────────
  for (const pattern of config.denyPatterns) {
    try {
      if (new RegExp(pattern, "i").test(commandStr)) {
        return {
          decision: "deny",
          reason: `Blocked by deny rule: /${pattern}/`,
          trigger: "deny_rule",
        };
      }
    } catch {
      // Invalid regex — skip
    }
  }

  // ── 2. Precaution field (LLM self-declared) ────────────────────
  if (toolInput.precaution === true || toolInput.precaution === "true") {
    return {
      decision: "backup",
      reason: `LLM set precaution=true for ${toolName}`,
      trigger: "precaution_field",
    };
  }

  // ── 3. Skip read-only tools ────────────────────────────────────
  if (READ_ONLY_TOOLS.has(toolName)) {
    return {
      decision: "pass",
      reason: `${toolName} is read-only`,
      trigger: "none",
    };
  }

  // ── 3b. Skip our own CLI commands (they manage backups, not create risk) ──
  if (toolName === "Bash" && /\bchats-sandbox\b/.test(commandStr)) {
    return {
      decision: "pass",
      reason: "chats-sandbox CLI command (internal)",
      trigger: "none",
    };
  }

  // ── 4. Rule-based checklist ────────────────────────────────────
  if (isFileMutatingTool(toolName)) {
    return {
      decision: "backup",
      reason: `${toolName} is a file-mutating tool`,
      trigger: "backup_rule",
    };
  }

  for (const pattern of config.alwaysBackupPatterns) {
    try {
      if (new RegExp(pattern, "i").test(commandStr)) {
        return {
          decision: "backup",
          reason: `Matched backup rule: /${pattern}/`,
          trigger: "backup_rule",
        };
      }
    } catch {
      // Invalid regex — skip
    }
  }

  // ── 5. Default: backup everything not explicitly read-only ─────
  // This is the safe default. If an action is unknown, back it up.
  // The backup strategies will pick the cheapest approach.
  return {
    decision: "backup",
    reason: `Default backup for unrecognized action: ${toolName}`,
    trigger: "default_backup",
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractCommandString(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  switch (toolName) {
    case "Bash":
      return String(toolInput.command ?? "");
    case "FileEdit":
    case "Write":
    case "write_file":
    case "patch":
      return String(toolInput.path ?? toolInput.file_path ?? "");
    default:
      return JSON.stringify(toolInput);
  }
}

function isFileMutatingTool(toolName: string): boolean {
  const mutators = new Set([
    "FileEdit",
    "Write",
    "write_file",
    "patch",
    "NotebookEdit",
  ]);
  return mutators.has(toolName);
}
