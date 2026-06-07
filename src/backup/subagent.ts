/**
 * Tier-3 subagent backup via `claude -p` subprocess.
 *
 * When the hook detects an outside-workspace action that no targeted
 * manifest can cover, it shells out to Claude Code in headless mode
 * with a constrained prompt. The subagent runs synchronously, its
 * output is captured, parsed, and persisted to the action folder's
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
  /** True when the canned recovery_commands can't be trusted later
   *  (remote/dynamic state) and restore should spawn a fresh subagent
   *  instead of replaying the commands. */
  live_restore?: boolean;
}

function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the subprocess invocation for the tier-3 subagent, branching on
 * config.subagentRunner.
 *
 *   claude — `claude -p <prompt> --output-format json …` (Claude Code).
 *   hermes — `hermes chat -q <prompt> -m <model> --provider <p> -Q --yolo`
 *            (Hermes / non-Claude agents). The provider API key is read
 *            from the environment (OPENROUTER_API_KEY etc.) inherited
 *            from the parent process — never stored in config.
 *
 * Returns null when the configured runner's CLI isn't on PATH, so the
 * caller degrades gracefully (skip backup / report restore failure)
 * exactly as it did for the missing-claude case.
 */
function buildSubagentInvocation(
  prompt: string,
  config: SandboxConfig,
): { bin: string; args: string[]; runner: "claude" | "hermes" } | null {
  const runner = config.subagentRunner ?? "claude";

  if (runner === "hermes") {
    if (!isCommandAvailable("hermes")) return null;
    const model = config.subagentHermesModel || "anthropic/claude-haiku-4.5";
    const provider = config.subagentHermesProvider || "openrouter";
    return {
      bin: "hermes",
      runner,
      // -Q quiet (programmatic), --yolo skip approval prompts so the
      // headless subagent can run git/bash without blocking.
      args: ["chat", "-q", prompt, "-m", model, "--provider", provider, "-Q", "--yolo"],
    };
  }

  // Default: claude -p
  if (!isCommandAvailable("claude")) return null;
  const permissionMode = config.subagentPermissionMode ?? "bypassPermissions";
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--no-session-persistence",
    "--setting-sources", "user",
  ];
  if (permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", permissionMode);
  }
  if (config.subagentModel && config.subagentModel !== "inherit") {
    args.push("--model", config.subagentModel);
  }
  return { bin: "claude", args, runner };
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
  actionDir: string
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
  ${actionDir}

## CLASSIFY THE ACTION FIRST

Pick ONE of these categories:

### Category A: Local file write outside the current workspace
Example: Write tool with path /Users/foo/other_project/src/file.ts

STRATEGY — shadow git repo rooted at the target's project:
1. Find the target file's project root (walk up from its directory looking for .git, package.json, pyproject.toml, Cargo.toml, or similar markers). If no marker found, use the file's parent directory.
2. Create a shadow git repo at ${actionDir}/external-shadow/:
     mkdir -p '${actionDir}/external-shadow'
     GIT_DIR='${actionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git init
     GIT_DIR='${actionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git config user.email "chats-sandbox@local"
     GIT_DIR='${actionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git config user.name "CHATS-Sandbox"
     GIT_DIR='${actionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git add -A
     GIT_DIR='${actionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git commit -m "pre-action snapshot" --allow-empty-message
3. Record the target project root path and the commit hash.
4. recovery_commands should be the three-step restore:
     GIT_DIR='${actionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git read-tree <hash>
     GIT_DIR='${actionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git checkout-index -f -a
     GIT_DIR='${actionDir}/external-shadow' GIT_WORK_TREE='<target-project-root>' git clean -fd
   This correctly handles create, modify, AND delete scenarios because it snapshots the entire target tree.

### Category B: Remote state (git push, curl POST/PUT/DELETE, API calls)
STRATEGY — document recovery for out-of-band state:
- For git push: create a local git tag at the current HEAD (backup_commands), and provide recovery_commands that would force-push the tag back if needed.
- For remote API calls: you likely can't back up the remote state. Document what would be needed for manual recovery in description.

