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
import { execSync } from "node:child_process";
import type { BackupArtifact, HookContext, SandboxConfig } from "../types.js";
import { runSubagentBackup } from "./subagent.js";

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
  return fs
    .readdirSync(backupRoot)
    .filter((d: string) => d.startsWith("action_"))
    .sort();
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
        "node_modules/", ".git/", "dist/", "build/", "__pycache__/",
        "*.pyc", ".env", ".env.*", ".venv/", "venv/", ".cache/",
        ".chats-sandbox/",
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

  const freeze = exec("pip freeze 2>/dev/null || pip3 freeze 2>/dev/null");
  if (!freeze) return null;

  fs.writeFileSync(dest, freeze + "\n", "utf-8");
  return {
    id,
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: "Saved pip freeze snapshot",
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
 * Inspect the tool call arguments to determine if the action might
 * affect state outside the current workspace.
 *
 * Returns true if:
 *   - Any explicit file path in the args is outside cwd
 *   - The command pattern is known to affect system/global state
 *     (pip install, apt install, npm -g, git push, export, etc.)
 */
function touchesOutsideWorkspace(ctx: HookContext): boolean {
  const workspace = path.resolve(process.cwd());
  const toolName = ctx.tool_name;
  const input = ctx.tool_input;

  // Check explicit file paths in tool args
  const pathArgs = [
    input.path, input.file_path, input.target, input.destination,
  ].filter(Boolean).map((p) => String(p));

  for (const p of pathArgs) {
    try {
      const resolved = path.resolve(p);
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
      /\bdocker\s+(run|stop|rm|build|push)/i,   // container state
      /\bkubectl\s+(apply|delete|create)/i,     // k8s state
      /\bsystemctl\s+(start|stop|restart|enable|disable)/i, // services
      /\bexport\s+\w+=/i,                       // env vars
      /\bunset\s+\w+/i,                         // env vars
      /\bsource\s+/i,                           // shell config
    ];

    for (const pattern of outsidePatterns) {
      if (pattern.test(cmd)) return true;
    }

    // Check if any absolute path in the command is outside workspace
    const absolutePaths = cmd.match(/\/[\w./-]+/g) ?? [];
    for (const p of absolutePaths) {
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
        // ignore
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
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"]);

export function runBackup(
  ctx: HookContext,
  config: SandboxConfig
): BackupResult {
  // Read-only tools (Read/Glob/Grep/etc.) can't mutate anything, so
  // there's nothing to back up. Short-circuit cleanly so they don't
  // pay the git-ls-tree cost and don't create folders when nothing
  // actually happened.
  if (READ_ONLY_TOOLS.has(ctx.tool_name)) {
    return { artifacts: [], needsSubagent: false };
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
  const { applyPolicyRules } = require("./policy_rules.js");
  const pendingDir = path.join(path.resolve(config.backupDir), _pendingActionName ?? "");
  const trashDir = path.join(pendingDir, "trash");
  const policyResult = applyPolicyRules(ctx, trashDir);
  if (policyResult) {
    const dir = materializeActionDir(config);
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
      originalAction: `${ctx.tool_name}(${String(ctx.tool_input.command ?? "").slice(0, 200)})`,
    };
    result.artifacts.push(artifact);
    result.updatedInput = policyResult.updatedInput;
    writeMetadata(dir, artifact);
    return result;
  }

  const outsideWorkspace = touchesOutsideWorkspace(ctx);

  // ── 2nd level: git add -A (runs first because it's the cheap check) ──
  // If the workspace hasn't changed, this returns null and no folder is made.
  const gitSnapshot = gitSnapshotBackup(ctx, config);
  if (gitSnapshot) {
    const dir = materializeActionDir(config);
    result.artifacts.push(gitSnapshot);
    writeMetadata(dir, gitSnapshot);
  }

  // ── 1st level: targeted manifest (runs second, supplements git snapshot) ─
  // Only relevant for known patterns. Materializes folder only if it fires.
  const targetedFn = () => {
    const dir = materializeActionDir(config);
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

    // Try to invoke the real subagent via `claude -p` subprocess.
    // The subagent is SYNCHRONOUS — blocks until it produces an artifact
    // or hits the timeout. Safe to run here because we're already inside
    // the PreToolUse hook, which blocks the parent tool call.
    //
    // Import lazily to avoid loading child_process for the common path.
    let subagentArtifact: BackupArtifact | null = null;
    if (config.subagentEnabled) {
      try {
        // Materialize the folder so the subagent has somewhere to write
        const dir = materializeActionDir(config);
        subagentArtifact = runSubagentBackup(ctx, dir, config);
        if (subagentArtifact) {
          result.artifacts.push(subagentArtifact);
          writeMetadata(dir, subagentArtifact);
        }
      } catch (e) {
        if (config.verbose) {
          process.stderr.write(
            `[CHATS-Sandbox] subagent invocation error: ${e}\n`
          );
        }
      }
    }

    // If the subagent failed or is disabled, still signal the caller
    // that out-of-workspace state is at risk.
    if (!subagentArtifact) {
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
      entries = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch {
      entries = [];
    }
  }

  entries.push(artifact);
  fs.writeFileSync(metaPath, JSON.stringify(entries, null, 2) + "\n", "utf-8");
}
