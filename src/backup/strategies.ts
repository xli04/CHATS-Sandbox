/**
 * Backup strategies — tiered approach for minimal recovery artifacts.
 *
 * Priority (cheapest first):
 *   1st: Targeted manifest — pip freeze, npm list, env snapshot, git tag
 *        Saves a recipe/pointer, not the actual files. Tiny storage.
 *   2nd: git add -A in shadow repo — full workspace snapshot.
 *        Git compression + deduplication makes this space-efficient.
 *   3rd: Subagent (configured in hooks as "type": "agent") —
 *        Only when 1st and 2nd both failed or don't apply (e.g. remote actions).
 *        Handled outside this module by the hook layer.
 *
 * Folder structure:
 *   .chats-sandbox/backups/
 *     action_001_20260410_1906/
 *       pip_freeze_abc123.txt        ← 1st level
 *       git_snapshot/                ← 2nd level (shadow repo)
 *       metadata.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

/** Expand a leading `~`/`~/` to the home directory before resolving, so
 *  a Write/Edit to `~/.bashrc` resolves to the real (outside-workspace)
 *  path instead of `<cwd>/~/.bashrc` (which looked in-workspace). */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
import type { BackupArtifact, HookContext, SandboxConfig } from "../types.js";
import { describeToolAction } from "../types.js";
import { runSubagentBackup } from "./subagent.js";
import {
  serverFromToolName,
  experienceNameForServer,
  matchPattern,
  loadExperiences,
  experiencesDir,
} from "../explore/experiences.js";
import { isDangerousRecoveryCommand } from "../restore/restore.js";

// ── Action folder management (LAZY) ─────────────────────────────

// _pendingActionId holds the name of the NEXT action to create
// if a backup actually happens. _currentActionDir is only populated
// AFTER we create a real artifact (lazy creation).
let _pendingActionName: string | null = null;
let _currentActionDir: string | null = null;
let _currentActionId: string | null = null;

/**
 * Prepare a pending action name. The folder is NOT created yet —
 * it will only be created if a backup artifact is actually produced.
 */
function preparePendingAction(config: SandboxConfig): string {
  if (_pendingActionName) return _pendingActionName;

  const backupRoot = path.resolve(config.backupDir);
  const existing = listActionDirs(backupRoot);
  // Use (max existing seq) + 1 rather than existing.length + 1 so that
  // after pruning we don't reuse a seq number that still exists on disk
  // (e.g. 5 actions pruned to 3 would have picked seq=4 while an action_004
  // already survived). Seq is display-only and it's fine for it to skip
  // numbers after pruning — what matters is uniqueness and monotonic
  // growth so users can reason about "newer" vs "older".
  let maxSeq = 0;
  for (const d of existing) {
    const n = parseInt(d.split("_")[1] ?? "0", 10);
    if (!isNaN(n) && n > maxSeq) maxSeq = n;
  }
  const seq = String(maxSeq + 1).padStart(3, "0");
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  _pendingActionName = `action_${seq}_${ts}`;
  return _pendingActionName;
}

/**
 * Actually create the action folder on disk. Called only when we
 * know we have something to back up. Idempotent.
 */
function materializeActionDir(config: SandboxConfig): string {
  if (_currentActionDir && fs.existsSync(_currentActionDir)) {
    return _currentActionDir;
  }

  const backupRoot = path.resolve(config.backupDir);
  if (!fs.existsSync(backupRoot)) {
    fs.mkdirSync(backupRoot, { recursive: true });
  }

  const dirName = _pendingActionName ?? preparePendingAction(config);
  const dirPath = path.join(backupRoot, dirName);
  fs.mkdirSync(dirPath, { recursive: true });

  _currentActionDir = dirPath;
  _currentActionId = dirName;

  // Copy the user's current instruction (if any) into the action folder.
  // The instruction is set by the UserPromptSubmit hook into a sidecar
  // file at .chats-sandbox/current-instruction.txt — multiple actions
  // from the same user prompt all read the same instruction.
  try {
    const sandboxDir = path.dirname(backupRoot);
    const currentInstructionPath = path.join(sandboxDir, "current-instruction.txt");
    if (fs.existsSync(currentInstructionPath)) {
      const text = fs.readFileSync(currentInstructionPath, "utf-8");
      fs.writeFileSync(path.join(dirPath, "instruction.txt"), text, "utf-8");
    }
  } catch {
    // best-effort
  }

  pruneActions(backupRoot, config);

  return dirPath;
}

export function resetAction(): void {
  _pendingActionName = null;
  _currentActionDir = null;
  _currentActionId = null;
}

export function getCurrentActionId(): string | null {
  return _currentActionId;
}

function listActionDirs(backupRoot: string): string[] {
  if (!fs.existsSync(backupRoot)) return [];
  // Sort by NUMERIC seq, not lexically: a plain .sort() puts
  // action_1000 before action_999, so "oldest first" inverts at seq
  // ≥ 1000 and count/size pruning would evict the NEWEST action (incl.
  // the one just created). Tie-break on the timestamp suffix.
  const seqOf = (d: string): number => {
    const n = parseInt(d.split("_")[1] ?? "", 10);
    return Number.isNaN(n) ? -1 : n;
  };
  return fs
    .readdirSync(backupRoot)
    .filter((d: string) => d.startsWith("action_"))
    .sort((a, b) => seqOf(a) - seqOf(b) || a.localeCompare(b));
}

/**
 * Prune old action folders according to the three retention knobs:
 *   1. maxAgeHours    — drop anything older than this (if > 0)
 *   2. maxActions     — keep newest N folders (if > 0)
 *   3. maxTotalSizeMB — drop oldest until total size ≤ cap (if > 0)
 *
 * A knob set to 0 is disabled. Folders are listed chronologically
 * (oldest first) because names start with `action_NNN_<timestamp>`.
 */
function pruneActions(backupRoot: string, config: SandboxConfig): void {
  let dirs = listActionDirs(backupRoot);

  // 1. Age-based pruning
  if (config.maxAgeHours > 0) {
    const cutoffMs = Date.now() - config.maxAgeHours * 3600 * 1000;
    const kept: string[] = [];
    for (const d of dirs) {
      const ts = parseActionTimestamp(d);
      if (ts !== null && ts < cutoffMs) {
        removeDir(path.join(backupRoot, d));
      } else {
        kept.push(d);
      }
    }
    dirs = kept;
  }

  // 2. Count-based pruning
  if (config.maxActions > 0) {
    while (dirs.length > config.maxActions) {
      const oldest = dirs.shift()!;
      removeDir(path.join(backupRoot, oldest));
    }
  }

  // 3. Size-based pruning (most expensive — do it last, and only on what survived)
  if (config.maxTotalSizeMB > 0) {
    const capBytes = config.maxTotalSizeMB * 1024 * 1024;
    const sizes = dirs.map((d) => ({ name: d, size: dirSize(path.join(backupRoot, d)) }));
    let total = sizes.reduce((sum, s) => sum + s.size, 0);
    while (total > capBytes && sizes.length > 0) {
      const oldest = sizes.shift()!;
      removeDir(path.join(backupRoot, oldest.name));
      total -= oldest.size;
    }
  }
}

function removeDir(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** Parse the YYYYMMDDHHMMSS timestamp out of an `action_NNN_<ts>` folder name. */
function parseActionTimestamp(dirName: string): number | null {
  const parts = dirName.split("_");
  const ts = parts.slice(2).join("_");
  if (ts.length < 14) return null;
  // ts is like 20260418103022 (local time). Parse as UTC-ish; the exact
  // zone doesn't matter for relative age checks.
  const y = parseInt(ts.slice(0, 4), 10);
  const mo = parseInt(ts.slice(4, 6), 10) - 1;
  const d = parseInt(ts.slice(6, 8), 10);
  const h = parseInt(ts.slice(8, 10), 10);
  const mi = parseInt(ts.slice(10, 12), 10);
  const s = parseInt(ts.slice(12, 14), 10);
  if ([y, mo, d, h, mi, s].some(Number.isNaN)) return null;
  return new Date(y, mo, d, h, mi, s).getTime();
}

/** Recursively sum file sizes under a directory. Exported for the
 *  dashboard and CLI status reporting. */
export function dirSize(p: string): number {
  let total = 0;
  const walk = (q: string): void => {
    try {
      const entries = fs.readdirSync(q, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(q, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          try { total += fs.statSync(full).size; } catch { /* */ }
        }
      }
    } catch {
      // best-effort
    }
  };
  walk(p);
  return total;
}

// ── Shared shadow git repo ───────────────────────────────────────────

/**
 * Single shared shadow git repo for the whole project. All snapshots
 * are commits in this one repo, which means:
 *   - Git deduplication across all actions (space-efficient)
 *   - A snapshot is only created if there are actual changes
 *   - Diffing between any two actions is a native git diff
 */
function getSharedShadowRepo(config: SandboxConfig): string {
  const backupRoot = path.resolve(config.backupDir);
  return path.join(path.dirname(backupRoot), "shadow-repo");
}

function ensureSharedShadowRepo(config: SandboxConfig): string {
  const shadowDir = getSharedShadowRepo(config);
  if (fs.existsSync(path.join(shadowDir, "HEAD"))) {
    return shadowDir;
  }

  fs.mkdirSync(shadowDir, { recursive: true });
  const cwd = process.cwd();
  const env = { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: cwd };
  const execOpts = { encoding: "utf-8" as const, timeout: 30_000, env, cwd };

  try {
    execSync("git init", { ...execOpts, stdio: "pipe" });
    execSync('git config user.email "chats-sandbox@local"', { ...execOpts, stdio: "pipe" });
    execSync('git config user.name "CHATS-Sandbox"', { ...execOpts, stdio: "pipe" });

    const infoDir = path.join(shadowDir, "info");
    fs.mkdirSync(infoDir, { recursive: true });
    fs.writeFileSync(
      path.join(infoDir, "exclude"),
      [
        // NOTE: .env / .env.* are intentionally NOT excluded — they are
        // the file class users most want recoverable, an Edit/Write of
        // .env is in-workspace (no tier-3) with no Bash command (no
        // tier-1 manifest), so the shadow snapshot is the ONLY tier that
        // can capture their pre-state. The shadow repo is local under
        // .chats-sandbox and never pushed, so capturing secrets there is
        // no more exposed than the working file itself.
        "node_modules/", ".git/", "dist/", "build/", "__pycache__/",
        "*.pyc", ".venv/", "venv/", ".cache/",
        ".chats-sandbox/",
        // Agent/harness infra dirs — never part of the user's project, and
        // (for the multi-method comparison harness) the OTHER methods' stores.
        ".hermes/", ".baseline/", ".native/", ".cpall/",
        // Playwright-MCP transient scratch (page-*.yml / console-*.log) — the
        // browser tool writes these into cwd on almost EVERY browser action, so
        // without this exclude tier-2 git-snapshot commits them on every step
        // and manufactures a spurious "backup" per browser call (not the user's
        // state, and not a logical backup).
        ".playwright-mcp/", "page-*.yml", "console-*.log", "traces/",
        ".DS_Store", "Thumbs.db",  // macOS/Windows filesystem noise
      ].join("\n") + "\n",
      "utf-8"
    );
  } catch {
    // best-effort init
  }

  return shadowDir;
}

// ── Shell helper ─────────────────────────────────────────────────────

function exec(cmd: string, cwd?: string): string | null {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: 15_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 8);
}

