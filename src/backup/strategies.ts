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
 *     interaction_001_20260410_1906/
 *       pip_freeze_abc123.txt        ← 1st level
 *       git_snapshot/                ← 2nd level (shadow repo)
 *       metadata.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { BackupArtifact, HookContext, SandboxConfig } from "../types.js";

// ── Interaction folder management (LAZY) ─────────────────────────────

// _pendingInteractionId holds the name of the NEXT interaction to create
// if a backup actually happens. _currentInteractionDir is only populated
// AFTER we create a real artifact (lazy creation).
let _pendingInteractionName: string | null = null;
let _currentInteractionDir: string | null = null;
let _currentInteractionId: string | null = null;

/**
 * Prepare a pending interaction name. The folder is NOT created yet —
 * it will only be created if a backup artifact is actually produced.
 */
function preparePendingInteraction(config: SandboxConfig): string {
  if (_pendingInteractionName) return _pendingInteractionName;

  const backupRoot = path.resolve(config.backupDir);
  const existing = listInteractionDirs(backupRoot);
  const seq = String(existing.length + 1).padStart(3, "0");
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  _pendingInteractionName = `interaction_${seq}_${ts}`;
  return _pendingInteractionName;
}

/**
 * Actually create the interaction folder on disk. Called only when we
 * know we have something to back up. Idempotent.
 */
function materializeInteractionDir(config: SandboxConfig): string {
  if (_currentInteractionDir && fs.existsSync(_currentInteractionDir)) {
    return _currentInteractionDir;
  }

  const backupRoot = path.resolve(config.backupDir);
  if (!fs.existsSync(backupRoot)) {
    fs.mkdirSync(backupRoot, { recursive: true });
  }

  const dirName = _pendingInteractionName ?? preparePendingInteraction(config);
  const dirPath = path.join(backupRoot, dirName);
  fs.mkdirSync(dirPath, { recursive: true });

  _currentInteractionDir = dirPath;
  _currentInteractionId = dirName;

  pruneInteractions(backupRoot, config.maxInteractions);

  return dirPath;
}

export function resetInteraction(): void {
  _pendingInteractionName = null;
  _currentInteractionDir = null;
  _currentInteractionId = null;
}

export function getCurrentInteractionId(): string | null {
  return _currentInteractionId;
}

function listInteractionDirs(backupRoot: string): string[] {
  if (!fs.existsSync(backupRoot)) return [];
  return fs
    .readdirSync(backupRoot)
    .filter((d: string) => d.startsWith("interaction_"))
    .sort();
}

