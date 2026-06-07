/**
 * OpenClaw adapter.
 *
 * Unlike Hermes (which needed a ToolRegistry source patch), OpenClaw
 * ships a first-class plugin API with `before_tool_call` /
 * `after_tool_call` hooks. We install a small ESM plugin into
 * `<project>/.openclaw/extensions/chats-sandbox/` that OpenClaw
 * discovers at startup; the plugin shells out to the same Node hooks
 * Claude Code and Hermes use, so the tier-0..3 backup logic is fully
 * reused across all three agents.
 *
 * Plugin contract (see openclaw docs/plugins/): an extension directory
 * with an `openclaw.plugin.json` manifest, a `package.json` whose
 * `openclaw.extensions` array names the code entry, and that entry
 * exporting `definePluginEntry({ id, name, register(api) })`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter, AgentInstallResult } from "./index.js";
import { appendGitignore } from "./index.js";
import { saveConfig, getConfigDir } from "../config/load.js";
import { DEFAULT_CONFIG } from "../types.js";

const EXTENSIONS_DIR = ".openclaw/extensions";
const PLUGIN_DIRNAME = "chats-sandbox";
const PLUGIN_ID = "chats-sandbox";

/** index.mjs — the plugin entry. Plain ESM JS so OpenClaw can load it
 *  with no build step (index.{ts,js,mjs,cjs} are all valid entries). */
function pluginIndexSource(pkgRoot: string): string {
  const preToolJs  = JSON.stringify(path.join(pkgRoot, "hooks", "pre-tool.js"));
  const postToolJs = JSON.stringify(path.join(pkgRoot, "hooks", "post-tool.js"));
  return `/**
 * CHATS-Sandbox plugin for OpenClaw.
 *
 * Installed by \`chats-sandbox install openclaw\`. Do not edit by hand —
 * regenerated on every \`install\`.
 *
 * Registers before_tool_call / after_tool_call hooks that pipe a JSON
 * payload to the same Node hooks Claude Code and Hermes use:
 *
 *   { "hook_event": "PreToolUse" | "PostToolUse",
 *     "tool_name": <str>, "tool_input": <obj>, "tool_output"?: <any> }
 *
 * so tier-0 / tier-1 / tier-2 / tier-3 backup is shared across agents.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { spawn } from "node:child_process";

const PRE_TOOL_HOOK  = ${preToolJs};
const POST_TOOL_HOOK = ${postToolJs};

// Recursion guard. CHATS_SANDBOX_NO_HOOK=1 means "this process is a
// chats-sandbox-spawned subagent — do not fire hooks." We honor it on
// the way in, and strip it from the hook's own child env (the flag is
// for subagents the hook itself spawns, not the hook).
const NO_HOOK_ENV = "CHATS_SANDBOX_NO_HOOK";

function runHook(hookPath, payload) {
  return new Promise((resolve) => {
    if (process.env[NO_HOOK_ENV] === "1") { resolve(); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const env = { ...process.env };
      delete env[NO_HOOK_ENV];
      const child = spawn("node", [hookPath], {
        stdio: ["pipe", "ignore", "ignore"],
        env,
      });
      // Generous cap — a tier-3 subagent can run minutes. Past this we
      // give up rather than block the agent forever.
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        finish();
      }, 600000);
      child.on("close", () => { clearTimeout(timer); finish(); });
      child.on("error", () => { clearTimeout(timer); finish(); });
      child.stdin.on("error", () => {});
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      finish();
    }
  });
}

export default definePluginEntry({
  id: "${PLUGIN_ID}",
  name: "CHATS-Sandbox",
  description: "Tiered action backup & recovery for OpenClaw tool calls.",
  register(api) {
    // before_tool_call is FAIL-CLOSED in OpenClaw: a handler that
    // throws blocks the tool. Backup is best-effort — swallow every
    // error so a backup failure never blocks the agent.
    api.on("before_tool_call", async (event) => {
      try {
        await runHook(PRE_TOOL_HOOK, {
          hook_event: "PreToolUse",
          tool_name: (event && event.toolName) || "",
          tool_input: (event && event.params) || {},
        });
      } catch { /* never block the tool */ }
    });

    // after_tool_call is fire-and-forget (OpenClaw times it out).
    api.on("after_tool_call", async (event) => {
      try {
        await runHook(POST_TOOL_HOOK, {
          hook_event: "PostToolUse",
          tool_name: (event && event.toolName) || "",
          tool_input: (event && event.params) || {},
          tool_output: event ? event.result : undefined,
        });
      } catch { /* observation only */ }
    });
  },
});
`;
}