// =====================================================================
// 1st Level: Targeted manifests (cheapest — saves recipes, not files)
// =====================================================================

function pipFreezeBackup(
  actionDir: string,
  ctx: HookContext
): BackupArtifact | null {
  const id = makeId();
  const dest = path.join(actionDir, `pip_freeze_${id}.txt`);

  // Try multiple pip invocations. Environments vary: some have `pip` only,
  // some `pip3` only, some only `python3 -m pip`. Previously we used a
  // shell one-liner with `|| pip3 freeze` which doesn't trigger if pip
  // is present but fails for another reason (e.g. missing packages).
  // This explicit ladder is more reliable and produces an empty file
  // (still an artifact!) when no pip is available — the action folder
  // gets materialized, tier-3 is skipped, and restore can no-op.
  const candidates = [
    "pip freeze",
    "pip3 freeze",
    "python3 -m pip freeze",
    "python -m pip freeze",
  ];
  let freeze = "";
  let source = "";
  for (const cmd of candidates) {
    const out = exec(`${cmd} 2>/dev/null`);
    if (out !== null) {
      freeze = out;
      source = cmd;
      break;
    }
  }

  // If nothing produced output, still materialize an empty manifest. This
  // is deliberate: the pattern matched (pip install) so tier-1 owns the
  // action, and producing an empty manifest signals "we tried but there
  // was no pre-existing package set to record." Prevents tier-3 subagent
  // from firing redundantly on pip install in a fresh Python env.
  fs.writeFileSync(dest, freeze + "\n", "utf-8");
  return {
    id,
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: source
      ? `Saved pip freeze snapshot (${source})`
      : "Saved empty pip freeze (no pip on PATH)",
    strategy: "pip_freeze",
    artifactPath: dest,
    sizeBytes: Buffer.byteLength(freeze),
  };
}

function npmListBackup(
  actionDir: string,
  ctx: HookContext
): BackupArtifact | null {
  const id = makeId();
  const dest = path.join(actionDir, `npm_list_${id}.json`);

  const list = exec("npm list --json --depth=0 2>/dev/null");
  if (!list) return null;

  fs.writeFileSync(dest, list + "\n", "utf-8");
  return {
    id,
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: "Saved npm package list snapshot",
    strategy: "npm_list",
    artifactPath: dest,
    sizeBytes: Buffer.byteLength(list),
  };
}

function envSnapshotBackup(
  actionDir: string,
  ctx: HookContext
): BackupArtifact | null {
  const id = makeId();
  const dest = path.join(actionDir, `env_snapshot_${id}.txt`);

  const env = exec("env | sort");
  if (!env) return null;

  fs.writeFileSync(dest, env + "\n", "utf-8");
  return {
    id,
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: "Saved environment variable snapshot",
    strategy: "env_snapshot",
    artifactPath: dest,
    sizeBytes: Buffer.byteLength(env),
  };
}

function gitTagBackup(
  ctx: HookContext,
  actionDir: string
): BackupArtifact | null {
  const head = exec("git rev-parse HEAD");
  if (!head) return null;

  const id = makeId();
  const tagName = `chats-sandbox/pre-${ctx.tool_name.toLowerCase()}-${id}`;

  const result = exec(`git tag ${tagName}`);
  if (result === null) return null;

  fs.writeFileSync(
    path.join(actionDir, `git_tag_${id}.txt`),
    `tag: ${tagName}\ncommit: ${head}\n`,
    "utf-8"
  );

  return {
    id,
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: `Created git tag ${tagName} at ${head.slice(0, 8)}`,
    strategy: "git_tag",
    artifactPath: tagName,
  };
}

/**
 * Try the cheapest targeted manifest for the given command.
 * Returns the artifact if a targeted strategy matched, null otherwise.
 */
function tryTargetedManifest(
  ctx: HookContext,
  actionDir: string
): BackupArtifact | null {
  const command = String(ctx.tool_input.command ?? "");

  // pip install/uninstall → save package list
  if (/pip3?\s+(install|uninstall)/i.test(command)) {
    return pipFreezeBackup(actionDir, ctx);
  }

  // npm install/uninstall → save package list
  if (/npm\s+(install|uninstall|remove)/i.test(command)) {
    return npmListBackup(actionDir, ctx);
  }

  // env/export changes → save env vars
  if (/\b(export|unset|source\s+\.env)/i.test(command)) {
    return envSnapshotBackup(actionDir, ctx);
  }

  // git push/rebase/reset → create a tag (pointer to current HEAD)
  if (/git\s+(push|rebase|reset|commit\s+--amend)/i.test(command)) {
    return gitTagBackup(ctx, actionDir);
  }

  return null;
}

// =====================================================================
// 2nd Level: git add -A snapshot in SHARED shadow repo
// =====================================================================

/**
 * Commit to the shared shadow repo only if there are actual changes
 * since the last commit. Returns null if the workspace is unchanged
 * (this is how we skip snapshots for read-only actions automatically).
 */
function gitSnapshotBackup(
  ctx: HookContext,
  config: SandboxConfig
): BackupArtifact | null {
  const shadowDir = ensureSharedShadowRepo(config);
  const cwd = process.cwd();
  const env = { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: cwd };
  const execOpts = { encoding: "utf-8" as const, timeout: 30_000, env, cwd };

  try {
    execSync("git add -A", { ...execOpts, stdio: "pipe" });

    // Check if there are staged changes vs the previous commit.
    // If the repo has no commits yet, there's always "changes" to commit.
    let hasChanges = false;
    try {
      execSync("git rev-parse HEAD", { ...execOpts, stdio: "pipe" });
      // Repo has at least one commit — compare against HEAD
      const diffResult = execSync(
        "git diff --cached --quiet || echo CHANGES",
        { ...execOpts, stdio: "pipe" }
      );
      hasChanges = diffResult.includes("CHANGES");
    } catch {
      // No HEAD yet (first commit). Check if there's anything staged at all.
      const status = execSync("git status --porcelain", { ...execOpts, stdio: "pipe" });
      hasChanges = status.trim().length > 0;
    }

    // REMOTE actions (MCP / browser) never need a WORKSPACE snapshot — their
    // effect lives in a remote system (captured by the subagent tier, or
    // nothing for a read), and any workspace "drift" they leave is just the
    // browser tool's transient scratch (.playwright-mcp/, console/page logs).
    // Skip tier-2 ENTIRELY for them — regardless of drift — so we don't
    // manufacture a git_snapshot folder per browser call (the dominant "storm"
    // cause). If the action is backup-worthy the subagent materializes its own
    // folder. (Previously this only fired when there was no drift, so scratch
    // files slipped a spurious snapshot through on nearly every browser call.)
    if (ctx.tool_name.startsWith("mcp__") || /(^|_)browser_[a-z]/.test(ctx.tool_name)) {
      return null;
    }

    if (!hasChanges) {
      // Workspace hasn't drifted since the last snapshot. But the
      // UPCOMING tool call may still be a write, so we need an artifact
      // that records "this action's pre-state" — otherwise the action
      // folder never gets materialized and the action is silently
      // untracked (no way to restore). Return a pointer artifact that
      // references the current HEAD; all the pre-state this action
      // would need is already stored there from the previous action.
      let head = "";
      try {
        head = execSync("git rev-parse HEAD", { ...execOpts, stdio: "pipe" }).trim();
      } catch {
        // No HEAD yet AND no changes → truly empty repo, nothing to snapshot.
        return null;
      }
      if (!head) return null;
      return {
        id: head.slice(0, 8),
        timestamp: new Date().toISOString(),
        trigger: "rule",
        toolName: ctx.tool_name,
        description: `git add -A snapshot (pointer → ${head.slice(0, 8)}, no workspace drift since previous action)`,
        strategy: "git_snapshot",
        artifactPath: shadowDir,
        commitHash: head,
      };
    }

    const reason = `before ${ctx.tool_name}`;
    execSync(`git commit -m "${reason}" --allow-empty-message`, {
      ...execOpts,
      stdio: "pipe",
    });

    const hash = execSync("git rev-parse HEAD", { ...execOpts, stdio: "pipe" }).trim();

    return {
      id: hash.slice(0, 8),
      timestamp: new Date().toISOString(),
      trigger: "rule",
      toolName: ctx.tool_name,
      description: `git add -A snapshot (${hash.slice(0, 8)})`,
      strategy: "git_snapshot",
      artifactPath: shadowDir,
      commitHash: hash,
    };
  } catch {
    return null;
  }
}

// =====================================================================
// Workspace scope detection
// =====================================================================

/**
 * MCP tool names that are known to be read-only. Inverted denylist:
 * any `mcp__*` tool that DOESN'T match these patterns is assumed to
 * mutate state we can't capture locally and triggers tier-3 backup.
 *
 * Rationale: hardcoding a write-allowlist is unbounded (every new MCP
 * server invents verbs). Hardcoding a read-only-denylist is bounded
 * because MCP tools generally follow consistent naming conventions for
 * read-style ops: get_*, list_*, search_*, fetch_*, read_*, view_*,
 * describe_*, inspect_*, show_*, *_navigate, *_snapshot, *_screenshot,
 * etc.
 *
 * False positive (read flagged as write): user pays a few cents for a
 *   subagent fire that captures nothing useful.
 * False negative (write flagged as read): user loses remote state
 *   silently. Strictly worse — that's why we bias toward "treat
 *   unknown MCP verbs as writes."
 */
/**
 * True for a browser-automation tool surfaced under a BARE name —
 * `browser_click`, `browser_navigate`, etc. OpenHands registers
 * Playwright-MCP tools this way (no `mcp__` prefix), as does Hermes's
 * built-in browser toolset. These mutate remote page state and must be
 * treated like `mcp__*` browser tools for tier-3 detection.
 */
function isBareBrowserTool(toolName: string): boolean {
  return /^browser_/.test(toolName);
}

// A mutating verb in an MCP tool's action segment → NOT read-only. Module-
// scoped so the per-server Non-Backup-ToolList guard in isBackupWorthyRemote
// can reuse the exact same vocabulary as the hardcoded isReadOnlyMcpTool check.
const MUTATING_VERB = /(^|_)(create|delete|update|remove|insert|drop|truncate|purge|ack|acknowledge|replace|write|set|post|put|send|publish|destroy|kill|cancel|revoke|grant|upsert|patch|rename|merge|install|uninstall|close|submit|clear|reset|flush|move|edit|modify)(_|$)/i;

