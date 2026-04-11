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

  settings.hooks = hooks;
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
  console.log("  /sandbox:history         Timeline of recent interactions");
  console.log("  /sandbox:restore         Reverse-loop restore");
  console.log("  /sandbox:restore_direct  Direct jump restore");
  console.log("  /sandbox:diff            Diff against interaction");
  console.log("  /sandbox:backups         List backup artifacts");
  console.log("  /sandbox:config          Show/edit configuration");
  console.log("");
  console.log("To configure: chats-sandbox config");
  console.log("To disable:   chats-sandbox uninstall");
}

// ── Uninstall ────────────────────────────────────────────────────────

function uninstall(projectRoot: string): void {
  const settings = loadClaudeSettings(projectRoot) as Record<string, unknown>;
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

  // Remove our hooks (identified by the chats-sandbox command path)
  for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
    if (Array.isArray(hooks[event])) {
      hooks[event] = (hooks[event] as unknown[]).filter((entry) => {
        const h = entry as Record<string, unknown>;
        const innerHooks = h.hooks as Array<Record<string, unknown>> | undefined;
        if (!innerHooks) return true;
        return !innerHooks.some(
          (ih) => typeof ih.command === "string" && ih.command.includes("chats-sandbox")
        );
      });
      if ((hooks[event] as unknown[]).length === 0) {
        delete hooks[event];
      }
    }
  }

  settings.hooks = hooks;
  saveClaudeSettings(projectRoot, settings);

  // Remove slash commands
  const commandsDir = path.join(projectRoot, ".claude", "commands");
  const sandboxCmds = ["sandbox:status.md", "sandbox:restore.md", "sandbox:restore_direct.md",
    "sandbox:diff.md", "sandbox:backups.md", "sandbox:config.md", "sandbox:history.md"];
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
  if (k === "enabled" || k === "effectManifest" || k === "verbose") {
    (config as unknown as Record<string, unknown>)[k] = value === "true";
  } else if (k === "maxInteractions") {
    (config as unknown as Record<string, unknown>)[k] = parseInt(value, 10);
  } else if (k === "backupMode") {
    if (!["always", "smart", "off"].includes(value)) {
      console.error(`Invalid backupMode: ${value}. Use: always | smart | off`);
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
  const { listInteractions } = require("./backup/manifest.js");
  const interactions = listInteractions(config) as string[];

  console.log("CHATS-Sandbox Status:");
  console.log(`  Enabled:       ${config.enabled}`);
  console.log(`  Backup mode:   ${config.backupMode}`);
  console.log(`  Interactions:  ${interactions.length} / ${config.maxInteractions} folders`);
  console.log(`  Artifacts:     ${manifest.length} total`);
  console.log(`  Effect log:    ${config.effectManifest ? config.effectLogPath : "disabled"}`);
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

function listInteractionsForRestore(projectRoot: string): Array<{
  name: string;
  artifacts: Array<{ strategy: string; description: string; timestamp: string }>;
}> {
  const { listRestorableInteractions } = require("./restore/restore.js");
  const config = loadConfig(projectRoot);
  return listRestorableInteractions(config) as Array<{
    name: string;
    artifacts: Array<{ strategy: string; description: string; timestamp: string }>;
  }>;
}

function printInteractionList(interactions: Array<{
  name: string;
  artifacts: Array<{ strategy: string; description: string }>;
}>): void {
  console.log("Restorable interactions:\n");
  for (let i = 0; i < interactions.length; i++) {
    const inter = interactions[i];
    const strategies = inter.artifacts.map((a) => a.strategy).join(", ");
    console.log(`  ${i + 1}. ${inter.name}  [${strategies}]`);
    for (const a of inter.artifacts) {
      const badge = a.strategy === "subagent" ? " (needs subagent)" : "";
      console.log(`     - ${a.description}${badge}`);
    }
  }
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
 * restore <N> — Reverse-loop restore. Undoes interactions one by one from
 * latest back to N+1, then restores N's state. Safer for non-workspace state.
 */
function restoreCommand(projectRoot: string, interactionArg?: string, fileArg?: string): void {
  const config = loadConfig(projectRoot);
  const interactions = listInteractionsForRestore(projectRoot);

  if (!interactionArg) {
    if (interactions.length === 0) {
      console.log("No interactions to restore.");
      return;
    }
    printInteractionList(interactions);
    console.log("\nUsage:");
    console.log("  chats-sandbox restore <N>              Reverse-loop restore to N");
    console.log("  chats-sandbox restore <N> --file <path> Restore single file");
    console.log("  chats-sandbox restore_direct <N>       Direct jump to N's snapshot");
    return;
  }

  const idx = parseInt(interactionArg, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= interactions.length) {
    console.error(`Invalid interaction number: ${interactionArg}. Use 1-${interactions.length}.`);
    process.exit(1);
  }

  const target = interactions[idx];

  // --file flag uses direct restore for single file
  if (fileArg) {
    const { restoreInteractionDirect } = require("./restore/restore.js");
    console.log(`Restoring file ${fileArg} from ${target.name}\n`);
    const results = restoreInteractionDirect(target.name, config, { fileOnly: fileArg });
    printRestoreResults(results);
    return;
  }

  // Reverse-loop restore
  const { restoreInteractionLoop } = require("./restore/restore.js");
  console.log(`Reverse-loop restore to: ${target.name}\n`);
  const results = restoreInteractionLoop(target.name, config);
  printRestoreResults(results);
}

/**
 * restore_direct <N> — Direct jump to interaction N's snapshot.
 * Fast, but only covers what that single interaction backed up.
 */
function restoreDirectCommand(projectRoot: string, interactionArg?: string): void {
  const config = loadConfig(projectRoot);
  const interactions = listInteractionsForRestore(projectRoot);

  if (!interactionArg) {
    if (interactions.length === 0) {
      console.log("No interactions to restore.");
      return;
    }
    printInteractionList(interactions);
    console.log("\nUsage:");
    console.log("  chats-sandbox restore_direct <N>       Direct jump to N's snapshot");
    return;
  }

  const idx = parseInt(interactionArg, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= interactions.length) {
    console.error(`Invalid interaction number: ${interactionArg}. Use 1-${interactions.length}.`);
    process.exit(1);
  }

  const target = interactions[idx];
  const { restoreInteractionDirect } = require("./restore/restore.js");
  console.log(`Direct restore from: ${target.name}\n`);
  const results = restoreInteractionDirect(target.name, config);
  printRestoreResults(results);
}

// ── Diff ─────────────────────────────────────────────────────────────

function diffCommand(projectRoot: string, interactionArg?: string): void {
  const config = loadConfig(projectRoot);
  const { listRestorableInteractions } = require("./restore/restore.js");
  const interactions = listRestorableInteractions(config) as Array<{
    name: string;
    artifacts: Array<{ strategy: string; artifactPath: string; commitHash?: string; id: string }>;
  }>;

  if (!interactionArg) {
    console.error("Usage: chats-sandbox diff <N>  — diff between interaction N and current state");
    return;
  }

  if (interactions.length === 0) {
    console.log("No interactions to diff against.");
    return;
  }

  const idx = parseInt(interactionArg, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= interactions.length) {
    console.error(`Invalid interaction number: ${interactionArg}. Use 1-${interactions.length}.`);
    return;
  }

  const target = interactions[idx];
  const snapshot = target.artifacts.find((a) => a.strategy === "git_snapshot");

  if (!snapshot) {
    console.log(`No git snapshot in ${target.name} — cannot diff.`);
    return;
  }

  // Use the specific commit hash for this interaction (NOT HEAD, which is
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
  const { listRestorableInteractions } = require("./restore/restore.js");
  const interactions = listRestorableInteractions(config) as Array<{
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

  if (interactions.length === 0) {
    console.log("No interactions recorded yet.");
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

  // Show the most recent `count` interactions
  const shown = interactions.slice(-count);
  const startIdx = interactions.length - shown.length + 1;

  console.log(`Showing last ${shown.length} of ${interactions.length} interactions:\n`);

  const { execSync } = require("node:child_process");
  const cwd = process.cwd();

  for (let i = 0; i < shown.length; i++) {
    const inter = shown[i];
    const displayNum = startIdx + i;
    const time = inter.name.split("_").slice(2).join("_"); // e.g. 20260410221532
    const timeFormatted =
      time.length >= 14
        ? `${time.slice(8, 10)}:${time.slice(10, 12)}:${time.slice(12, 14)}`
        : "?";

    const snapshot = inter.artifacts.find((a) => a.strategy === "git_snapshot");
    const tool = inter.artifacts[0]?.toolName ?? "?";
    const strategies = inter.artifacts.map((a) => a.strategy).join("+");

    // Get file stats from the shared shadow repo if we have a commit
    let stat = "";
    if (snapshot && (snapshot.commitHash || snapshot.id) && fs.existsSync(snapshot.artifactPath)) {
      const commit = snapshot.commitHash ?? snapshot.id;
      try {
        const env = { ...process.env, GIT_DIR: snapshot.artifactPath, GIT_WORK_TREE: cwd };
        const opts = { encoding: "utf-8" as const, timeout: 10_000, env, cwd, stdio: "pipe" as const };
        stat = execSync(`git diff --shortstat ${commit}~1 ${commit}`, opts).trim();
      } catch {
        // first commit or other error — skip stat
      }
    }

    console.log(`  ${displayNum}. ${timeFormatted}  ${inter.name}  [${strategies}]`);
    console.log(`     Tool: ${tool}`);
    for (const a of inter.artifacts) {
      console.log(`     - ${a.description}`);
    }
    if (stat) {
      console.log(`     ${stat}`);
    }
    console.log();
  }

  if (interactions.length > shown.length) {
    console.log(`(${interactions.length - shown.length} older interactions hidden — use 'chats-sandbox history <N>' to see more)`);
  }
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
    console.log("  history [N]                     Timeline of last N interactions (default 10)");
    console.log("  restore                         List restorable interactions");
    console.log("  restore <N>                     Reverse-loop restore to interaction N");
    console.log("  restore <N> --file <path>       Restore single file from interaction N");
    console.log("  restore_direct <N>              Direct jump to interaction N's snapshot");
    console.log("  diff <N>                        Diff interaction N vs current state");
    break;
}