function pruneInteractions(backupRoot: string, max: number): void {
  const dirs = listInteractionDirs(backupRoot);
  while (dirs.length > max) {
    const oldest = dirs.shift()!;
    const fullPath = path.join(backupRoot, oldest);
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

// ── Shared shadow git repo ───────────────────────────────────────────

/**
 * Single shared shadow git repo for the whole project. All snapshots
 * are commits in this one repo, which means:
 *   - Git deduplication across all interactions (space-efficient)
 *   - A snapshot is only created if there are actual changes
 *   - Diffing between any two interactions is a native git diff
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
  interactionDir: string,
  ctx: HookContext
): BackupArtifact | null {
  const id = makeId();
  const dest = path.join(interactionDir, `pip_freeze_${id}.txt`);

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
  interactionDir: string,
  ctx: HookContext
): BackupArtifact | null {
  const id = makeId();
  const dest = path.join(interactionDir, `npm_list_${id}.json`);

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
  interactionDir: string,
  ctx: HookContext
): BackupArtifact | null {
  const id = makeId();
  const dest = path.join(interactionDir, `env_snapshot_${id}.txt`);

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
  interactionDir: string
): BackupArtifact | null {
  const head = exec("git rev-parse HEAD");
  if (!head) return null;

  const id = makeId();
  const tagName = `chats-sandbox/pre-${ctx.tool_name.toLowerCase()}-${id}`;

  const result = exec(`git tag ${tagName}`);
  if (result === null) return null;

  fs.writeFileSync(
    path.join(interactionDir, `git_tag_${id}.txt`),
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
  interactionDir: string
): BackupArtifact | null {
  const command = String(ctx.tool_input.command ?? "");

  // pip install/uninstall → save package list
  if (/pip3?\s+(install|uninstall)/i.test(command)) {
    return pipFreezeBackup(interactionDir, ctx);
  }

  // npm install/uninstall → save package list
  if (/npm\s+(install|uninstall|remove)/i.test(command)) {
    return npmListBackup(interactionDir, ctx);
  }

  // env/export changes → save env vars
  if (/\b(export|unset|source\s+\.env)/i.test(command)) {
    return envSnapshotBackup(interactionDir, ctx);
  }

  // git push/rebase/reset → create a tag (pointer to current HEAD)
  if (/git\s+(push|rebase|reset|commit\s+--amend)/i.test(command)) {
    return gitTagBackup(ctx, interactionDir);
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
      return null; // No change → no snapshot (this is the fix for read-only noise)
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
}

/**
 * Run backup strategies in priority order:
 *   1st: Targeted manifest (pip freeze, npm list, git tag, env snapshot)
 *   2nd: git add -A in SHARED shadow repo (only commits if workspace changed)
 *   3rd: Subagent needed — when action touches outside workspace AND
 *        no targeted manifest covered it.
 *
 * Interaction folders are created LAZILY — only if a real artifact is produced.
 * Read-only actions produce no artifact → no folder → no noise.
 */
export function runBackup(
  ctx: HookContext,
  config: SandboxConfig
): BackupResult {
  // Reserve a pending interaction name but don't create the folder yet.
  preparePendingInteraction(config);
  const result: BackupResult = { artifacts: [], needsSubagent: false };

  const outsideWorkspace = touchesOutsideWorkspace(ctx);

  // ── 2nd level: git add -A (runs first because it's the cheap check) ──
  // If the workspace hasn't changed, this returns null and no folder is made.
  const gitSnapshot = gitSnapshotBackup(ctx, config);
  if (gitSnapshot) {
    const dir = materializeInteractionDir(config);
    result.artifacts.push(gitSnapshot);
    writeMetadata(dir, gitSnapshot);
  }

  // ── 1st level: targeted manifest (runs second, supplements git snapshot) ─
  // Only relevant for known patterns. Materializes folder only if it fires.
  const targetedFn = () => {
    const dir = materializeInteractionDir(config);
    return tryTargetedManifest(ctx, dir);
  };
  const command = String(ctx.tool_input.command ?? "");
  const hasTargetedPattern =
    /pip3?\s+(install|uninstall)/i.test(command) ||
    /npm\s+(install|uninstall|remove)/i.test(command) ||
    /\b(export|unset|source\s+\.env)/i.test(command) ||
    /git\s+(push|rebase|reset|commit\s+--amend)/i.test(command);

  if (hasTargetedPattern) {
    const targeted = targetedFn();
    if (targeted) {
      const dir = materializeInteractionDir(config);
      result.artifacts.push(targeted);
      writeMetadata(dir, targeted);
    }
  }

  // ── 3rd level: need subagent for outside-workspace state ───────
  if (outsideWorkspace && !hasTargetedPattern) {
    const cmdStr = String(ctx.tool_input.command ?? JSON.stringify(ctx.tool_input));
    result.needsSubagent = true;
    result.subagentReason =
      `Action "${ctx.tool_name}(${cmdStr.slice(0, 200)})" affects state outside the workspace (${process.cwd()}). ` +
      `No predefined backup strategy matched. ` +
      (gitSnapshot
        ? `Workspace files were captured via git snapshot. `
        : `No workspace changes detected. `) +
      `Please create a minimal recovery artifact for the out-of-workspace state before this action executes.`;
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

function writeMetadata(interactionDir: string, artifact: BackupArtifact): void {
  const metaPath = path.join(interactionDir, "metadata.json");
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