export function isReadOnlyMcpTool(toolName: string): boolean {
  // Accept both `mcp__*` tools and bare `browser_*` tools (OpenHands /
  // Hermes name Playwright-MCP browser tools without the prefix).
  if (!toolName.startsWith("mcp__") && !isBareBrowserTool(toolName)) return false;

  // The verb lives in the FINAL `__` segment (`mcp__server__get_foo` →
  // `get_foo`; bare `browser_click` → `browser_click`). Anchoring here
  // stops a read word in the server name from masking a mutating action.
  const action = toolName.split("__").pop() || toolName;

  // A mutating verb ANYWHERE in the action overrides a leading read verb.
  // Without this, compound names like `get_and_delete`, `read_and_ack`,
  // `list_and_purge`, `update_status`, `find_and_replace` were classified
  // read-only and silently skipped backup (the unsafe failure direction).
  // (MUTATING_VERB is module-scoped — see above.)
  if (MUTATING_VERB.test(action)) return false;

  // Read-style verbs in the action segment.
  const READ_VERB = /(^|_)(get|list|search|fetch|read|view|describe|inspect|show|status|count|find|query|history|info|head|peek)(_|$)/i;
  if (READ_VERB.test(action)) return true;

  // Browser verbs that don't mutate page state (Playwright-MCP / Hermes's
  // `browser` toolset). NOTE: `install` and `close` were removed — they
  // mutate (install a browser / change tab state) and are now caught above.
  // `fill`/`fill_form`/`type`/`select_option` ENTER data but don't COMMIT
  // it — the commit is a later Submit/Save *click*. Treating form input as
  // read-only stops every login/search box from firing a browser subagent;
  // the mutating click that follows is what gets backed up (see
  // isMutatingBrowserClick / touchesOutsideWorkspace).
  const BROWSER_READ = /(^|_)(navigate|navigate_back|snapshot|screenshot|take_screenshot|console_messages|network_requests|wait_for|resize|tabs|scroll|hover|fill|fill_form|type|select_option|drag)(_|$)/i;
  if (BROWSER_READ.test(action)) return true;

  return false;
}

/** Browser actuation tools whose mutating-ness depends on WHAT is clicked,
 *  not the tool name (the same `browser_click` clicks a nav link or a
 *  "Submit" button). */
function isBrowserActuationTool(toolName: string): boolean {
  const action = (toolName.split("__").pop() || toolName).toLowerCase();
  return action === "browser_click" || action === "click";
}

// Affordances that COMMIT state — a click on one of these is worth a backup.
const MUTATING_AFFORDANCE =
  /\b(submit|create|post|publish|save|delete|remove|discard|subscribe|unsubscribe|join|leave|follow|unfollow|vote|upvote|downvote|reply|comment|edit|update|send|confirm|apply|add|upload|sticky|lock|ban|message|sign\s?up|register|checkout|buy|order|pay|reserve|accept|approve|reject|merge|deploy)\b/i;
// IRREVERSIBLE verbs — the backup-worthy floor for REMOTE actions under the
// principle "back up iff, without a backup, the action becomes irreversible".
// Includes data destruction, state overwrite, and resource creation (you need
// the new entity's identity to undo it) + irreversible commits. EXCLUDES
// reversible toggles (vote/subscribe/follow/like/star/pin/save-bookmark/join/
// close/enable…) — those have an always-available live inverse, so they cost
// no backup (and, per the chosen policy, are simply not undone on restore).
// NOTE: nouns that double as verbs ("comment", "message") are deliberately
// EXCLUDED — they collide with reversible toggles on the same object ("like
// comment", "flag message"). Comment/message CREATION is caught by the verbs
// add/reply/post/submit/send instead.
const IRREVERSIBLE_VERB =
  /\b(delete|remove|destroy|drop|truncate|erase|wipe|purge|clear|edit|update|overwrite|replace|modify|rename|save|create|add|insert|post|submit|publish|upload|send|write|append|import|reply|buy|order|pay|checkout|purchase|charge|transfer|deploy|release|push)\b/i;
// DESTRUCTIVE verbs — always back up, even rendered as a link (some apps
// delete via an <a>). These override the link-is-navigation rule below.
const STRONG_MUTATING =
  /\b(delete|remove|destroy|ban|purge|drop|truncate|wipe|erase|deactivate|revoke)\b/i;
// Affordances that only NAVIGATE / read — a click here changes nothing
// persistent (login, links, pagination, sort/filter, expand/collapse,
// dropdown options…).
const READ_AFFORDANCE =
  /\b(log\s?in|sign\s?in|log\s?out|sign\s?out|back|forward|next|prev|previous|home|page|pagination|tab|sort|filter|search|browse|view|expand|collapse|show\s?more|load\s?more|read\s?more|see\s?more|menu|breadcrumb|scroll|hover|open|close|dismiss|cancel|option|combobox|dropdown|listbox|checkbox|radio|spinbutton|slider)\b/i;

/** Classify a browser CLICK by the affordance described in its args.
 *  destructive → back up; a LINK navigates (skip); other mutating verb →
 *  back up; navigation/login/read → skip; unknown → back up (safe). */
export function isMutatingBrowserClick(input: Record<string, unknown>): boolean {
  const desc = String(
    input.element ?? input.text ?? input.selector ?? input.ref ?? input.name ?? ""
  ).toLowerCase();
  if (STRONG_MUTATING.test(desc)) return true;
  // A LINK navigates — it does not commit state. Postmill's top-nav
  // "Submit" is a <a> to the compose form, NOT the post commit (that's a
  // "Create submission" <button>). So skip links unless destructive above.
  if (/\blink\b/.test(desc)) return false;
  if (MUTATING_AFFORDANCE.test(desc)) return true;
  if (READ_AFFORDANCE.test(desc)) return false;
  return true; // unknown affordance → escalate (don't silently skip a mutation)
}

/**
 * REMOTE actions (MCP + browser tools) use a backup-worthy ALLOWLIST: only
 * actions that look consequential are backed up; navigation, reads, and
 * unknown UI are ignored. This is the inverse of the local default (which
 * stays "escalate unless known-safe"). Local actions never reach here.
 *
 * Order matters — most reliable signal first:
 *   read-verb name     → MCP get/list/view → ignore
 *   destructive verb   → back up (floor; no learned entry may suppress it;
 *                        scans tool name + UI fields AND the executable
 *                        payloads — sql/command/query — so a DELETE/DROP on
 *                        a never-explored server is still covered)
 *   PER-SERVER learned → judge against THIS server's lists only:
 *                        Non-Backup-ToolList (read-only tool NAMES) → ignore;
 *                        Backup-patterns (triggers over the payload) → back up
 *   FALLBACK (no profile / no match): LINK → ignore; mutating verb → back up;
 *                        otherwise → ignore (allowlist default)
 */
function isBackupWorthyRemote(ctx: HookContext, config?: SandboxConfig): boolean {
  const toolName = ctx.tool_name;
  const input = (ctx.tool_input ?? {}) as Record<string, unknown>;

  // A SQL/query arg is NOT special-cased — its text is part of rawDesc below,
  // scanned by the destructive floor (STRONG_MUTATING) and by that server's
  // learned Backup-patterns.

  // Arbitrary-code browser tools (browser_run_code_unsafe, browser_evaluate,
  // *_evaluate) carry their real action in a `code`/`function` arg, NOT the
  // tool name — and the name has no mutating verb, so the allowlist default
  // below would wrongly IGNORE them and skip backup. Inspect the code: if it
  // performs a mutating page action it's backup-worthy; if we can't see the
  // code, ESCALATE (arbitrary JS can mutate anything — a missed mutation is
  // unrecoverable, a wasted spawn on a pure read is cheap).
  const _action = (toolName.split("__").pop() || toolName).toLowerCase();
  if (/run_code|evaluate/.test(_action)) {
    const code = String(input.code ?? input.function ?? input.expression ?? "");
    if (!code) return true;
    return /\.(fill|click|type|press|check|uncheck|select_?option|set_?input_?files|tap|drag_?to|set_?checked|clear)\s*\(|\.submit\s*\(|get_?by\w*\([^)]*\)\s*\.\s*(click|fill|check|press|type|select)/i.test(code);
  }

  // Hardcoded read-verb tool-name skip (applies to any tool, learned or not).
  if (toolName.startsWith("mcp__") && isReadOnlyMcpTool(toolName)) return false;

  // Normalize `_` → ` ` so verbs in tool names match word-boundary regexes
  // (`create_page` → `create page`; `\bcreate\b` matches only after this).
  const desc = [
    toolName, input.element, input.text, input.selector, input.name,
  ].filter(Boolean).map(String).join(" ").toLowerCase().replace(/_/g, " ");
  // Raw text (incl. command/sql/query) for the learned keyword matchers.
  const rawDesc = [
    toolName, input.element, input.text, input.selector, input.name,
    input.command, input.sql, input.query,
  ].filter(Boolean).map(String).join(" ").toLowerCase();

  // Destructive floor: a clearly destructive op ALWAYS backs up — no learned
  // entry may suppress it (learned data is attacker-influenceable). Tested
  // against BOTH strings: `desc` catches verbs in tool names / UI fields
  // (underscores normalized, so `delete_file` matches), `rawDesc` catches
  // verbs inside executable payloads (sql/command/query) so a DELETE / DROP /
  // TRUNCATE on a never-explored server is still covered. rawDesc is NOT
  // underscore-normalized, so identifiers like `dropped_items` cannot trip
  // the \b-bounded verbs; a bare floor verb in a read-only query's string
  // literal is the accepted (backup-only-direction) false positive.
  if (STRONG_MUTATING.test(desc) || STRONG_MUTATING.test(rawDesc)) return true;

  // ── PER-SERVER learned judgment (primary path): map the action to its server
  //    and judge ONLY against THAT server's lists, in this fixed order:
  //      1. Non-Backup-ToolList (read-only tools) → skip
  //      2. Reverter check (a creation-only pattern with a deterministic
  //         reverter) → back up via the cheap no-agent path
  //      3. Backup-patterns → back up
  //    (There is deliberately NO keyword-level suppress step: the only learned
  //    negative signal is the read-only TOOL list above, which is validated
  //    against the live tool surface. A learned keyword that silently skipped
  //    backups was the poisoning-prone direction and nothing emits it anymore.)
  //    Anything matching none falls through to the fallback, whose default for
  //    remote actions is NON-backup. ──
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { serverFromToolName, experienceNameForServer, serverMatchers, matchPattern } =
      require("../explore/experiences.js");
    const server = config ? serverFromToolName(toolName) : null;
    const expName = server ? experienceNameForServer(config, server) : null;
    if (expName) {
      const m = serverMatchers(config, expName);
      const lc = toolName.toLowerCase();
      const seg = lc.split("__").pop() || lc;
      // 1. Non-Backup-ToolList — guarded so a mutating-named tool is never cleared.
      if ((m.readOnlyTools.has(lc) || m.readOnlyTools.has(seg)) && !MUTATING_VERB.test(seg)) return false;
      // 2. Reverter check — a matched creation-only pattern carrying a
      //    deterministic reverter is backup-worthy via the no-agent create path
      //    (tryPatternCreateReverter applies it). Checked BEFORE the pattern
      //    gate so a create is never dropped just because its trigger keyword
      //    did not fire on rawDesc.
      const pat = matchPattern(config, expName, toolName, rawDesc);
      if (pat?.reverter) return true;
      if (m.triggerRegex && m.triggerRegex.test(rawDesc)) return true;   // 3. Backup-patterns
    }
  } catch { /* fall through to the generic verb-list fallback */ }

  // ── FALLBACK (no server / no experience profile / matched none of the
  //    three): the generic verb-list heuristic. ──
  if (/\blink\b/.test(desc)) return false;
  // `desc` (underscore-normalized) catches verbs in the tool name / UI fields.
  if (IRREVERSIBLE_VERB.test(desc)) return true;
  // The executable PAYLOAD (sql / query) also carries the verb — WITHOUT this,
  // an UPDATE / INSERT / REPLACE through an unknown-verb MCP tool on an
  // unexplored server escaped backup entirely. But scan it with QUOTED STRING
  // LITERALS BLANKED: a SQL verb is always a keyword OUTSIDE quotes, so
  // stripping literals loses no real mutation while dropping the broad-verb
  // false positives IRREVERSIBLE_VERB would otherwise hit inside read-query
  // literals (`SELECT 'please add later'`, `SELECT 'call center'`). The narrow
  // destructive FLOOR above deliberately keeps its literal FP (safety net);
  // this softer fallback is made precise. sql/query only (never desc/element)
  // so a browser nav click's label can't fire it.
  const sqlPayload = [input.sql, input.query].filter(Boolean).map(String).join(" ").toLowerCase();
  const sqlNoLiterals = sqlPayload.replace(/'[^']*'/g, "' '").replace(/"[^"]*"/g, '" "');
  if (sqlNoLiterals && (IRREVERSIBLE_VERB.test(sqlNoLiterals) ||
      // SQL-specific mutations absent from IRREVERSIBLE_VERB (MERGE / UPSERT /
      // GRANT / VACUUM / REINDEX / CLUSTER / REFRESH / CALL / LOAD / COMMENT ON).
      /\b(merge|upsert|grant|vacuum|reindex|cluster|refresh|call|load|comment\s+on)\b/.test(sqlNoLiterals))) {
    return true;
  }
  return false; // reversible toggle / unknown / read → ignore (allowlist default)
}