### Category C: System package install/uninstall (pip, npm, apt, brew)
STRATEGY — save a manifest:
- pip install → pip freeze > ${actionDir}/pip_freeze.txt, recovery = pip install -r that file
- npm install -g → npm list -g --json > ${actionDir}/npm_list.json
- apt install → dpkg --get-selections > ${actionDir}/apt_list.txt
- brew install → brew list > ${actionDir}/brew_list.txt

### Category D: Environment variable mutation (export, unset, source)
STRATEGY — snapshot env vars: env > ${actionDir}/env.txt

### Category F: Remote state accessed via an MCP tool (mcp__*)
The upcoming action is an MCP tool call (tool name starts with mcp__).
Examples: mcp__playwright__browser_click, mcp__notion__create_page,
mcp__github__create_issue, mcp__slack__send_message.

STRATEGY — scrape the current remote state via the SAME MCP, then record
recovery instructions:

1. Determine what state the action is about to modify or destroy. For a
   browser_click that says "delete post," that's the post's current
   content. For a notion__update_page, that's the page's current
   contents. For an mcp__github__close_issue, that's the issue's
   current state.

2. Use the SAME MCP tools (they're available to you — your MCP servers
   were inherited from the user's Claude Code session) to fetch the
   current state. Examples:
   - For Playwright: use browser_navigate + browser_snapshot to capture
     the page DOM/text, parse out the relevant fields (title, body,
     comments, etc.).
   - For Notion: mcp__notion__get_page to capture the current page.
   - For GitHub: mcp__github__get_issue to capture the issue's body,
     state, labels.

3. Write the captured state as JSON to: ${actionDir}/remote-state.json
   Include enough fields that a future restore subagent could recreate
   the state (title, body, author, timestamps, IDs, parent IDs, etc.).

4. recovery_commands MUST reverse the EFFECT of the action, not merely
   undo the UI interaction or summarize what happened. Decide the
   action's direction and record the true inverse:
   - DESTRUCTIVE (delete/close/remove/archive): recovery RE-CREATES the
     destroyed state. Example for a deleted post: "Use the Playwright
     MCP to log in as the same user, navigate to the submit page, and
     create a text post with title=<X>, body=<Y> from
     remote-state.json. Report the new post's URL."
   - CONSTRUCTIVE (create/submit/send/post/add — e.g. clicking a Post
     button that publishes a new post, create_page, send_message):
     recovery DELETES/RETRACTS the entity this action created. Example
     for a post-submit: "Use the Playwright MCP to log in, locate the
     post titled <X> in forum <F>, open it, and click delete." Merely
     resetting or clearing the form is NOT valid recovery — once the
     post exists the form fields are irrelevant; the post itself must
     be removed.
   - MUTATING (edit/update/rename): recovery RESTORES the prior content
     captured in remote-state.json.
   Capture in remote-state.json whatever locator a future restore needs
   to act on the created/changed entity (title, URL, id, parent id).

5. live_restore: true for this category — the recovery needs a fresh
   restore subagent (it'll execute MCP calls, not shell commands).

If the MCP doesn't expose a clean read-side counterpart, do your best:
take a screenshot, save the DOM, save the URL. Always emit a JSON
file even if it only contains the URL and a "manual recovery needed"
note — having SOMETHING beats having nothing.

### Category E: Anything else
Do your best to capture some recoverable state in ${actionDir}, or document clearly what cannot be recovered.

## OUTPUT FORMAT

Your result is a single JSON object with this exact shape:

{"description":"...","backup_commands":["cmd1","cmd2"],"recovery_commands":["cmd1","cmd2"],"artifact_paths":["path1"],"live_restore":false}

- description: short human-readable summary
- backup_commands: the commands you ACTUALLY RAN to create the backup
- recovery_commands: commands that would reverse the upcoming action (these will be executed verbatim by chats-sandbox restore)
- artifact_paths: files you created inside the backup storage directory
- live_restore: true ONLY when the recovery_commands can't be trusted later because the target state is remote or dynamic — e.g. the upcoming action does a git push (remote history moves), a curl POST/PUT/DELETE to an external API, a docker push to a registry, a kubectl apply to a cluster, a production DB write, etc. In those cases chats-sandbox will spawn a fresh restore subagent instead of replaying your commands blindly. For local file writes (Category A), pip/npm installs (Category C), env mutations (Category D), set live_restore=false.

## HOW THE RESULT IS COLLECTED — IMPORTANT

As your VERY LAST step, WRITE that JSON object to this exact file path:

  ${actionDir}/subagent_result.json

This file is the authoritative way chats-sandbox reads your result —
stdout is NOT reliably parsed (it may contain UI formatting). Write
the file with the bash tool or a write-file tool. Also print the JSON
to stdout as a fallback, but the file is what matters.

CRITICAL:
- DO NOT execute the upcoming action. You only create the backup.
- Actually run your backup_commands with the bash tool. Don't just describe them.
- The LAST thing you do is write ${actionDir}/subagent_result.json.
- Keep the final JSON under 2KB.`;
}

/** Validate + normalize a candidate object into our SubagentResponse
 *  shape, or null if it doesn't match. Module-scoped so both the
 *  result-file reader and the stdout parser can use it. */
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
      live_restore: typeof c.live_restore === "boolean" ? c.live_restore : undefined,
    };
  }
  return null;
}

/** Read the subagent's result from the canonical handoff file the
 *  prompt instructs it to write. Far more robust than parsing stdout —
 *  required for the hermes runner whose stdout is TUI-decorated.
 *  Returns null if the file is missing or malformed. */
function readSubagentResultFile(actionDir: string): SubagentResponse | null {
  try {
    const f = path.join(actionDir, "subagent_result.json");
    if (!fs.existsSync(f)) return null;
    return extractOurShape(JSON.parse(fs.readFileSync(f, "utf-8")));
  } catch {
    return null;
  }
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
  actionDir: string,
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

  const prompt = buildSubagentPrompt(ctx, actionDir);
  const timeoutMs = Math.max(10_000, config.subagentTimeoutSeconds * 1000);

  // Build the runner invocation — claude -p or hermes chat — see
  // buildSubagentInvocation. Returns null when the runner's CLI is
  // missing, in which case we skip the backup (graceful degradation).
  const invocation = buildSubagentInvocation(prompt, config);
  if (!invocation) {
    const runner = config.subagentRunner ?? "claude";
    logDebug(`skipped: ${runner} CLI not found in PATH`);
    if (config.verbose) {
      process.stderr.write(`[CHATS-Sandbox] subagent skipped: ${runner} CLI not found\n`);
    }
    return null;
  }
  const { bin, args } = invocation;

  logDebug(`invoking: ${bin} [runner=${invocation.runner}] [prompt=${prompt.length} chars] ${args.filter((a) => a !== prompt).join(" ")} (timeout=${timeoutMs}ms)`);

  // Tell the user what we're about to do — claude -p can take 5-30s and
  // there's otherwise no signal that anything is happening.
  const cmdPreview = String(ctx.tool_input.command ?? "")
    || String(ctx.tool_input.path ?? ctx.tool_input.file_path ?? "");
  const modelLabel = invocation.runner === "hermes"
    ? (config.subagentHermesModel || "hermes")
    : config.subagentModel;
  tellUser(
    `[CHATS-Sandbox] Out-of-workspace action detected. Invoking ${modelLabel} subagent to back up... ` +
    `(${ctx.tool_name}${cmdPreview ? `: ${cmdPreview.slice(0, 60)}` : ""})`
  );

  const startTime = Date.now();
  let stdout = "";
  let stderr = "";
  try {
    // Use execFileSync — avoids shell parsing of the prompt argument
    const { execFileSync } = require("node:child_process");
    stdout = execFileSync(bin, args, {
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

  // Prefer the canonical result file the subagent was told to write —
  // robust regardless of stdout format (the hermes runner's stdout is
  // TUI-decorated and not cleanly parseable). Fall back to stdout
  // parsing for older subagents / the claude runner's JSON wrapper.
  const fileResult = readSubagentResultFile(actionDir);
  if (fileResult) logDebug("result read from subagent_result.json");
  const parsed = fileResult ?? parseSubagentOutput(stdout);
  if (!parsed) {
    logDebug(`parse failed (no subagent_result.json, stdout unparseable). Raw stdout was: ${stdout.slice(0, 2000)}`);

    // Detect permission denial (subagent couldn't run bash) and warn clearly
    if (stdout.includes("permission_denials") || stdout.includes("permission denied") ||
        stdout.includes("approval is needed") || stdout.includes("cannot proceed")) {
      logDebug("DIAGNOSIS: subagent was denied tool permissions despite bypass flag. " +
        "This usually means a stale `claude` CLI version — upgrade and retry.");
      tellUser(
        "[CHATS-Sandbox] Subagent could not run backup commands (tool permission denied). " +
        "Upgrade the `claude` CLI (npm i -g @anthropic-ai/claude-code) or set " +
        "subagentPermissionMode=acceptEdits for filesystem-only backups."
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
  const artifactFile = path.join(actionDir, `subagent_${id}.json`);
  fs.mkdirSync(actionDir, { recursive: true });
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
    liveRestore: parsed.live_restore ?? false,
    originalAction: `${ctx.tool_name}(${String(ctx.tool_input.command ?? JSON.stringify(ctx.tool_input)).slice(0, 200)})`,
  };
}

/**
 * Spawn a fresh `claude -p` subagent to perform a restore. Used when
 * an artifact was tagged `liveRestore: true` by the backup subagent
 * (i.e. the canned recovery_commands can't be trusted — remote state,
 * dynamic systems). The subagent reads live state and runs whatever
 * commands it decides are needed.
 *
 * Returns { success, detail }. `detail` contains either the result
 * text (on success) or the error message (on failure).
 *
 * Mirrors the subprocess setup of runSubagentBackup:
 *   - scratch cwd to escape project .claude/settings.json deny rules
 *   - CHATS_SANDBOX_NO_HOOK=1 to prevent hook recursion
 *   - --dangerously-skip-permissions for the bypass path
 *   - timeout from config.subagentTimeoutSeconds
 */
export function invokeRestoreSubagent(
  prompt: string,
  config: SandboxConfig,
): { success: boolean; detail: string } {
  const timeoutMs = Math.max(10_000, config.subagentTimeoutSeconds * 1000);

  // Same runner branching as the backup path — claude -p or hermes chat.
  const invocation = buildSubagentInvocation(prompt, config);
  if (!invocation) {
    const runner = config.subagentRunner ?? "claude";
    return { success: false, detail: `${runner} CLI not found in PATH` };
  }
  const { bin, args } = invocation;

  const modelLabel = invocation.runner === "hermes"
    ? (config.subagentHermesModel || "hermes")
    : config.subagentModel;
  tellUser(
    `[CHATS-Sandbox] Live-restore: invoking ${modelLabel} subagent to reverse remote/dynamic state...`,
  );

  try {
    const { execFileSync } = require("node:child_process");
    const stdout: string = execFileSync(bin, args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      env: { ...process.env, CHATS_SANDBOX_NO_HOOK: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });

    // Extract the result text from the claude -p JSON wrapper for display.
    let detail = stdout.slice(0, 500);
    try {
      const wrapper = JSON.parse(stdout);
      if (wrapper && typeof wrapper === "object") {
        const result = (wrapper as Record<string, unknown>).result;
        if (typeof result === "string") detail = result.slice(0, 500);
      }
    } catch {
      // raw stdout is fine
    }
    return { success: true, detail };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, detail: msg.slice(0, 500) };
  }
}
