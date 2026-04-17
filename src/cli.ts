#!/usr/bin/env node
/**
 * CHATS-Sandbox CLI
 *
 * Commands:
 *   install     Wire hooks into .claude/settings.json
 *   uninstall   Remove hooks from .claude/settings.json
 *   config      Show / edit sandbox configuration
 *   status      Show current sandbox state (enabled, backup count, etc.)
 *   backups     List recent backup artifacts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, saveConfig, getConfigDir } from "./config/load.js";
import { loadManifest } from "./backup/manifest.js";
import { DEFAULT_CONFIG } from "./types.js";

const CLAUDE_SETTINGS_PATH = ".claude/settings.json";

// ── Helpers ──────────────────────────────────────────────────────────

function getPackageRoot(): string {
  // Resolve to the installed package's dist/ directory
  return path.resolve(__dirname);
}

function loadClaudeSettings(projectRoot: string): Record<string, unknown> {
  const p = path.join(projectRoot, CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function saveClaudeSettings(
  projectRoot: string,
  settings: Record<string, unknown>
): void {
  const dir = path.join(projectRoot, ".claude");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(projectRoot, CLAUDE_SETTINGS_PATH),
    JSON.stringify(settings, null, 2) + "\n",
    "utf-8"
  );
}

// ── Install ──────────────────────────────────────────────────────────

function install(projectRoot: string): void {
  const pkgRoot = getPackageRoot();
  const preToolPath = path.join(pkgRoot, "hooks", "pre-tool.js");
  const postToolPath = path.join(pkgRoot, "hooks", "post-tool.js");
  const userPromptPath = path.join(pkgRoot, "hooks", "user-prompt.js");

  const settings = loadClaudeSettings(projectRoot) as Record<string, unknown>;
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

  // PreToolUse hook
  hooks.PreToolUse = [
    {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: `node ${preToolPath}`,
        },
      ],
    },
  ];

  // PostToolUse hook
  hooks.PostToolUse = [
    {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: `node ${postToolPath}`,
        },
      ],
    },
  ];

  // PostToolUseFailure hook (same handler)
  hooks.PostToolUseFailure = [
    {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: `node ${postToolPath}`,
        },
      ],
    },
  ];

  // UserPromptSubmit hook — captures the user instruction so history
  // can show what they were asking for.
  hooks.UserPromptSubmit = [
    {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: `node ${userPromptPath}`,
        },
      ],
    },
  ];

  settings.hooks = hooks;

  // Deny rules — block Claude from reading/searching/writing our internal
  // state directory. The dashboard, CLI commands, and hooks all run as
  // separate processes (not as Claude) so they still have full access.
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
  const denyList = Array.isArray(permissions.deny) ? (permissions.deny as string[]) : [];
  const requiredDeny = [
    "Read(.chats-sandbox/**)",
    "Edit(.chats-sandbox/**)",
    "Write(.chats-sandbox/**)",
    "Glob(.chats-sandbox/**)",
    "Grep(.chats-sandbox/**)",
  ];
  for (const rule of requiredDeny) {
    if (!denyList.includes(rule)) denyList.push(rule);
  }
  permissions.deny = denyList;
  settings.permissions = permissions;

  saveClaudeSettings(projectRoot, settings);

  // Create default sandbox config
  const configDir = getConfigDir(projectRoot);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  saveConfig(DEFAULT_CONFIG, projectRoot);

  // Install slash commands into .claude/commands/
  const commandsSrcDir = path.join(pkgRoot, "..", "commands");
  const commandsDestDir = path.join(projectRoot, ".claude", "commands");
  if (fs.existsSync(commandsSrcDir)) {
    if (!fs.existsSync(commandsDestDir)) {
      fs.mkdirSync(commandsDestDir, { recursive: true });
    }
    const cmdFiles = fs.readdirSync(commandsSrcDir).filter((f: string) => f.endsWith(".md"));
    for (const f of cmdFiles) {
      fs.copyFileSync(path.join(commandsSrcDir, f), path.join(commandsDestDir, f));
    }
    console.log(`  Slash commands installed: ${cmdFiles.map((f: string) => "/" + f.replace(".md", "")).join(", ")}`);
  }

  // Add .chats-sandbox to .gitignore if not already there
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const gitignoreEntry = ".chats-sandbox/";
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (!content.includes(gitignoreEntry)) {
      fs.appendFileSync(gitignorePath, `\n${gitignoreEntry}\n`);
    }
  }

  console.log("CHATS-Sandbox installed successfully!");
  console.log(`  Hooks wired into ${CLAUDE_SETTINGS_PATH}`);
  console.log(`  Config at ${configDir}/config.json`);
  console.log(`  Backups will be stored in ${DEFAULT_CONFIG.backupDir}/`);
  console.log("");
  console.log("Slash commands available in Claude Code:");
  console.log("  /sandbox:status          Show sandbox state");
  console.log("  /sandbox:history         Timeline of recent actions");
  console.log("  /sandbox:restore         Reverse-loop restore");
  console.log("  /sandbox:restore_direct  Direct jump restore");
  console.log("  /sandbox:diff            Diff against action");
  console.log("  /sandbox:backups         List backup artifacts");
  console.log("  /sandbox:config          Show/edit configuration");
  console.log("  /sandbox:clear           Delete all backups and shadow repo");
  console.log("");
  console.log("To configure: chats-sandbox config");
  console.log("To disable:   chats-sandbox uninstall");
}

// ── Uninstall ────────────────────────────────────────────────────────

function uninstall(projectRoot: string): void {
  const settings = loadClaudeSettings(projectRoot) as Record<string, unknown>;
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

  // Remove our hooks (identified by the chats-sandbox command path)
  for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit"]) {
    if (Array.isArray(hooks[event])) {
      hooks[event] = (hooks[event] as unknown[]).filter((entry) => {
        const h = entry as Record<string, unknown>;
        const innerHooks = h.hooks as Array<Record<string, unknown>> | undefined;
        if (!innerHooks) return true;
        return !innerHooks.some(
          (ih) => typeof ih.command === "string" && ih.command.toLowerCase().includes("chats-sandbox")
        );
      });
      if ((hooks[event] as unknown[]).length === 0) {
        delete hooks[event];
      }
    }
  }

  settings.hooks = hooks;

  // Remove our deny rules from permissions (leave other deny rules alone)
  const permissions = settings.permissions as Record<string, unknown> | undefined;
  if (permissions && Array.isArray(permissions.deny)) {
    const ourDeny = [
      "Read(.chats-sandbox/**)",
      "Edit(.chats-sandbox/**)",
      "Write(.chats-sandbox/**)",
      "Glob(.chats-sandbox/**)",
      "Grep(.chats-sandbox/**)",
    ];
    permissions.deny = (permissions.deny as string[]).filter(
      (rule) => !ourDeny.includes(rule)
    );
    // Clean up empty deny list
    if ((permissions.deny as string[]).length === 0) {
      delete permissions.deny;
    }
    // Clean up empty permissions object
    if (Object.keys(permissions).length === 0) {
      delete settings.permissions;
    }
  }

  saveClaudeSettings(projectRoot, settings);

  // Remove slash commands
  const commandsDir = path.join(projectRoot, ".claude", "commands");
  const sandboxCmds = ["sandbox:status.md", "sandbox:restore.md", "sandbox:restore_direct.md",
    "sandbox:diff.md", "sandbox:backups.md", "sandbox:config.md", "sandbox:history.md",
    "sandbox:clear.md"];
  for (const f of sandboxCmds) {
    const p = path.join(commandsDir, f);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  }

  console.log("CHATS-Sandbox uninstalled.");
  console.log("  Hooks removed from .claude/settings.json");
  console.log("  Slash commands removed from .claude/commands/");
  console.log("  Config and backups left in .chats-sandbox/ (delete manually if desired)");
}

// ── Config ───────────────────────────────────────────────────────────

function showConfig(projectRoot: string): void {
  const config = loadConfig(projectRoot);
  console.log("CHATS-Sandbox Configuration:");
  console.log(JSON.stringify(config, null, 2));
}

function setConfigValue(
  projectRoot: string,
  key: string,
  value: string
): void {
  const config = loadConfig(projectRoot);
  const k = key as keyof typeof config;

  // Type coercion
  if (k === "enabled" || k === "effectManifest" || k === "verbose" || k === "subagentEnabled") {
    (config as unknown as Record<string, unknown>)[k] = value === "true";
  } else if (k === "maxActions" || k === "subagentTimeoutSeconds") {
    (config as unknown as Record<string, unknown>)[k] = parseInt(value, 10);
  } else if (k === "backupMode") {
    if (!["always", "smart", "off"].includes(value)) {
      console.error(`Invalid backupMode: ${value}. Use: always | smart | off`);
      process.exit(1);
    }
    (config as unknown as Record<string, unknown>)[k] = value;
  } else if (k === "subagentModel") {
    if (!["haiku", "sonnet", "opus", "inherit"].includes(value)) {
      console.error(`Invalid subagentModel: ${value}. Use: haiku | sonnet | opus | inherit`);
      process.exit(1);
    }
    (config as unknown as Record<string, unknown>)[k] = value;
  } else if (k === "subagentPermissionMode") {
    if (!["bypassPermissions", "acceptEdits"].includes(value)) {
      console.error(`Invalid subagentPermissionMode: ${value}. Use: bypassPermissions | acceptEdits`);
      process.exit(1);
    }
    (config as unknown as Record<string, unknown>)[k] = value;
  } else {
    (config as unknown as Record<string, unknown>)[k] = value;
  }

  saveConfig(config, projectRoot);
  console.log(`Set ${key} = ${value}`);
}

// ── Status ───────────────────────────────────────────────────────────

function showStatus(projectRoot: string): void {
  const config = loadConfig(projectRoot);
  const manifest = loadManifest(config);
  const { listActions } = require("./backup/manifest.js");
  const actions = listActions(config) as string[];

  console.log("CHATS-Sandbox Status:");
  console.log(`  Enabled:       ${config.enabled}`);
  console.log(`  Backup mode:   ${config.backupMode}`);
  console.log(`  Actions:  ${actions.length} / ${config.maxActions} folders`);
  console.log(`  Artifacts:     ${manifest.length} total`);
  console.log(`  Effect log:    ${config.effectManifest ? config.effectLogPath : "disabled"}`);
  console.log(`  Subagent:      ${config.subagentEnabled ? `enabled (${config.subagentModel}, ${config.subagentPermissionMode ?? "bypassPermissions"})` : "disabled"}`);
  console.log(`  Verbose:       ${config.verbose}`);

  // Check if hooks are installed
  const settings = loadClaudeSettings(projectRoot);
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const hooked = Boolean(hooks.PreToolUse);
  console.log(`  Hooks active:  ${hooked}`);
}

// ── Backups ──────────────────────────────────────────────────────────

function listBackups(projectRoot: string): void {
  const config = loadConfig(projectRoot);
  const manifest = loadManifest(config);

  if (manifest.length === 0) {
    console.log("No backups yet.");
    return;
  }

  console.log(`Recent backups (${manifest.length} total):\n`);
  const recent = manifest.slice(-10);
  for (const b of recent) {
    const size = b.sizeBytes ? ` (${b.sizeBytes} bytes)` : "";
    console.log(
      `  ${b.id}  ${b.timestamp}  ${b.strategy.padEnd(14)} ${b.description}${size}`
    );
  }
}

// ── Restore ──────────────────────────────────────────────────────────

function listActionsForRestore(projectRoot: string): Array<{
  name: string;
  artifacts: Array<{ strategy: string; description: string; timestamp: string }>;
}> {
  const { listRestorableActions } = require("./restore/restore.js");
  const config = loadConfig(projectRoot);
  return listRestorableActions(config) as Array<{
    name: string;
    artifacts: Array<{ strategy: string; description: string; timestamp: string }>;
  }>;
}

function printRestoreResults(results: Array<{
  success: boolean;
  description: string;
  subagentPrompt?: string;
}>): void {
  for (const r of results) {
    const icon = r.success ? "OK" : "FAIL";
    console.log(`  [${icon}] ${r.description}`);

    if (r.subagentPrompt) {
      console.log("\n  --- Subagent restore needed ---");
      console.log("  The following prompt should be sent to a subagent:\n");
      console.log(r.subagentPrompt.split("\n").map((l: string) => `    ${l}`).join("\n"));
      console.log();
    }
  }
}

/**
 * restore <N> — Reverse-loop restore. Undoes actions one by one from
 * latest back to N+1, then restores N's state. Safer for non-workspace state.
 */