/**
 * Inspect the tool call arguments to determine if the action might
 * affect state outside the current workspace.
 *
 * Returns true if:
 *   - Any explicit file path in the args is outside cwd
 *   - The command pattern is known to affect system/global state
 *     (pip install, apt install, npm -g, git push, export, etc.)
 *   - The tool is an MCP tool that isn't recognized as read-only
 */
export function touchesOutsideWorkspace(ctx: HookContext, config?: SandboxConfig): boolean {
  const workspace = path.resolve(process.cwd());
  const toolName = ctx.tool_name;
  const input = ctx.tool_input;

  // MCP tools: unless we recognize the verb as read-only, assume the
  // action mutates remote state we can't capture locally. This fires
  // the tier-3 subagent, which can use the same MCP to scrape the
  // pre-state and record recovery instructions.
  // ── REMOTE actions (MCP + browser tools): backup-worthy ALLOWLIST ──
  // Only consequential actions (learned triggers, or a generic mutating
  // verb) are backed up; navigation, reads, and unknown UI are ignored —
  // no wasted subagent spawn. The LOCAL out-of-workspace branches below
  // (file paths, Bash) are UNCHANGED: they keep the "escalate unless
  // known-safe" default. The allowlist is scoped to the MCP/browser surface
  // the exploration actually learned.
  if (isBrowserActuationTool(toolName) || toolName.startsWith("mcp__")) {
    // ABLATION KNOB: CHATS_SANDBOX_NAIVE_GATE=1 models the NO-KNOWLEDGE
    // baseline — no learned triggers, no floor, no verb heuristics. Escalate
    // every remote action the hardcoded read-only NAME filter can't clear and
    // let the backup subagent judge (its prompt already allows returning
    // no_backup_needed:true, handled as a clean read-only skip). Fail-safe but
    // expensive: unknown-verb tools (execute_sql) spawn on every call incl.
    // reads — the cost the learned gate exists to remove.
    if (process.env.CHATS_SANDBOX_NAIVE_GATE === "1") {
      return !isReadOnlyMcpTool(toolName);
    }
    return isBackupWorthyRemote(ctx, config);
  }

  // Check explicit file paths in tool args
  const pathArgs = [
    input.path, input.file_path, input.target, input.destination,
  ].filter(Boolean).map((p) => String(p));

  for (const p of pathArgs) {
    try {
      const resolved = path.resolve(expandHome(p));
      if (!resolved.startsWith(workspace + path.sep) && resolved !== workspace) {
        return true; // Path is outside workspace
      }
    } catch {
      // ignore unresolvable paths
    }
  }

  // For Bash commands, check patterns known to affect outside-workspace state
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "");

    const outsidePatterns = [
      /\bpip3?\s+(install|uninstall)/i,        // system/venv packages
      /\bnpm\s+(install|uninstall)\s+-g/i,      // global node packages
      /\bapt(-get)?\s+(install|remove|purge)/i, // system packages
      /\bbrew\s+(install|uninstall|remove)/i,   // homebrew
      /\bgit\s+(push|fetch|pull|remote)/i,      // remote git state
      /\bcurl\s+.*-X\s*(POST|PUT|DELETE|PATCH)/i, // remote API mutation
      /\bwget\s/i,                              // network download
      /\bssh\s/i,                               // remote commands
      /\bscp\s/i,                               // remote file copy
      /\bdocker\s+(run|stop|rm|build|push|cp|kill|restart|commit)/i, // container state
      // (DB-client MUTATION is handled separately below as TWO independent
      // linear tests — a single `client[\s\S]*verb` regex backtracks
      // quadratically on a large no-verb command, freezing this synchronous
      // gate.)
      /\bkubectl\s+(apply|delete|create|patch|replace|scale|edit|drain|cordon|rollout|set|annotate|label|taint)\b/i, // k8s state
      /\bsystemctl\s+(start|stop|restart|enable|disable)/i, // services
      /\bexport\s+\w+=/i,                       // env vars
      /\bunset\s+\w+/i,                         // env vars
      /\bsource\s+/i,                           // shell config
      // Cloud / IaC CLIs — remote infra state git cannot capture. These
      // previously fell through the allowlist entirely (fail-open).
      /\b(aws|gcloud|az|doctl|ibmcloud)\s/i,    // cloud provider CLIs
      /\b(terraform|pulumi|terragrunt)\s+(apply|destroy|import|state|up)\b/i, // IaC
      /\bhelm\s+(install|uninstall|upgrade|rollback|delete)\b/i, // k8s charts
      /\bgh\s+(repo|release|secret|api|pr|issue|gist|workflow|run)\b/i, // GitHub API
      /\bdocker\s+(exec|volume|network|system|compose)\b/i, // docker beyond the basic verbs
      // Package managers beyond pip/npm-g/apt/brew — write outside the workspace.
      /\b(cargo|go|gem|pipx|conda|mamba|poetry|pnpm|bundle)\s+(install|add|remove|uninstall|get)\b/i,
      /\byarn\s+global\s+(add|remove)\b/i,
      /\b(dnf|yum|apk|pacman|zypper|snap)\s+(install|remove|add|erase|delete)\b/i,
      /\b(make|ninja)\s+install\b/i,
      /\bpython3?\s+setup\.py\s+install\b/i,
      // Identity / scheduling / system writes.
      /\bcrontab\b/i,                           // scheduled jobs
      /\b(chsh|usermod|useradd|userdel|groupadd|passwd)\b/i, // accounts
      // Network mutation the curl `-X` pattern misses, plus other transports.
      /\bcurl\s+[\s\S]*(--request\s+(POST|PUT|DELETE|PATCH)|--data\b|--data-raw\b|-d\s|-T\s|--upload-file\b)/i,
      /\b(rsync|sftp|nc|ncat|telnet|ftp)\s/i,   // remote transports
    ];

    for (const pattern of outsidePatterns) {
      if (pattern.test(cmd)) return true;
    }

    // DB-client MUTATION (direct or via `docker exec`/`ssh`): the remote DB is
    // outside-workspace state git can't capture. TWO independent tests (a DB
    // client token AND a mutating verb, anywhere in the command) instead of
    // one `client[\s\S]*verb` regex — the combined form backtracks O(n²) on a
    // large no-verb command (e.g. a 100KB `psql -c "SELECT …"`) and this gate
    // runs synchronously on every tool call. Both halves are linear. Verb list
    // is a SUPERSET (a missed mutation is unrecoverable; a wasted spawn on a
    // read-shaped `COPY (SELECT…) TO` is cheap). A read-only SELECT/\dt/SHOW
    // has a client token but no verb → does not escalate.
    if (/\b(psql|mysql|mariadb|mongo|mongosh|redis-cli|sqlite3)\b/i.test(cmd) &&
        (/\b(delete|update|drop|truncate|insert|alter|replace|upsert|merge|grant|revoke|call|load|reindex|cluster|vacuum|refresh|rename|create|comment\s+on|flushall|flushdb|hset|hdel|lpush|rpush|sadd|zadd|expire|copy)\b/i.test(cmd) ||
         /\\copy/i.test(cmd))) {
      return true;
    }

    // Scan for absolute paths outside the workspace. The one token we
    // must NOT count is the interpreter/executable being RUN: its
    // install path (e.g. /opt/conda/bin/python) is a read, not a
    // mutation, and counting it fired a tier-3 subagent on every
    // conda/venv command (the SWE-bench pytest 774s pathology).
    //
    // We exclude only that single token, and only when it is an
    // absolute path whose basename is a known language runtime. We do
    // this per command segment, splitting on &&/||/|/;/&/newline and
    // skipping any leading NAME=value env-assignments to find the real
    // argv[0]. EVERYTHING ELSE is still scanned — redirection targets
    // (`>/etc/x`), env-assignment values (`DEST=/etc/x …`), script
    // args, paths inside quotes (`python -c "open('/etc/x','w')"`),
    // and bare non-interpreter executables (`/usr/local/bin/reset.sh`)
    // — so genuine outside writes still fire. The heuristic keeps its
    // bias toward over-firing (slow but safe) over under-firing
    // (silent unrecoverable state): only a recognized interpreter at
    // argv[0] is ever skipped.
    const INTERPRETER = /^(?:python[0-9.]*|node|nodejs|ts-node|tsx|deno|bun|ruby|perl|php|bash|sh|dash|zsh|fish|java|Rscript|pytest)$/;
    const isOutside = (token: string): boolean => {
      // Require ≥2 path segments: single-segment tokens like "/retries"
      // are almost always sed/awk substitution fragments, not paths.
      const paths = token.match(/\/[\w./-]+/g) ?? [];
      for (const p of paths) {
        if (p.split("/").filter(Boolean).length < 2) continue;
        try {
          const resolved = path.resolve(p);
          if (
            !resolved.startsWith(workspace + path.sep) &&
            resolved !== workspace &&
            !resolved.startsWith("/dev/") &&
            !resolved.startsWith("/proc/") &&
            !resolved.startsWith("/tmp/")
          ) {
            return true;
          }
        } catch {
          // ignore unresolvable
        }
      }
      return false;
    };

    for (const seg of cmd.split(/(?:&&|\|\||[|;&\n])/)) {
      const tokens = seg.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;
      // Skip leading env-assignments (NAME=value) to locate argv[0].
      let ai = 0;
      while (ai < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[ai])) ai++;
      const argv0 = tokens[ai];
      const argv0IsInterpreter =
        !!argv0 && argv0.startsWith("/") &&
        INTERPRETER.test(argv0.split("/").pop() ?? "");
      for (let j = 0; j < tokens.length; j++) {
        if (j === ai && argv0IsInterpreter) continue; // skip interpreter exe
        if (isOutside(tokens[j])) return true;
      }
    }
  }

  return false;
}