/** openclaw.plugin.json — the manifest OpenClaw reads without executing
 *  any plugin code (identity + config). */
function manifestSource(): string {
  return JSON.stringify({
    id: PLUGIN_ID,
    name: "CHATS-Sandbox",
    version: "0.1.0",
    description:
      "Tiered action backup & recovery — snapshots every tool call, " +
      "restorable via the chats-sandbox CLI and dashboard.",
  }, null, 2) + "\n";
}

/** package.json — declares the code entry under the `openclaw` field. */
function packageJsonSource(): string {
  return JSON.stringify({
    name: "chats-sandbox-openclaw",
    version: "0.1.0",
    private: true,
    type: "module",
    description: "CHATS-Sandbox backup plugin for OpenClaw.",
    openclaw: {
      extensions: ["./index.mjs"],
    },
  }, null, 2) + "\n";
}

export const openclawAdapter: AgentAdapter = {
  name: "openclaw",
  description: "OpenClaw agent (via .openclaw/extensions/chats-sandbox/)",

  detectInstalled(projectRoot: string): boolean {
    // An .openclaw/ dir is the strongest signal OpenClaw is wired here.
    return fs.existsSync(path.join(projectRoot, ".openclaw"));
  },

  install(projectRoot: string, pkgRoot: string): AgentInstallResult {
    const log: string[] = [];

    // Write the plugin into the workspace-scoped extensions dir, which
    // OpenClaw scans at startup (alongside ~/.openclaw/extensions).
    const pluginDir = path.join(projectRoot, EXTENSIONS_DIR, PLUGIN_DIRNAME);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), manifestSource(), "utf-8");
    fs.writeFileSync(path.join(pluginDir, "package.json"), packageJsonSource(), "utf-8");
    fs.writeFileSync(path.join(pluginDir, "index.mjs"), pluginIndexSource(pkgRoot), "utf-8");

    // Sandbox config + backup dir. Default subagent runner is the
    // claude CLI (tier-3 degrades gracefully if it's absent).
    const configDir = getConfigDir(projectRoot);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    saveConfig(DEFAULT_CONFIG, projectRoot);

    appendGitignore(projectRoot, ".chats-sandbox/");

    log.push("CHATS-Sandbox installed successfully for OpenClaw!");
    log.push(`  Plugin written to ${EXTENSIONS_DIR}/${PLUGIN_DIRNAME}/`);
    log.push(`  Config at ${configDir}/config.json`);
    log.push(`  Backups will be stored in ${DEFAULT_CONFIG.backupDir}/`);
    log.push("");
    log.push("OpenClaw discovers this plugin on startup and fires its");
    log.push("before_tool_call / after_tool_call hooks — every tool call");
    log.push("is wrapped with tier-0..3 backup, no source patch needed.");
    log.push("");
    log.push("To check backup state: chats-sandbox status");
    log.push("To view timeline:      chats-sandbox dashboard");
    log.push("To disable:            chats-sandbox uninstall openclaw");
    return { log };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const log: string[] = [];
    const pluginDir = path.join(projectRoot, EXTENSIONS_DIR, PLUGIN_DIRNAME);
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      log.push(`  Removed ${EXTENSIONS_DIR}/${PLUGIN_DIRNAME}/`);
    }
    log.push("CHATS-Sandbox uninstalled from OpenClaw.");
    log.push("  Config and backups left in .chats-sandbox/ (delete manually if desired)");
    return { log };
  },
};
