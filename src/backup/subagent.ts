/**
 * Tier-3 subagent backup via `claude -p` subprocess.
 *
 * When the hook detects an outside-workspace action that no targeted
 * manifest can cover, it shells out to Claude Code in headless mode
 * with a constrained prompt. The subagent runs synchronously, its
 * output is captured, parsed, and persisted to the interaction folder's
 * metadata.json as a `subagent` strategy artifact.
 *
 * Key safety properties:
 *   - CHATS_SANDBOX_NO_HOOK=1 is set in the subprocess environment,
 *     so the subagent's own tool calls won't re-trigger this hook
 *     (prevents infinite recursion).
 *   - Subprocess timeout is hard-limited via config.subagentTimeoutSeconds.
 *   - Any failure (claude CLI missing, timeout, parse error) falls back
 *     silently to just the tier-2 git snapshot.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { BackupArtifact, HookContext, SandboxConfig } from "../types.js";

/** Shape of the JSON the subagent is instructed to return */
interface SubagentResponse {
  /** Short description of what was backed up */
  description: string;
  /** Commands the subagent ran to create the backup */
  backup_commands: string[];
  /** Commands to run for recovery (reverse the upcoming action) */
  recovery_commands: string[];
  /** Optional: paths to backup artifact files the subagent wrote */
  artifact_paths?: string[];
}

function isClaudeCliAvailable(): boolean {
  try {
    execSync("command -v claude", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function buildSubagentPrompt(
  ctx: HookContext,
  interactionDir: string
): string {
  const toolName = ctx.tool_name;
  const command = String(ctx.tool_input.command ?? "");
  const args = JSON.stringify(ctx.tool_input, null, 2);
  const cwd = process.cwd();

  return `You are a backup subagent for CHATS-Sandbox. A tool call is about to execute that affects state OUTSIDE the workspace. Your job: create a minimal recovery artifact BEFORE it runs.

UPCOMING ACTION:
  Tool: ${toolName}
  Args: ${args}
  Command: ${command}

WORKSPACE (files inside this directory are already captured by tier-2 git snapshot):
  ${cwd}

BACKUP STORAGE DIRECTORY (write artifact files here if needed):
  ${interactionDir}

INSTRUCTIONS:
1. Analyze the upcoming action. What out-of-workspace state does it affect?
   Examples:
     - pip/npm/apt install → system-wide packages (can save with pip freeze, etc.)
     - git push → remote ref state (can create a git tag)
     - curl POST → remote API (probably can't back up, just document)
     - writing to /etc/ or ~/.config/ → copy the file before overwriting
2. Use the CHEAPEST strategy. Save a recipe (manifest), not a full copy.
3. DO NOT execute the upcoming action itself. You are only creating the backup.
4. Output ONLY a single-line JSON object to stdout (no markdown, no commentary):

{"description":"what was backed up","backup_commands":["cmd1","cmd2"],"recovery_commands":["cmd1","cmd2"],"artifact_paths":["path/to/artifact"]}

REQUIREMENTS:
- description: short human-readable summary
- backup_commands: list of shell commands you actually ran (for audit/debug)
- recovery_commands: list of shell commands that would reverse the upcoming action
- artifact_paths: optional list of files you created in the backup storage dir

If the action is reversible via simple commands, fill recovery_commands with those.
If it's not truly reversible, document what steps would be needed anyway.
Be concise. Keep the JSON under 2KB.`;
}

function parseSubagentOutput(raw: string): SubagentResponse | null {
  // Find the first {...} block in the output (claude may emit extra lines)
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    if (
      typeof parsed.description === "string" &&
      Array.isArray(parsed.backup_commands) &&
      Array.isArray(parsed.recovery_commands)
    ) {
      return {
        description: parsed.description,
        backup_commands: parsed.backup_commands.map(String),
        recovery_commands: parsed.recovery_commands.map(String),
        artifact_paths: Array.isArray(parsed.artifact_paths)
          ? parsed.artifact_paths.map(String)
          : undefined,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Invoke a subagent via `claude -p` to reason about an out-of-workspace
 * action and create a backup artifact. Synchronous — blocks until the
 * subagent finishes or the timeout expires.
 *
 * Returns a BackupArtifact with strategy="subagent" on success, or null
 * on any failure (missing claude CLI, timeout, parse error, etc.).
 */
export function runSubagentBackup(
  ctx: HookContext,
  interactionDir: string,
  config: SandboxConfig
): BackupArtifact | null {
  if (!config.subagentEnabled) return null;
  if (!isClaudeCliAvailable()) {
    if (config.verbose) {
      process.stderr.write("[CHATS-Sandbox] subagent skipped: claude CLI not found\n");
    }
    return null;
  }

  const prompt = buildSubagentPrompt(ctx, interactionDir);
  const timeoutMs = Math.max(10_000, config.subagentTimeoutSeconds * 1000);

  // Build claude -p command with model selection
  const modelArg =
    config.subagentModel && config.subagentModel !== "inherit"
      ? ` --model ${config.subagentModel}`
      : "";

  let stdout = "";
  try {
    stdout = execSync(`claude -p${modelArg}`, {
      input: prompt,
      encoding: "utf-8",
      timeout: timeoutMs,
      env: {
        ...process.env,
        // Recursion guard: the subagent's own tool calls will fire our hooks.
        // This env var makes our hooks exit early inside the subprocess.
        CHATS_SANDBOX_NO_HOOK: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024, // 4 MB cap
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (config.verbose) {
      process.stderr.write(
        `[CHATS-Sandbox] subagent failed: ${msg.slice(0, 200)}\n`
      );
    }
    return null;
  }

  const parsed = parseSubagentOutput(stdout);
  if (!parsed) {
    if (config.verbose) {
      process.stderr.write(
        "[CHATS-Sandbox] subagent returned unparseable output\n"
      );
    }
    return null;
  }

  // Persist the raw subagent response as a file alongside the artifact
  const id = Math.random().toString(36).slice(2, 10);
  const artifactFile = path.join(interactionDir, `subagent_${id}.json`);
  fs.mkdirSync(interactionDir, { recursive: true });
  fs.writeFileSync(artifactFile, JSON.stringify(parsed, null, 2), "utf-8");

  return {
    id,
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: `Subagent backup: ${parsed.description}`,
    strategy: "subagent",
    artifactPath: artifactFile,
    subagentCommands: parsed.recovery_commands,
    originalAction: `${ctx.tool_name}(${String(ctx.tool_input.command ?? JSON.stringify(ctx.tool_input)).slice(0, 200)})`,
  };
}