// =====================================================================
// Main dispatcher
// =====================================================================

export interface BackupResult {
  /** Artifacts created (may be multiple) */
  artifacts: BackupArtifact[];
  /** Whether a subagent should be called as 3rd level */
  needsSubagent: boolean;
  /** Reason the subagent is needed */
  subagentReason?: string;
  /** When a tier-0 policy rule rewrote the command, this is the new
   *  tool_input the hook should return as updatedInput. Undefined when
   *  no rewrite happened. */
  updatedInput?: Record<string, unknown>;
  /** Folder of the action recorded for this backup (when one was
   *  created) — lets the hook attach action-level records such as the
   *  added-latency timing. */
  actionDir?: string;
}

/**
 * Run backup strategies in priority order:
 *   1st: Targeted manifest (pip freeze, npm list, git tag, env snapshot)
 *   2nd: git add -A in SHARED shadow repo (only commits if workspace changed)
 *   3rd: Subagent needed — when action touches outside workspace AND
 *        no targeted manifest covered it.
 *
 * Action folders are created LAZILY — only if a real artifact is produced.
 * Read-only actions produce no artifact → no folder → no noise.
 */
/** Tools that never modify state — they don't need backup at all. */
const READ_ONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite",
  // Harness-internal tools that don't touch the user's project state.
  // ToolSearch is the deferred-tool fetcher in Claude Code; it never
  // modifies anything in /app or on disk.
  "ToolSearch",
]);

/**
 * Pure-introspection Bash patterns: commands that read state and print it,
 * but never mutate. We recognize a conservative set — all common and
 * unambiguously safe. If any pattern matches, the hook short-circuits
 * the same way a READ_ONLY_TOOLS entry does: no backup attempted, no
 * tier-3 subagent, no action folder.
 *
 * Designed to prevent false positives on commands like:
 *   which python3        (looks at PATH, modifies nothing)
 *   ls /usr/bin          (reads a directory)
 *   cat file.txt         (reads file contents)
 *   stat -c %a file      (reads metadata)
 *   command -v git       (shell builtin introspection)
 *
 * The pattern is anchored at the START of the command after optional
 * whitespace, so `echo foo > bar` (redirection = write) won't match.
 * Compound commands (pipes, `&&`, `;`, subshells) skip this check and
 * fall through to the full backup pipeline — safer default.
 */
const READ_ONLY_BASH_PATTERN = new RegExp(
  "^\\s*(?:" +
    "which|command\\s+-v|type(?:\\s+-[aPpt]+)?|" +       // what-is
    "ls(?:\\s+-[a-zA-Z]*)?|stat|file|readlink|realpath|dirname|basename|" +  // fs introspection
    "cat|head|tail|wc|grep|egrep|fgrep|zcat|zgrep|" +  // read contents
    // NB: sed and awk are deliberately NOT here. Both are general-purpose
    // interpreters that can WRITE files (sed `w`/`W`/`s///w`, awk
    // `print > f`) or EXECUTE shell (sed `e`/`s///e`, awk `system()`)
    // from inside their quoted script — invisible to a top-level
    // redirect/operator check. Treat every sed/awk as back-up (the only
    // cost is an occasional unnecessary snapshot for a read-only one).
    "pwd|id|whoami|groups|uname|date|echo|printf|true|false|" +  // environmental (date mutating forms bailed below; hostname removed — `hostname NAME` sets it)
    "cd|pushd|popd|" +                                   // directory nav — changes cwd only, no file mutation
    "printenv|locale|" +                                 // env vars (read). NB: `env` removed — `env <prog>` launches an arbitrary command (env rm -rf …) that the trailing-args group would swallow.
    "ps|top|df|du(?:\\s+-[a-zA-Z]+)*\\s*$|free|uptime|" + // sysinfo (du without target is no-op)
    "git\\s+(?:status|log|show|diff|branch\\s*$|remote\\s*$|config\\s+--get|rev-parse|ls-(?:files|tree|remote)|describe|blame|cat-file)|" +  // git read-only
    "pip(?:3)?\\s+(?:list|show|freeze|check)|" +         // pip introspection (list/show/freeze/check)
    "npm\\s+(?:list|ls|view|show|search|outdated|root|config\\s+get)|" +  // npm read-only
    "docker\\s+(?:ps|images|inspect|logs|version|info|stats|top|events|history|port)|" +  // docker read-only
    "kubectl\\s+(?:get|describe|logs|version|config\\s+view|cluster-info|explain)" +  // kubectl read-only
    // `python -c "import X"` and `node -e "require(x)"` were allowlisted
    // as import-checks but both EXECUTE arbitrary code: `import
    // sitecustomize` runs module top-level, `require('/repo/x')` runs that
    // module, and the quoted body can construct a writer with no quote/
    // operator the pre-checks see (require('fs').writeFileSync(
    // String.fromCharCode(...))). Removed — interpreters always back up,
    // like sed/awk/env.
  ")" +
  "(?:\\s+[^\\|;&>]*)?" +    // trailing args — but stop at | ; & > (those imply side effects)
  "\\s*$"
);

export function isReadOnlyBash(command: string): boolean {
  if (!command) return false;
  // Redirections (`> f`, `>> f`), process/command substitution (`<(…)`,
  // `$(…)`) and backticks can WRITE files or hide a mutation inside an
  // expansion — never claim read-only when any are present.
  if (/>>?|<\(|\$\(|`/.test(command)) return false;
  // Newline / carriage-return are command separators we do NOT split on
  // below — a second line could be anything (`ls\nrm -rf /`). Bail.
  if (/[\n\r]/.test(command)) return false;
  // A leading env-assignment (`FOO=bar cmd`) or `env NAME=VAL cmd` runs
  // an arbitrary following command while the allowlisted verb gets
  // swallowed as args (`env FOO=bar rm -rf /` matched `env` + args).
  // Bail on any assignment at command/segment start or after `env`.
  if (/(?:^|[;&|]|\benv\s)\s*\w+=/.test(command)) return false;
  // Command-runner prefixes execute an arbitrary following command, so
  // the read-only verb that would otherwise match is irrelevant — bail.
  // (`env` is already removed from the allowlist, but `env rm`, `nice
  // rm`, `sudo tee`, `xargs rm`, `timeout 5 rm`, `nohup rm` etc. must
  // never be classified read-only.)
  if (/(?:^|[;&|]\s*)(?:env|sudo|doas|nice|ionice|chrt|nohup|setsid|stdbuf|unbuffer|timeout|xargs|time|watch|exec|eval|command|builtin)\b/.test(command)) {
    return false;
  }
  // A compound command (`cd /repo && git log`, `grep x | head`) is
  // read-only IFF EVERY segment is. The old code bailed on the first
  // `&`/`;`/`|` it saw, so the extremely common `cd DIR && <read>` was
  // treated as a possible mutation — over-firing tier-2 snapshots and,
  // when it also tripped the outside-workspace heuristic, a ~30s tier-3
  // subagent. We split on the shell operators and require each part to
  // be a recognized read-only command. Unknown segment → not read-only
  // → falls through to backup (the SAFE direction: a real mutation is
  // never wrongly skipped, we only stop over-firing on benign reads).
  const segments = command.split(/&&|\|\||[;|]/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => {
    if (!READ_ONLY_BASH_PATTERN.test(seg)) return false;
    // Per-segment guards for allowlisted verbs that read in their bare
    // form but MUTATE with a flag/arg — scoped to the segment so an
    // unrelated read elsewhere (`ls -s && date`) isn't penalized:
    //   `date … -s|--set … ` (anywhere in args) or `date <digits>` sets
    //   the system clock; a `--output=FILE` / `-O FILE` write flag
    //   (e.g. `git diff --output=x`) writes a file with no shell redirect.
    // date SET forms (set the system clock): `-s` alone or with a glued
    // value (`-s now`, `-snow`, `-s2020`), optionally bundled after the
    // no-arg short options -u/-R (`-us`, `-Rs`, `-usnow`); `--set[=]`;
    // or a bare numeric first arg (`date 010100002020`). The `[uR]*`
    // (not `[a-zA-Z]*`) keeps `-I`/`-Iseconds`/`-Is` ISO-output READS
    // passing — `-I` absorbs its own arg and is never a set cluster.
    if (/^\s*date\b/.test(seg) && /(?:\s-[uR]*s|\s--set\b|^\s*date\s+[0-9])/.test(seg)) return false;
    if (/(?:^|\s)(?:--output(?:[=\s]|$)|-O\b)/.test(seg)) return false;
    return true;
  });
}

function recentInputPath(config: SandboxConfig): string {
  return path.join(path.dirname(path.resolve(config.backupDir)), "recent-input.json");
}

/**
 * Record the text the agent types into the browser (browser_type /
 * fill_form / fill / select_option). These actions don't back up, but the
 * VALUES they carry — a post title, a comment body — are exactly what a
 * later create/submit needs to PIN its recovery. The hook sees them; we
 * persist the last few so the backup subagent can read "what was just typed"
 * instead of re-deriving it from a live browser snapshot. Best-effort.
 */
export function recordBrowserInput(ctx: HookContext, config: SandboxConfig): void {
  try {
    const action = (ctx.tool_name.split("__").pop() || ctx.tool_name).toLowerCase();
    if (!/^browser_(type|fill_form|fill|select_option)$/.test(action)) return;
    const input = (ctx.tool_input ?? {}) as Record<string, unknown>;
    const vals: string[] = [];
    const push = (v: unknown) => { if (typeof v === "string" && v.trim() && v.length < 2000) vals.push(v.trim()); };
    push(input.text); push(input.value);
    if (Array.isArray(input.fields)) for (const f of input.fields) push((f as { value?: unknown })?.value);
    if (Array.isArray(input.values)) for (const v of input.values) push(v);
    if (!vals.length) return;
    const p = recentInputPath(config);
    let arr: { t: string; values: string[] }[] = [];
    try { arr = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /* fresh */ }
    arr.push({ t: new Date().toISOString(), values: vals });
    arr = arr.slice(-12);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(arr));
  } catch { /* best-effort — never block the action */ }
}

/** The recent typed values, newest last, deduped — for the subagent prompt. */
export function loadRecentBrowserInput(config: SandboxConfig): string[] {
  try {
    const arr = JSON.parse(fs.readFileSync(recentInputPath(config), "utf-8")) as { values: string[] }[];
    const out: string[] = [];
    for (const e of arr.slice(-8)) for (const v of (e.values ?? [])) out.push(v);
    return [...new Set(out)].slice(-10);
  } catch { return []; }
}

function recentSnapshotPath(config: SandboxConfig): string {
  return path.join(path.dirname(path.resolve(config.backupDir)), "recent-snapshot.json");
}

/**
 * Cache the agent's most recent browser PAGE VIEW (browser_snapshot/navigate).
 * Its tool_output IS the page as the agent saw it, which for an about-to-be
 * edited/deleted entity holds the PRE-state (the current field value, the post
 * body+comments). The backup subagent is then handed "WHERE THE CHANGE HAPPENS"
 * — the URL + this page state — so it (a) can't misclassify the action and
 * (b) has the original WITHOUT re-reading via its own lock-prone, costly
 * browser. TOOL-AGNOSTIC: works whether the main agent mutates via click+fill
 * or browser_run_code_unsafe — the source is the last page VIEW, not the typed
 * args (which run_code hides). Caches ONLY read-style views, NOT fill/type/
 * click (those reflect the page AFTER the edit → the new value, not the
 * original). Called from the post-tool hook (it has the tool_output). */
export function recordBrowserSnapshot(ctx: HookContext, config: SandboxConfig): void {
  try {
    const action = (ctx.tool_name.split("__").pop() || ctx.tool_name).toLowerCase();
    if (!/^browser_(snapshot|navigate|navigate_back)$/.test(action)) return;
    const out = ctx.tool_output;
    let text = typeof out === "string" ? out : "";
    if (!text && out && typeof out === "object") {
      const o = out as Record<string, unknown>;
      text = typeof o.result === "string" ? o.result
        : typeof o.content === "string" ? o.content
        : JSON.stringify(o);
    }
    if (!text || text.length < 20) return;
    const m = text.match(/Page URL:\s*(\S+)/i) || text.match(/https?:\/\/\S+/);
    const url = m ? (m[1] || m[0]) : "";
    // No truncation (owner's call): capture the FULL page so a delete's whole
    // entity (long body + comments) survives into PAGE_STATE. Prompt-token cost
    // grows with page size — revisit if it becomes a problem.
    const snippet = text;
    const p = recentSnapshotPath(config);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ t: new Date().toISOString(), url, action, text: snippet }));
  } catch { /* best-effort — never block the action */ }
}