function restoreCommand(projectRoot: string, actionArg?: string, fileArg?: string): void {
  const config = loadConfig(projectRoot);
  const actions = listActionsForRestore(projectRoot);

  if (actions.length === 0) {
    console.log("No actions to restore.");
    return;
  }

  // Default: restore to the action BEFORE the latest
  // ("undo the last thing"). Requires at least 2 actions.
  let idx: number;
  if (!actionArg) {
    if (actions.length < 2) {
      console.log("Only one action exists — nothing to undo. Use 'history' to list.");
      return;
    }
    idx = actions.length - 2; // second-to-last (0-indexed)
    console.log(`No argument — defaulting to previous action (undo last step).\n`);
  } else {
    idx = parseInt(actionArg, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= actions.length) {
      console.error(`Invalid action number: ${actionArg}. Use 1-${actions.length}.`);
      process.exit(1);
    }
  }

  const target = actions[idx];

  // --file flag uses direct restore for single file
  if (fileArg) {
    const { restoreActionDirect } = require("./restore/restore.js");
    console.log(`Restoring file ${fileArg} from ${target.name}\n`);
    const results = restoreActionDirect(target.name, config, { fileOnly: fileArg });
    printRestoreResults(results);
    return;
  }

  // Reverse-loop restore
  const { restoreActionLoop } = require("./restore/restore.js");
  console.log(`Reverse-loop restore to: ${target.name}\n`);
  const results = restoreActionLoop(target.name, config);
  printRestoreResults(results);
}

