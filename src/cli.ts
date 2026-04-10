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

  console.log("CHATS-Sandbox uninstalled.");
  console.log("  Hooks removed from .claude/settings.json");
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
  default:
    console.log("CHATS-Sandbox — General-purpose sandbox for Claude Code\n");
    console.log("Usage: chats-sandbox <command>\n");
    console.log("Commands:");
    console.log("  install                    Wire hooks into .claude/settings.json");
    console.log("  uninstall                  Remove hooks");
    console.log("  config                     Show configuration");
    console.log("  config set <key> <value>   Set a config value");
    console.log("  status                     Show sandbox state");
    console.log("  backups                    List recent backup artifacts");
    break;
}