/**
 * PRE-STATE pre-capture for opaque-code browser mutations
 * (browser_run_code_unsafe / browser_evaluate).
 *
 * The agent's JS may navigate to a value-bearing page that is loaded ONLY
 * inside the code (e.g. `await page.goto('.../account/edit_biography')`),
 * mutate it, and save. The cached snapshot is then of the page the agent was
 * ON before (e.g. /account) — which does NOT contain the about-to-change
 * value — so the backup subagent can only emit "UNVERIFIED".
 *
 * This function runs in the PRE-tool path: it parses literal URLs/paths out of
 * the code arg, fetches each page's HTML AUTHENTICATED (curl + the seeded
 * cookie jar persisted by seed_login.sh), and merges that text into the
 * recent-snapshot cache so the existing loadRecentBrowserSnapshot → PAGE_STATE
 * path surfaces the concrete original value (e.g.
 * `<textarea name="biography">t2_5adwlxvn</textarea>`).
 *
 * Best-effort: any failure (no code, no parseable URL, no cookie jar, fetch
 * error) leaves the cache untouched so the existing UNVERIFIED fallback stays
 * intact — no regression.
 */
/** Proposal B: extract a compact digest of editable form controls from fetched
 *  HTML so the subagent gets the ORIGINAL values without the multi-KB page.
 *  Node has no built-in HTML parser → robust best-effort regex extraction.
 *  Returns a compact JSON array string, or "" if no editable controls found
 *  (caller then falls back to the raw-HTML slice). */
function digestFormControls(html: string): string {
  try {
    const attr = (tagHtml: string, name: string): string | undefined => {
      const m = tagHtml.match(
        new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
      );
      if (!m) return undefined;
      return m[1] ?? m[2] ?? m[3];
    };
    const decode = (s: string): string =>
      s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    const skip = (key: string | undefined): boolean => {
      if (!key) return false;
      const k = key.toLowerCase();
      // DROP: CSRF/_token fields, search box.
      return k.includes("csrf") || k.startsWith("_") || k === "q";
    };

    const controls: Array<Record<string, string>> = [];
    const push = (tag: string, key: string | undefined, type: string | undefined, value: string) => {
      const rec: Record<string, string> = { tag };
      if (key !== undefined) rec.name = key;
      if (type !== undefined) rec.type = type;
      rec.value = value.length > 300 ? value.slice(0, 300) : value;
      controls.push(rec);
    };

    // <textarea ...>inner text</textarea>
    for (const m of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const tagAttrs = m[1];
      const key = attr(tagAttrs, "name") ?? attr(tagAttrs, "id");
      if (skip(attr(tagAttrs, "name")) || skip(attr(tagAttrs, "id"))) continue;
      push("textarea", key, undefined, decode(m[2]).trim());
    }
    // <input ...>
    for (const m of html.matchAll(/<input\b([^>]*)>/gi)) {
      const tagAttrs = m[1];
      const type = (attr(tagAttrs, "type") ?? "text").toLowerCase();
      // DROP: hidden inputs, submit/button.
      if (type === "hidden" || type === "submit" || type === "button") continue;
      const key = attr(tagAttrs, "name") ?? attr(tagAttrs, "id");
      if (skip(attr(tagAttrs, "name")) || skip(attr(tagAttrs, "id"))) continue;
      push("input", key, type, decode(attr(tagAttrs, "value") ?? ""));
    }
    // <select ...>...</select> → value = the selected option (or first).
    for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const tagAttrs = m[1];
      const key = attr(tagAttrs, "name") ?? attr(tagAttrs, "id");
      if (skip(attr(tagAttrs, "name")) || skip(attr(tagAttrs, "id"))) continue;
      const body = m[2];
      let sel = body.match(/<option\b[^>]*\bselected\b[^>]*>([\s\S]*?)<\/option>/i);
      const selTag = body.match(/<option\b[^>]*\bselected\b[^>]*>/i);
      let value = "";
      if (selTag) value = attr(selTag[0], "value") ?? (sel ? decode(sel[1]).trim() : "");
      push("select", key, undefined, value);
    }

    if (controls.length === 0) return "";
    return JSON.stringify(controls);
  } catch { return ""; }
}

