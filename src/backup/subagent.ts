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
  // When claude -p is called with --output-format json, the response is a
  // JSON wrapper like {"result": "...", "session_id": "...", ...}.
  // The `result` field contains the actual text the subagent produced,
  // which should itself be (or contain) our backup JSON.
  //
  // We try in this order:
  //   1. Parse raw as JSON wrapper → extract `result` → parse result as our JSON
  //   2. Parse the first {...} block in raw directly (fallback for text mode)

  function extractOurShape(candidate: unknown): SubagentResponse | null {
    if (
      typeof candidate === "object" && candidate !== null &&
      typeof (candidate as Record<string, unknown>).description === "string" &&
      Array.isArray((candidate as Record<string, unknown>).backup_commands) &&
      Array.isArray((candidate as Record<string, unknown>).recovery_commands)
    ) {
      const c = candidate as Record<string, unknown>;
      return {
        description: String(c.description),
        backup_commands: (c.backup_commands as unknown[]).map(String),
        recovery_commands: (c.recovery_commands as unknown[]).map(String),
        artifact_paths: Array.isArray(c.artifact_paths)
          ? (c.artifact_paths as unknown[]).map(String)
          : undefined,
      };
    }
    return null;
  }

  // Try 1: parse raw as claude -p JSON wrapper
  try {
    const wrapper = JSON.parse(raw);
    if (wrapper && typeof wrapper === "object") {
      const result = (wrapper as Record<string, unknown>).result;
      if (typeof result === "string") {
        // Extract JSON block from the result text
        const innerMatch = result.match(/\{[\s\S]*\}/);
        if (innerMatch) {
          try {
            const inner = JSON.parse(innerMatch[0]);
            const shaped = extractOurShape(inner);
            if (shaped) return shaped;
          } catch {
            // fall through
          }
        }
      }
      // Maybe the wrapper itself has our shape (if claude passed through)
      const direct = extractOurShape(wrapper);
      if (direct) return direct;
    }
  } catch {
    // Not valid JSON at top level, fall through
  }

  // Try 2: find any {...} block in the raw text
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      const shaped = extractOurShape(parsed);
      if (shaped) return shaped;
    } catch {
      // give up
    }
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

  // Always write diagnostic trace to a log file so users can debug
  // silent subagent failures without needing verbose mode.
  const debugLogPath = path.join(path.dirname(path.resolve(config.backupDir)), "subagent.log");
  const logDebug = (msg: string): void => {
    try {
      fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
      fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      // best-effort
    }
  };

  if (!isClaudeCliAvailable()) {
    logDebug("skipped: claude CLI not found in PATH");
    if (config.verbose) {
      process.stderr.write("[CHATS-Sandbox] subagent skipped: claude CLI not found\n");
    }
    return null;
  }

  const prompt = buildSubagentPrompt(ctx, interactionDir);
  const timeoutMs = Math.max(10_000, config.subagentTimeoutSeconds * 1000);

  // Invoke `claude -p` with:
  //   --output-format json : structured output with a `result` field
  //   --bare               : skip plugins/hooks/MCP discovery (faster + no recursion)
  //   --model <model>      : select the subagent model
  // We use execFileSync with an array to avoid shell quoting issues with the prompt.
  const args = [
    "-p",
    prompt,
    "--output-format", "json",
    "--bare",
  ];
  if (config.subagentModel && config.subagentModel !== "inherit") {
    args.push("--model", config.subagentModel);
  }

  logDebug(`invoking: claude ${args.slice(0, 2).join(" ")} [prompt=${prompt.length} chars] ${args.slice(2).join(" ")} (timeout=${timeoutMs}ms)`);

  let stdout = "";
  let stderr = "";
  try {
    // Use execFileSync — avoids shell parsing of the prompt argument
    const { execFileSync } = require("node:child_process");
    stdout = execFileSync("claude", args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      env: {
        ...process.env,
        // Recursion guard (even with --bare, belt and suspenders):
        // the subagent's own tool calls will fire our hooks. This env
        // var makes our hooks exit early inside the subprocess.
        CHATS_SANDBOX_NO_HOOK: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024, // 4 MB cap
    });
    logDebug(`stdout (${stdout.length} chars): ${stdout.slice(0, 500)}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const errWithOutput = e as { stdout?: string; stderr?: string };
    if (errWithOutput.stdout) stdout = String(errWithOutput.stdout);
    if (errWithOutput.stderr) stderr = String(errWithOutput.stderr);
    logDebug(`FAILED: ${msg.slice(0, 500)}`);
    if (stderr) logDebug(`stderr: ${stderr.slice(0, 500)}`);
    if (stdout) logDebug(`partial stdout: ${stdout.slice(0, 500)}`);
    if (config.verbose) {
      process.stderr.write(
        `[CHATS-Sandbox] subagent failed: ${msg.slice(0, 200)}\n`
      );
    }
    return null;
  }

  const parsed = parseSubagentOutput(stdout);
  if (!parsed) {
    logDebug(`parse failed. Raw stdout was: ${stdout.slice(0, 2000)}`);
    if (config.verbose) {
      process.stderr.write(
        "[CHATS-Sandbox] subagent returned unparseable output\n"
      );
    }
    return null;
  }

  logDebug(`parse success: ${parsed.description}`);

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
