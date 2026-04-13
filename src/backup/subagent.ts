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

/**
 * Write a status message directly to the user's controlling terminal.
 *
 * Claude Code captures hook stderr silently (it doesn't display in the
 * user's terminal), so this is the only way to show real-time progress.
 * /dev/tty bypasses stderr/stdout entirely and writes to whichever
 * terminal the user is sitting at.
 *
 * Falls back silently if /dev/tty is not writable (Windows, headless,
 * piped contexts).
 */
function tellUser(message: string): void {
  try {
    fs.writeFileSync("/dev/tty", `${message}\n`);
  } catch {
    // /dev/tty not available — fall back to stderr (visible in some setups)
    try {
      process.stderr.write(`${message}\n`);
    } catch {
      // give up
    }
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

  return `You are a backup subagent for CHATS-Sandbox. A tool call is about to execute that affects state OUTSIDE the workspace. Your job: actually CREATE a minimal recovery artifact BEFORE the action runs, then report what you did.

UPCOMING ACTION:
  Tool: ${toolName}
  Args: ${args}
  Command: ${command}

WORKSPACE (files inside this directory are already captured by tier-2 git snapshot):
  ${cwd}

BACKUP STORAGE DIRECTORY (write any artifact files you create here):
  ${interactionDir}

## CLASSIFY THE ACTION FIRST

Pick ONE of these categories:

### Category A: Local file write outside the current workspace
Example: Write tool with path /Users/foo/other_project/src/file.ts

STRATEGY — shadow git repo rooted at the target's project:
1. Find the target file's project root (walk up from its directory looking for .git, package.json, pyproject.toml, Cargo.toml, or similar markers). If no marker found, use the file's parent directory.
2. Create a shadow git repo at ${interactionDir}/external-shadow/:
     mkdir -p '${interactionDir}/external-shadow'
     GIT_DIR='${interactionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git init
     GIT_DIR='${interactionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git config user.email "chats-sandbox@local"
     GIT_DIR='${interactionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git config user.name "CHATS-Sandbox"
     GIT_DIR='${interactionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git add -A
     GIT_DIR='${interactionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git commit -m "pre-action snapshot" --allow-empty-message
3. Record the target project root path and the commit hash.
4. recovery_commands should be the three-step restore:
     GIT_DIR='${interactionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git read-tree <hash>
     GIT_DIR='${interactionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git checkout-index -f -a
     GIT_DIR='${interactionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git clean -fd
   This correctly handles create, modify, AND delete scenarios because it snapshots the entire target tree.

### Category B: Remote state (git push, curl POST/PUT/DELETE, API calls)
STRATEGY — document recovery for out-of-band state:
- For git push: create a local git tag at the current HEAD (backup_commands), and provide recovery_commands that would force-push the tag back if needed.
- For remote API calls: you likely can't back up the remote state. Document what would be needed for manual recovery in description.

### Category C: System package install/uninstall (pip, npm, apt, brew)
STRATEGY — save a manifest:
- pip install → pip freeze > ${interactionDir}/pip_freeze.txt, recovery = pip install -r that file
- npm install -g → npm list -g --json > ${interactionDir}/npm_list.json
- apt install → dpkg --get-selections > ${interactionDir}/apt_list.txt
- brew install → brew list > ${interactionDir}/brew_list.txt

### Category D: Environment variable mutation (export, unset, source)
STRATEGY — snapshot env vars: env > ${interactionDir}/env.txt

### Category E: Anything else
Do your best to capture some recoverable state in ${interactionDir}, or document clearly what cannot be recovered.

## OUTPUT FORMAT

After running your backup commands, output a single-line JSON object (no markdown fences, no commentary):

{"description":"...","backup_commands":["cmd1","cmd2"],"recovery_commands":["cmd1","cmd2"],"artifact_paths":["path1"]}

- description: short human-readable summary
- backup_commands: the commands you ACTUALLY RAN to create the backup
- recovery_commands: commands that would reverse the upcoming action (these will be executed verbatim by chats-sandbox restore)
- artifact_paths: files you created inside the backup storage directory

CRITICAL:
- DO NOT execute the upcoming action. You only create the backup.
- Actually run your backup_commands with the bash tool. Don't just describe them.
- Keep the final JSON under 2KB.`;
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
  //   --output-format json     : structured output with a `result` field
  //   --permission-mode <mode> : controls what tool calls the subagent
  //                              can run without prompting. Default is
  //                              "bypassPermissions" — full freedom for
  //                              git push, curl, ssh, etc. Configurable
  //                              to "acceptEdits" for a smaller blast
  //                              radius (filesystem ops only).
  //                              Without any permission mode, claude -p
  //                              denies all Bash tool use in headless
  //                              mode and fails with "permission_denials".
  //   --model <model>          : select the subagent model
  //
  // We use execFileSync with an array to avoid shell quoting issues with
  // the prompt argument.
  //
  // NOTE: do NOT use --bare. That flag skips OAuth/keychain auth loading,
  // which causes "Not logged in · Please run /login" errors for users
  // authenticated via Claude Max (the common case). Our recursion guard
  // via CHATS_SANDBOX_NO_HOOK env var is sufficient — we don't need
  // --bare's plugin-skipping behavior.
  const permissionMode = config.subagentPermissionMode ?? "bypassPermissions";
  const args = [
    "-p",
    prompt,
    "--output-format", "json",
    "--permission-mode", permissionMode,
  ];
  if (config.subagentModel && config.subagentModel !== "inherit") {
    args.push("--model", config.subagentModel);
  }

  logDebug(`invoking: claude ${args.slice(0, 2).join(" ")} [prompt=${prompt.length} chars] ${args.slice(2).join(" ")} (timeout=${timeoutMs}ms)`);

  // Tell the user what we're about to do — claude -p can take 5-30s and
  // there's otherwise no signal that anything is happening.
  const cmdPreview = String(ctx.tool_input.command ?? "")
    || String(ctx.tool_input.path ?? ctx.tool_input.file_path ?? "");
  tellUser(
    `[CHATS-Sandbox] Out-of-workspace action detected. Invoking ${config.subagentModel} subagent to back up... ` +
    `(${ctx.tool_name}${cmdPreview ? `: ${cmdPreview.slice(0, 60)}` : ""})`
  );

  const startTime = Date.now();
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
        // Recursion guard: the subagent's own tool calls will fire our
        // hooks. This env var makes our hooks exit early inside the
        // subprocess.
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

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

    // Detect common auth failure and log a clear message
    if (stdout.includes("Not logged in") || stderr.includes("Not logged in")) {
      logDebug("DIAGNOSIS: claude CLI is not logged in. Run `claude` interactively once to authenticate.");
      tellUser(
        "[CHATS-Sandbox] Subagent skipped: claude CLI not logged in. " +
        "Run `claude` interactively once to authenticate, or disable the subagent with " +
        "`chats-sandbox config set subagentEnabled false`."
      );
    } else {
      tellUser(`[CHATS-Sandbox] Subagent failed after ${elapsedSec}s: ${msg.slice(0, 120)}`);
    }
    return null;
  }

  const parsed = parseSubagentOutput(stdout);
  if (!parsed) {
    logDebug(`parse failed. Raw stdout was: ${stdout.slice(0, 2000)}`);

    // Detect permission denial (subagent couldn't run bash) and warn clearly
    if (stdout.includes("permission_denials") || stdout.includes("permission denied") ||
        stdout.includes("approval is needed") || stdout.includes("cannot proceed")) {
      logDebug("DIAGNOSIS: subagent was denied tool permissions. Use --permission-mode acceptEdits.");
      tellUser(
        "[CHATS-Sandbox] Subagent could not run backup commands (tool permission denied). " +
        "Try: chats-sandbox config set subagentPermissionMode bypassPermissions"
      );
    } else {
      tellUser("[CHATS-Sandbox] Subagent returned unparseable output — backup skipped.");
    }
    return null;
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  logDebug(`parse success: ${parsed.description}`);

  // Persist the raw subagent response as a file alongside the artifact
  const id = Math.random().toString(36).slice(2, 10);
  const artifactFile = path.join(interactionDir, `subagent_${id}.json`);
  fs.mkdirSync(interactionDir, { recursive: true });
  fs.writeFileSync(artifactFile, JSON.stringify(parsed, null, 2), "utf-8");

  // Tell the user the backup succeeded
  tellUser(`[CHATS-Sandbox] Subagent backup done in ${elapsedSec}s: ${parsed.description.slice(0, 100)}`);

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