export function presnapshotCodeUrls(ctx: HookContext, config: SandboxConfig): void {
  try {
    const action = (ctx.tool_name.split("__").pop() || ctx.tool_name).toLowerCase();
    if (!/run_code|evaluate/.test(action)) return;
    const input = (ctx.tool_input ?? {}) as Record<string, unknown>;
    const code = String(input.code ?? input.function ?? input.expression ?? "");
    if (!code) return;

    // Parse candidate URLs/paths from the code.
    const urls = new Set<string>();
    // page.goto('...') / page.navigate('...') first arg
    for (const m of code.matchAll(/\.(?:goto|navigate)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      urls.add(m[1]);
    }
    // bare absolute URLs
    for (const m of code.matchAll(/https?:\/\/[^\s'"`)]+/g)) urls.add(m[0]);
    // string-literal absolute paths (/user/.../account, /edit_biography, ...)
    for (const m of code.matchAll(/['"`](\/[A-Za-z0-9][^'"`\s]*)['"`]/g)) urls.add(m[1]);
    if (urls.size === 0) return;

    // Determine the base origin: prefer the first absolute URL seen, else the
    // origin of the currently cached snapshot's URL.
    let base = "";
    for (const u of urls) {
      const mm = u.match(/^(https?:\/\/[^/]+)/);
      if (mm) { base = mm[1]; break; }
    }
    if (!base) {
      const snap = loadRecentBrowserSnapshot(config, 30 * 60_000);
      const mm = snap?.url?.match(/^(https?:\/\/[^/]+)/);
      if (mm) base = mm[1];
    }

    // Resolve to absolute URLs (dedup), keep only http(s).
    const abs: string[] = [];
    for (const u of urls) {
      let full = u;
      if (!/^https?:\/\//.test(u)) {
        if (!base) continue;            // can't resolve a relative path
        full = base + (u.startsWith("/") ? u : "/" + u);
      }
      if (!abs.includes(full)) abs.push(full);
    }
    if (abs.length === 0) return;

    // Authenticated cookie jar persisted by seed_login.sh.
    const jar = process.env.SEED_COOKIE_JAR || "/tmp/wa-pw-profile/seed-cookies.txt";
    if (!fs.existsSync(jar)) return;    // no creds available → leave UNVERIFIED intact

    // Fetch each page (bounded count + size) and build a tagged blob.
    const parts: string[] = [];
    const MAX_URLS = 6;
    const MAX_BYTES = 200_000;          // per page cap to keep prompt bounded
    let captured = false;
    for (const url of abs.slice(0, MAX_URLS)) {
      try {
        const out = execSync(
          `curl -sS -L --max-time 15 -b ${JSON.stringify(jar)} ${JSON.stringify(url)}`,
          { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
        );
        if (out && out.length > 20) {
          const digest = digestFormControls(out);
          if (digest && digest.length > 2) {
            // Proposal B: compact editable-form-control digest (old values),
            // bounded ≤~1.5 KB, instead of the raw HTML.
            const blob = digest.length > 1500 ? digest.slice(0, 1500) : digest;
            parts.push(`\nPRE-CAPTURED FORM CONTROLS (authenticated GET) ${url} = ${blob}`);
            captured = true;
          } else {
            // FALLBACK: no editable controls (e.g. a delete-confirm page) →
            // keep today's length-capped raw-HTML slice so non-form pages still
            // get a usable pre-state.
            const body = out.length > MAX_BYTES ? out.slice(0, MAX_BYTES) : out;
            parts.push(`\n===== PRE-CAPTURED PAGE (authenticated GET) ${url} =====\n${body}`);
            captured = true;
          }
        }
      } catch { /* skip this URL */ }
    }
    if (!captured) return;

    // Merge into the recent-snapshot cache that feeds PAGE_STATE. Augment the
    // existing snapshot's text (keep what the agent saw) and tag the action so
    // the subagent treats this as a real pre-state page view.
    const p = recentSnapshotPath(config);
    let prev: { url?: string; text?: string } = {};
    try { prev = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /* fresh */ }
    const merged = (prev.text ? prev.text + "\n" : "") + parts.join("\n");
    const urlField = prev.url || abs[0];
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      t: new Date().toISOString(),
      url: urlField,
      action: "presnapshot_code",
      text: merged,
    }));
  } catch { /* best-effort — never block the action */ }
}

/** The agent's last page view, if fresh — the subagent's PRE-state source.
 *  Returns null when none/stale so the caller fails to UNVERIFIED, not to a
 *  fabricated recovery. */
export function loadRecentBrowserSnapshot(
  config: SandboxConfig, maxAgeMs = 10 * 60_000,
): { url: string; text: string; t: string } | null {
  try {
    const s = JSON.parse(fs.readFileSync(recentSnapshotPath(config), "utf-8")) as { t: string; url: string; text: string };
    if (!s || !s.text) return null;
    const age = Date.now() - new Date(s.t).getTime();
    if (Number.isFinite(age) && age > maxAgeMs) return null;  // stale → not trustworthy pre-state
    return s;
  } catch { return null; }
}

// =====================================================================
// Tier-3 (cheap): pattern-driven MCP create reverter — a create whose learned
// pattern carries a deterministic `reverter` replays its native MCP inverse
// (e.g. create_directory -> delete_directory) at backup time, NO subagent.
// =====================================================================

/** Build the rawDesc the gate/matcher use to key learned patterns. */
function rawDescForMatch(ctx: HookContext): string {
  const input = (ctx.tool_input ?? {}) as Record<string, unknown>;
  return [
    ctx.tool_name, input.element, input.text, input.selector, input.name,
    input.command, input.sql, input.query, input.path, input.source, input.destination,
  ].filter(Boolean).map(String).join(" ").toLowerCase();
}

/**
 * Derive the MINIMAL MCP tool allowlist a capture subagent actually needs for
 * THIS action, from the learned experience — so hermes registers ~2-3 tool
 * schemas instead of the server's full list (the dominant per-call token cost).
 * Prefers the explorer's learned `capture_tools` for the matched pattern; if
 * absent, falls back to the action's own tool + a few read/snapshot tools (to
 * capture pre-state), capped at 5. Returns undefined when there's no
 * experience/match — the caller then
 * leaves the server UNFILTERED (today's safe default), so a backup never breaks.
 * GENERAL: derived from observed data, never a hardcoded per-server map.
 */
export function minimalToolAllow(ctx: HookContext, config: SandboxConfig): string[] | undefined {
  const server = serverFromToolName(ctx.tool_name);
  if (!server) return undefined;
  const expName = experienceNameForServer(config, server);
  if (!expName) return undefined;
  const exp = loadExperiences(config, expName);
  if (!exp) return undefined;
  const seg = (t: string): string => (t.split("__").pop() || t).toLowerCase();
  const pat = matchPattern(config, expName, ctx.tool_name, rawDescForMatch(ctx));

  // PREFERRED: the LEARNED minimal toolset the explorer recorded for THIS op
  // (the exact read + restore tools Stage-2 verify actually used). This list
  // IS the allowlist — used VERBATIM (already deduped + capped at parse time),
  // never re-derived and never padded with the action's own tool (the explorer
  // already chose the minimal set, e.g. [read_text_file, write_file] for an
  // edit, deliberately WITHOUT edit_file). Intersect with observed tools so a
  // hallucinated name can't poison the include set; if nothing survives, fall
  // through to the heuristic below.
  if (pat?.capture_tools && pat.capture_tools.length) {
    const observed = new Set((exp.observed_tools ?? []).map(seg));
    const learned = pat.capture_tools.filter((t) => observed.has(seg(t)));
    if (learned.length) return learned;
  }

  // FALLBACK (no learned capture_tools — e.g. an experience from before this
  // field existed): derive heuristically from the action + read tools.
  const allow = new Set<string>();
  allow.add(seg(ctx.tool_name));                       // the action's own tool
  const READ_LIKE = /(^|_)(read|get|cat|stat|info|list|search|find|show|view)(_|$)/;
  for (const t of exp.readOnlyTools ?? []) {           // read/snapshot tools (to capture pre-state)
    if (allow.size >= 5) break;
    if (READ_LIKE.test(seg(t))) allow.add(seg(t));
  }
  const out = [...allow].slice(0, 5);
  return out.length ? out : undefined;
}

/**
 * Pattern-driven CREATE reverter — the "T1/T2 for remote" cheap path. When the
 * matched learned pattern for an outside-workspace action is a CREATE that
 * carries a deterministic `reverter` (the explorer fills it ONLY for
 * create/insert/post/add/upload/new patterns), replay that fixed inverse
 * deterministically instead of paying for the capture subagent. Everything is
 * done over MCP: the inverse is a native tool call on the SAME server (e.g.
 * create_directory → delete_directory), never a local shell command.
 *
 * A create's inverse is unconditional: delete EXACTLY the entity this action
 * created, pinned by a STABLE identifier (the reverter's `pin` — an id, or a
 * unique input attribute like an exact title/key). We resolve that pinned value
 * from the already-captured typed input (the tool_input here, plus the recent
 * browser-typed values the hook persisted). If we CANNOT confidently resolve the
 * pinned value, return null and fall through to the capture subagent — we NEVER
 * guess, and NEVER target by position/recency.
 *
 * Returns a deterministic artifact (no subagent) on success, else null.
 */
export function tryPatternCreateReverter(
  ctx: HookContext,
  config: SandboxConfig,
): BackupArtifact | null {
  const server = serverFromToolName(ctx.tool_name);
  if (!server) return null;                          // not a remote/MCP action
  const expName = experienceNameForServer(config, server);
  if (!expName) return null;
  const pat = matchPattern(config, expName, ctx.tool_name, rawDescForMatch(ctx));
  const rev = pat?.reverter;
  if (!rev || !rev.pin) return null;                 // no deterministic create-inverse
  if (!(rev.commands?.length) && !(rev.mcp_calls?.length)) return null;

  // Resolve the PINNED stable identifier from already-captured typed input —
  // NEVER by position/recency. Look it up by the pin's name in the action's own
  // args first (exact key, then case-insensitive), e.g. pin "title" → input.title.
  const input = (ctx.tool_input ?? {}) as Record<string, unknown>;
  const pin = rev.pin.trim();
  const pinLc = pin.toLowerCase();
  const stringify = (v: unknown): string | null =>
    (typeof v === "string" && v.trim()) ? v.trim()
      : (typeof v === "number" || typeof v === "boolean") ? String(v) : null;
  let pinned: string | null = stringify(input[pin]);
  if (pinned === null) {
    for (const [k, v] of Object.entries(input)) {
      if (k.toLowerCase() === pinLc) { pinned = stringify(v); break; }
    }
  }
  // Browser creates carry no structured id arg — the value lives in the recently
  // typed text. Only adopt it when there is exactly ONE candidate, so we never
  // guess which typed string is the pinned identifier.
  if (pinned === null) {
    try {
      const recent = loadRecentBrowserInput(config);
      if (recent.length === 1) pinned = recent[0];
    } catch { /* optional */ }
  }
  if (pinned === null) return null;                  // unresolved → fall through to subagent

  // INJECTION GUARD: the pinned value comes from live tool_input (agent- and,
  // via prompt-injection from remote content, attacker-influenceable). It is
  // spliced verbatim into the recorded args below — for a SQL reverter that
  // means into a query STRING. A value like `x'; DROP TABLE posts; --` would
  // turn a one-row DELETE reverter into a DROP at restore. A legitimate pin is
  // a stable identifier (id, uuid, plain title) with no string-breaking chars;
  // anything with a quote / statement separator / comment marker / backslash /
  // newline is refused here and falls through to the subagent, which reverses
  // through the live MCP safely. Conservative (a title with an apostrophe also
  // falls through) but never guesses an escaping context we cannot know.
  if (/['"`;\\\n\r\x00]|--|\/\*|\*\//.test(pinned)) {
    if (config.verbose) process.stderr.write("[CHATS-Sandbox] create reverter: pin has injection-prone chars — deferring to subagent\n");
    return null;
  }

  // MCP-call inverse (preferred): substitute the pinned value into the recorded
  // args wherever the explorer left a "<...>" placeholder, then replay verbatim
  // through the SAME server via tools/call (restore.ts handles this).
  if (rev.mcp_calls?.length) {
    const fill = (v: unknown): unknown =>
      (typeof v === "string" && /<[^>]*>/.test(v)) ? v.replace(/<[^>]*>/g, pinned!) : v;
    const calls = rev.mcp_calls.map((c) => ({
      server,
      tool: c.tool,
      args: Object.fromEntries(Object.entries(c.args ?? {}).map(([k, v]) => [k, fill(v)])),
    }));
    return recordDeterministicArtifact(ctx, config, {
      recoveryMcpCalls: calls,
      description: `Deterministic create reverter (${server}): delete the created entity pinned by ${pin}=${pinned.slice(0, 80)}`,
    });
  }

  // Prose/CLI inverse: substitute the pinned value, then guard every command
  // through isDangerousRecoveryCommand.
  const cmds = rev.commands!.map((c) => c.replace(/<[^>]*>/g, pinned!));
  for (const cmd of cmds) {
    if (isDangerousRecoveryCommand(cmd)) return null; // refuse → fall through to subagent
  }
  return recordDeterministicArtifact(ctx, config, {
    recoveryCommands: cmds,
    description: `Deterministic create reverter (${server}): delete the created entity pinned by ${pin}=${pinned.slice(0, 80)}`,
  });
}

/** Materialize the action dir and write a tier-3 "subagent"-strategy artifact
 *  carrying a deterministic (no-LLM) reversal, so the existing restore path
 *  replays it WITHOUT a subagent: liveRestore:false with either recoveryCommands
 *  (local shell inverse, run via execSync) OR recoveryMcpCalls (a fixed MCP call
 *  replayed verbatim via tools/call). Exactly one is supplied. */
function recordDeterministicArtifact(
  ctx: HookContext,
  config: SandboxConfig,
  parts: {
    recoveryCommands?: string[];
    recoveryMcpCalls?: Array<{ server?: string; tool: string; args: Record<string, unknown> }>;
    description: string;
  },
): BackupArtifact {
  const dir = materializeActionDir(config);
  const artifact: BackupArtifact = {
    id: makeId(),
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: parts.description,
    strategy: "subagent",
    artifactPath: dir,
    liveRestore: false,
    originalAction: describeToolAction(ctx.tool_name, ctx.tool_input),
    ...(parts.recoveryCommands ? { recoveryCommands: parts.recoveryCommands } : {}),
    ...(parts.recoveryMcpCalls ? { recoveryMcpCalls: parts.recoveryMcpCalls } : {}),
  };
  writeMetadata(dir, artifact);
  return artifact;
}

export function runBackup(
  ctx: HookContext,
  config: SandboxConfig
): BackupResult {
  // Capture any typed input BEFORE the read-only short-circuit below — those
  // fill/type actions don't back up, but their values pin a later create.
  recordBrowserInput(ctx, config);

  // PRE-STATE pre-capture for opaque-code browser mutations: if this is a
  // browser_run_code_unsafe / browser_evaluate call, parse the URLs out of
  // the code and authenticated-GET each value-bearing page NOW (pre-mutation),
  // merging the result into the snapshot cache that feeds PAGE_STATE. Without
  // this the only cached view is the page the agent was ON before, which does
  // not hold the value the in-code navigation is about to change. Best-effort.
  try {
    const _act = (ctx.tool_name.split("__").pop() || ctx.tool_name).toLowerCase();
    if (/run_code|evaluate/.test(_act)) presnapshotCodeUrls(ctx, config);
  } catch { /* never block the action */ }

  // Read-only tools (Read/Glob/Grep/etc.) can't mutate anything, so
  // there's nothing to back up. Short-circuit cleanly so they don't
  // pay the git-ls-tree cost and don't create folders when nothing
  // actually happened.
  if (READ_ONLY_TOOLS.has(ctx.tool_name)) {
    return { artifacts: [], needsSubagent: false };
  }

  // MCP tools whose verb is recognized as read-only (browser_navigate,
  // browser_snapshot, *_get, *_list, etc.) also short-circuit. Without
  // this every Playwright snapshot/navigate in a remote-services run
  // creates a noisy action folder + git_snapshot for state that didn't
  // change.
  if (isReadOnlyMcpTool(ctx.tool_name)) {
    return { artifacts: [], needsSubagent: false };
  }

  // Bash commands that are pure introspection (which/ls/stat/git status/
  // pip list/etc.) also never mutate — same short-circuit. Without this
  // the `touchesOutsideWorkspace` heuristic can flag e.g. `which node` as
  // outside-workspace and fire a ~25 s tier-3 subagent for a command that
  // did literally nothing.
  if (ctx.tool_name === "Bash") {
    const cmd = String((ctx.tool_input as { command?: unknown }).command ?? "");
    if (isReadOnlyBash(cmd)) {
      return { artifacts: [], needsSubagent: false };
    }
  }

  // Reserve a pending action name but don't create the folder yet.
  preparePendingAction(config);
  const result: BackupResult = { artifacts: [], needsSubagent: false };

  // ── Tier 0: policy rewrite ────────────────────────────────────────
  // Destructive ops (rm, etc.) are rewritten into reversible equivalents
  // (mv to per-action trash) before the original command ever runs. Huge
  // files stay O(1) because we're just renaming inodes; no copy into the
  // shadow repo. If any rule fires, it REPLACES the rest of the pipeline
  // for this action — we don't also want tier-2 to snapshot the workspace
  // (the file is already safe in trash, and snapshot would just record
  // the trashed state).
  // CHATS_SANDBOX_NO_REWRITE=1: the host agent's hook system cannot
  // apply updatedInput (e.g. the OpenHands SDK's PreToolUse is
  // allow/deny only). Tier-0 run-and-rewrite would then execute the
  // destructive command here AND the agent would run the original a
  // second time — so skip tier-0 entirely and let tiers 1-3 cover the
  // action instead.
  const noRewrite = process.env.CHATS_SANDBOX_NO_REWRITE === "1";
  const { applyPolicyRules } = require("./policy_rules.js");
  const pendingDir = path.join(path.resolve(config.backupDir), _pendingActionName ?? "");
  const trashDir = path.join(pendingDir, "trash");
  const policyResult = noRewrite ? null : applyPolicyRules(ctx, trashDir);
  if (policyResult) {
    const dir = materializeActionDir(config);
    result.actionDir = dir;
    const artifact: BackupArtifact = {
      id: policyResult.ruleId.slice(0, 8),
      timestamp: new Date().toISOString(),
      trigger: "rule",
      toolName: ctx.tool_name,
      description: policyResult.description,
      strategy: "policy_rewrite",
      artifactPath: trashDir,
      recoveryCommands: policyResult.recoveryCommands,
      policyRuleId: policyResult.ruleId,
      originalAction: describeToolAction(ctx.tool_name, ctx.tool_input),
    };
    result.artifacts.push(artifact);
    result.updatedInput = policyResult.updatedInput;
    writeMetadata(dir, artifact);
    // Most tier-0 rewrites are self-sufficient (the file is safe in
    // trash) and terminate the pipeline. A rule may opt out via
    // preserveLowerTiers when its own recovery is partial — e.g.
    // `git reset --hard` saves the HEAD sha but the tier-2 snapshot
    // below is what captures the dirty worktree it destroys.
    if (!policyResult.preserveLowerTiers) {
      return result;
    }
  }

  const outsideWorkspace = touchesOutsideWorkspace(ctx, config);

  // ── 2nd level: git add -A (runs first because it's the cheap check) ──
  // If the workspace hasn't changed, this returns null and no folder is made.
  const gitSnapshot = gitSnapshotBackup(ctx, config);
  if (gitSnapshot) {
    const dir = materializeActionDir(config);
    result.actionDir = dir;
    result.artifacts.push(gitSnapshot);
    writeMetadata(dir, gitSnapshot);
  }

  // ── 1st level: targeted manifest (runs second, supplements git snapshot) ─
  // Only relevant for known patterns. Materializes folder only if it fires.
  const targetedFn = () => {
    const dir = materializeActionDir(config);
    result.actionDir = dir;
    return tryTargetedManifest(ctx, dir);
  };
  const command = String(ctx.tool_input.command ?? "");
  const hasTargetedPattern =
    /pip3?\s+(install|uninstall)/i.test(command) ||
    /npm\s+(install|uninstall|remove)/i.test(command) ||
    /\b(export|unset|source\s+\.env)/i.test(command) ||
    /git\s+(push|rebase|reset|commit\s+--amend)/i.test(command);

  let targetedSucceeded = false;
  if (hasTargetedPattern) {
    const targeted = targetedFn();
    if (targeted) {
      // targetedFn already materialized the dir and set result.actionDir;
      // materializeActionDir is memoized per action so this is the same
      // path, fetched here only to write the artifact's metadata.
      const dir = materializeActionDir(config);
      result.artifacts.push(targeted);
      writeMetadata(dir, targeted);
      targetedSucceeded = true;
    }
  }

  // ── 3rd level: subagent for outside-workspace state ────────────
  // Trigger when outside-workspace AND no targeted manifest succeeded.
  if (outsideWorkspace && !targetedSucceeded) {
    const cmdStr = String(ctx.tool_input.command ?? JSON.stringify(ctx.tool_input));

    // ── Tier-3 (cheap): pattern-driven MCP create reverter ────────
    // An MCP CREATE whose learned pattern carries a deterministic `reverter`
    // (delete the just-created entity, pinned by a captured stable identifier)
    // replays that fixed inverse with NO subagent — the "T1/T2 for remote" path.
    // If the pinned value can't be resolved, this returns null and we fall
    // through to the capture subagent (never a guess).
    try {
      const rev = tryPatternCreateReverter(ctx, config);
      if (rev) {
        result.actionDir = rev.artifactPath;
        result.artifacts.push(rev);
        return result;
      }
    } catch (e) {
      if (config.verbose) {
        process.stderr.write(`[CHATS-Sandbox] pattern create reverter error: ${e}\n`);
      }
      // fall through to the capture subagent
    }

    // Try to invoke the real subagent via `claude -p` subprocess.
    // The subagent is SYNCHRONOUS — blocks until it produces an artifact
    // or hits the timeout. Safe to run here because we're already inside
    // the PreToolUse hook, which blocks the parent tool call.
    //
    // Import lazily to avoid loading child_process for the common path.
    let subagentArtifact: BackupArtifact | null = null;
    let readOnlyVerdict = false;   // subagent judged the action read-only
    if (config.subagentEnabled) {
      try {
        // Materialize the folder so the subagent has somewhere to write
        const dir = materializeActionDir(config);
        result.actionDir = dir;
        // Narrow the subagent's MCP tool schema to the few tools this capture
        // needs (read pre-state + inverse), derived from the experience.
        const toolAllow = minimalToolAllow(ctx, config);
        const outcome = runSubagentBackup(ctx, dir, config, { toolAllow });
        if (outcome === "read_only") {
          // Subagent inspected the action and found it changes nothing
          // outside the workspace — a clean skip, NOT a failure. Drop
          // the empty action dir and don't raise the "unprotected"
          // warning. Tiers 0–2 already covered any workspace changes.
          readOnlyVerdict = true;
          removeDir(dir);
          result.actionDir = undefined;
        } else if (outcome) {
          subagentArtifact = outcome;
          result.artifacts.push(outcome);
          writeMetadata(dir, outcome);
        }
      } catch (e) {
        if (config.verbose) {
          process.stderr.write(
            `[CHATS-Sandbox] subagent invocation error: ${e}\n`
          );
        }
      }
    }

    // If the subagent failed or is disabled — and it did NOT explicitly
    // judge the action read-only — signal that out-of-workspace state is
    // at risk. A read-only verdict is a legitimate "nothing to back up".
    if (!subagentArtifact && !readOnlyVerdict) {
      result.needsSubagent = true;
      result.subagentReason =
        `Action "${ctx.tool_name}(${cmdStr.slice(0, 200)})" affects state outside the workspace (${process.cwd()}). ` +
        `No predefined backup strategy matched. ` +
        (gitSnapshot
          ? `Workspace files were captured via git snapshot. `
          : `No workspace changes detected. `) +
        `Subagent tier-3 backup was ${config.subagentEnabled ? "attempted but failed" : "disabled"}. ` +
        `Proceed with caution.`;
    }

    return result;
  }

  // If we have any artifact, we're done — no subagent needed.
  if (result.artifacts.length > 0) {
    return result;
  }

  // No artifact produced and no outside-workspace effect detected →
  // this was a read-only action. Return empty result silently —
  // no folder, no noise, no subagent.
  return result;
}

// ── Metadata ─────────────────────────────────────────────────────────

function writeMetadata(actionDir: string, artifact: BackupArtifact): void {
  const metaPath = path.join(actionDir, "metadata.json");
  let entries: BackupArtifact[] = [];

  if (fs.existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (Array.isArray(parsed)) {
        entries = parsed as BackupArtifact[];
      } else if (parsed && typeof parsed === "object") {
        // Salvage: wrap a stray single-object metadata into a one-element
        // array rather than nuke it. Next write will normalize it.
        entries = [parsed as BackupArtifact];
      }
      // else: primitive/null — start fresh.
    } catch {
      entries = [];
    }
  }

  entries.push(artifact);
  fs.writeFileSync(metaPath, JSON.stringify(entries, null, 2) + "\n", "utf-8");
}