/**
 * restore_direct <N> — Direct jump to action N's snapshot.
 * Fast, but only covers what that single action backed up.
 * No-arg default: jump to the action before the latest (undo last).
 */
function restoreDirectCommand(projectRoot: string, actionArg?: string): void {
  const config = loadConfig(projectRoot);
  const actions = listActionsForRestore(projectRoot);

  if (actions.length === 0) {
    console.log("No actions to restore.");
    return;
  }

  let idx: number;
  if (!actionArg) {
    if (actions.length < 2) {
      console.log("Only one action exists — nothing to undo.");
      return;
    }
    idx = actions.length - 2;
    console.log(`No argument — defaulting to previous action.\n`);
  } else {
    idx = parseInt(actionArg, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= actions.length) {
      console.error(`Invalid action number: ${actionArg}. Use 1-${actions.length}.`);
      process.exit(1);
    }
  }

  const target = actions[idx];
  const { restoreActionDirect } = require("./restore/restore.js");
  console.log(`Direct restore from: ${target.name}\n`);
  const results = restoreActionDirect(target.name, config);
  printRestoreResults(results);
}

// ── Diff ─────────────────────────────────────────────────────────────

function diffCommand(projectRoot: string, actionArg?: string): void {
  const config = loadConfig(projectRoot);
  const { listRestorableActions } = require("./restore/restore.js");
  const actions = listRestorableActions(config) as Array<{
    name: string;
    artifacts: Array<{ strategy: string; artifactPath: string; commitHash?: string; id: string }>;
  }>;

  if (actions.length === 0) {
    console.log("No actions to diff against.");
    return;
  }

  // Default: diff against the action BEFORE the latest
  // ("what did the last step change?"). Requires at least 2 actions.
  let idx: number;
  if (!actionArg) {
    if (actions.length < 2) {
      console.log("Only one action exists — nothing to diff against.");
      return;
    }
    idx = actions.length - 2;
    console.log(`No argument — showing changes since previous action.\n`);
  } else {
    idx = parseInt(actionArg, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= actions.length) {
      console.error(`Invalid action number: ${actionArg}. Use 1-${actions.length}.`);
      return;
    }
  }

  const target = actions[idx];
  const snapshot = target.artifacts.find((a) => a.strategy === "git_snapshot");

  if (!snapshot) {
    console.log(`No git snapshot in ${target.name} — cannot diff.`);
    return;
  }

  // Use the specific commit hash for this action (NOT HEAD, which is
  // the latest snapshot in the shared shadow repo).
  const commit = snapshot.commitHash ?? snapshot.id;
  if (!commit) {
    console.error(`Snapshot in ${target.name} is missing commit hash.`);
    return;
  }

  const shadowDir = snapshot.artifactPath;
  if (!fs.existsSync(shadowDir)) {
    console.error(`Shadow repo not found: ${shadowDir}`);
    return;
  }

  const { execSync } = require("node:child_process");
  const cwd = process.cwd();

  try {
    const env = { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: cwd };
    const opts = { encoding: "utf-8" as const, timeout: 30_000, env, cwd, stdio: "pipe" as const };

    // Stage current state, diff against the target commit, then unstage.
    execSync("git add -A", opts);
    const diff = execSync(`git diff --cached --stat ${commit}`, opts).trim();
    const fullDiff = execSync(`git diff --cached ${commit} --no-color`, opts).trim();
    execSync("git reset --quiet", opts);

    if (!diff) {
      console.log(`No changes between ${target.name} and current state.`);
      return;
    }

    console.log(`Changes since ${target.name} (${commit.slice(0, 8)}):\n`);
    console.log(diff);
    console.log("\n--- Full diff ---\n");
    console.log(fullDiff);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Diff failed: ${msg.slice(0, 200)}`);
  }
}

// ── History ──────────────────────────────────────────────────────────

function historyCommand(projectRoot: string, countArg?: string): void {
  const config = loadConfig(projectRoot);
  const { listRestorableActions } = require("./restore/restore.js");
  const actions = listRestorableActions(config) as Array<{
    name: string;
    artifacts: Array<{
      strategy: string;
      artifactPath: string;
      commitHash?: string;
      id: string;
      toolName: string;
      description: string;
      timestamp: string;
    }>;
  }>;

  if (actions.length === 0) {
    console.log("No actions recorded yet.");
    return;
  }

  // Parse count (default 10)
  let count = 10;
  if (countArg !== undefined) {
    const n = parseInt(countArg, 10);
    if (isNaN(n) || n < 1) {
      console.error(`Invalid count: ${countArg}. Must be a positive integer.`);
      return;
    }
    count = n;
  }

  // Show the most recent `count` actions
  const shown = actions.slice(-count);
  const startIdx = actions.length - shown.length + 1;

  console.log(`Showing last ${shown.length} of ${actions.length} actions:\n`);

  const { execSync } = require("node:child_process");
  const cwd = process.cwd();

  const MAX_FILES_SHOWN = 5;

  for (let i = 0; i < shown.length; i++) {
    const inter = shown[i];
    const displayNum = startIdx + i;
    const time = inter.name.split("_").slice(2).join("_"); // e.g. 20260410221532
    const timeFormatted =
      time.length >= 14
        ? `${time.slice(8, 10)}:${time.slice(10, 12)}`  // HH:MM only
        : "?";

    const snapshot = inter.artifacts.find((a) => a.strategy === "git_snapshot");
    const strategies = inter.artifacts.map((a) => a.strategy).join("+");

    // Get file list and stats from the shared shadow repo
    let files: string[] = [];
    let stat = "";
    if (snapshot && (snapshot.commitHash || snapshot.id) && fs.existsSync(snapshot.artifactPath)) {
      const commit = snapshot.commitHash ?? snapshot.id;
      try {
        const env = { ...process.env, GIT_DIR: snapshot.artifactPath, GIT_WORK_TREE: cwd };
        const opts = { encoding: "utf-8" as const, timeout: 10_000, env, cwd, stdio: "pipe" as const };
        // Get the list of files changed in this commit
        const fileOutput = execSync(`git show --name-only --format= ${commit}`, opts).trim();
        files = fileOutput.split("\n").filter((f: string) => f.trim().length > 0);
        // Get the shortstat
        stat = execSync(`git diff --shortstat ${commit}~1 ${commit}`, opts).trim();
      } catch {
        // First commit or other error — try listing the tree of the first commit
        try {
          const env = { ...process.env, GIT_DIR: snapshot.artifactPath, GIT_WORK_TREE: cwd };
          const opts = { encoding: "utf-8" as const, timeout: 10_000, env, cwd, stdio: "pipe" as const };
          const fileOutput = execSync(`git ls-tree -r --name-only ${commit}`, opts).trim();
          files = fileOutput.split("\n").filter((f: string) => f.trim().length > 0).slice(0, MAX_FILES_SHOWN);
          stat = `baseline snapshot (${files.length} files)`;
        } catch {
          // give up
        }
      }
    }

    // Read instruction.txt for this action (set by UserPromptSubmit hook)
    let instruction = "";
    try {
      const backupRoot = path.resolve(config.backupDir);
      const instructionPath = path.join(backupRoot, inter.name, "instruction.txt");
      if (fs.existsSync(instructionPath)) {
        instruction = fs.readFileSync(instructionPath, "utf-8").trim();
      }
    } catch {
      // best-effort
    }

    // Display line 1: number, time, strategies
    console.log(`  ${displayNum}. ${timeFormatted}  [${strategies}]`);

    // Display line 2: instruction (if available)
    if (instruction) {
      const shortInstr = instruction.length > 80
        ? instruction.slice(0, 80) + "..."
        : instruction;
      console.log(`     "${shortInstr}"`);
    }

    // Display line 3: files (truncated to top 5)
    if (files.length > 0) {
      const shownFiles = files.slice(0, MAX_FILES_SHOWN);
      const extra = files.length - shownFiles.length;
      const fileStr = shownFiles.join(", ") + (extra > 0 ? `, +${extra} more` : "");
      console.log(`     Files: ${fileStr}`);
    }

    // Display line 3: stats
    if (stat) {
      console.log(`     Stats: ${stat}`);
    }

    // Display targeted-manifest supplements (pip freeze, npm list, etc.)
    const nonGitArtifacts = inter.artifacts.filter((a) => a.strategy !== "git_snapshot");
    for (const a of nonGitArtifacts) {
      console.log(`     + ${a.description}`);
    }

    console.log();
  }

  if (actions.length > shown.length) {
    console.log(`(${actions.length - shown.length} older actions hidden — use 'chats-sandbox history <N>' to see more)`);
  }
}

// ── Clear ────────────────────────────────────────────────────────────

function clearCommand(projectRoot: string, _args: string[]): void {
  const config = loadConfig(projectRoot);
  const backupRoot = path.resolve(config.backupDir);
  const shadowRoot = path.join(path.dirname(backupRoot), "shadow-repo");
  const effectsLog = path.resolve(config.effectLogPath);

  // Check existing state
  const hasBackups = fs.existsSync(backupRoot) &&
    fs.readdirSync(backupRoot).some((d: string) => d.startsWith("action_"));
  const hasShadow = fs.existsSync(shadowRoot);
  const hasEffects = fs.existsSync(effectsLog);

  if (!hasBackups && !hasShadow && !hasEffects) {
    console.log("Nothing to clear — no backups, shadow repo, or effect log found.");
    return;
  }

  // Delete action folders
  if (hasBackups) {
    const dirs = fs.readdirSync(backupRoot).filter((d: string) => d.startsWith("action_"));
    for (const d of dirs) {
      try {
        fs.rmSync(path.join(backupRoot, d), { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    console.log(`Removed ${dirs.length} action folder(s)`);
  }

  // Delete shadow repo
  if (hasShadow) {
    try {
      fs.rmSync(shadowRoot, { recursive: true, force: true });
      console.log(`Removed shared shadow repo at ${shadowRoot}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed to remove shadow repo: ${msg}`);
    }
  }

  // Delete effect log
  if (hasEffects) {
    try {
      fs.unlinkSync(effectsLog);
      console.log(`Removed effect log at ${effectsLog}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed to remove effect log: ${msg}`);
    }
  }

  // Delete current-instruction.txt and subagent.log if present
  const sandboxDir = path.dirname(backupRoot);
  for (const f of ["current-instruction.txt", "subagent.log"]) {
    const p = path.join(sandboxDir, f);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // best-effort
      }
    }
  }

  console.log("\nCleared. Hooks and config are untouched. Run 'chats-sandbox uninstall' to remove those.");
}

// ── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] ?? "status";
const projectRoot = process.cwd();

switch (command) {
  case "install":
    install(projectRoot);
    break;
  case "uninstall":
    uninstall(projectRoot);
    break;
  case "config":
    if (args[1] === "set" && args[2] && args[3]) {
      setConfigValue(projectRoot, args[2], args[3]);
    } else {
      showConfig(projectRoot);
    }
    break;
  case "status":
    showStatus(projectRoot);
    break;
  case "backups":
    listBackups(projectRoot);
    break;
  case "restore": {
    const fileIdx = args.indexOf("--file");
    const fileArg = fileIdx !== -1 ? args[fileIdx + 1] : undefined;
    restoreCommand(projectRoot, args[1], fileArg);
    break;
  }
  case "restore_direct":
    restoreDirectCommand(projectRoot, args[1]);
    break;
  case "diff":
    diffCommand(projectRoot, args[1]);
    break;
  case "history":
    historyCommand(projectRoot, args[1]);
    break;
  case "clear":
    clearCommand(projectRoot, args.slice(1));
    break;
  default:
    console.log("CHATS-Sandbox — General-purpose sandbox for Claude Code\n");
    console.log("Usage: chats-sandbox <command>\n");
    console.log("Commands:");
    console.log("  install                         Wire hooks into .claude/settings.json");
    console.log("  uninstall                       Remove hooks");
    console.log("  config                          Show configuration");
    console.log("  config set <key> <value>        Set a config value");
    console.log("  status                          Show sandbox state");
    console.log("  backups                         List recent backup artifacts");
    console.log("  history [N]                     Timeline of last N actions (default 10)");
    console.log("  restore                         List restorable actions");
    console.log("  restore <N>                     Reverse-loop restore to action N");
    console.log("  restore <N> --file <path>       Restore single file from action N");
    console.log("  restore_direct <N>              Direct jump to action N's snapshot");
    console.log("  diff <N>                        Diff action N vs current state");
    console.log("  clear [--yes]                   Delete all backups, shadow repo, and effect log");
    break;
}
