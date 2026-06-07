/**
 * OpenHands adapter.
 *
 * The OpenHands Agent SDK ships a Claude-Code-style hook system: a
 * `.openhands/hooks.json` with `PreToolUse` / `PostToolUse` entries,
 * each a `command` that receives the lifecycle event as JSON on stdin.
 * We write that file pointing at the same Node hooks every other agent
 * uses — no source patch needed.
 *
 * The SDK's event JSON uses `event_type` / `tool_response` where Claude
 * Code uses `hook_event` / `tool_output`; `normalizeHookContext` in the
 * Node hooks accepts both, so one hook binary serves every agent.
 *
 * Note: the SDK's `Conversation` does not auto-load hooks.json — the
 * caller passes `hook_config=HookConfig.load(working_dir=...)`. The
 * install output explains this.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter, AgentInstallResult } from "./index.js";
import { appendGitignore } from "./index.js";
import { saveConfig, getConfigDir } from "../config/load.js";
import { DEFAULT_CONFIG } from "../types.js";

const HOOKS_DIR = ".openhands";
const HOOKS_FILE = "hooks.json";
const HOOK_TIMEOUT = 600;

interface HookEntry { command: string; timeout?: number }
interface HookMatcher { matcher: string; hooks: HookEntry[] }
interface HooksJson { hooks?: Record<string, HookMatcher[]> }

function preCmd(pkgRoot: string): string {
  return `node "${path.join(pkgRoot, "hooks", "pre-tool.js")}"`;
}
function postCmd(pkgRoot: string): string {
  return `node "${path.join(pkgRoot, "hooks", "post-tool.js")}"`;
}

/** True if a matcher list already carries a chats-sandbox command. */
function hasOurHook(matchers: HookMatcher[] | undefined): boolean {
  return !!matchers?.some((m) =>
    m.hooks?.some((h) => /chats-sandbox|pre-tool\.js|post-tool\.js/.test(h.command)));
}

/** Drop every matcher whose hooks reference our Node hook scripts. */
function stripOurHooks(matchers: HookMatcher[] | undefined): HookMatcher[] {
  if (!matchers) return [];
  return matchers
    .map((m) => ({
      ...m,
      hooks: (m.hooks ?? []).filter(
        (h) => !/chats-sandbox|pre-tool\.js|post-tool\.js/.test(h.command)),
    }))
    .filter((m) => m.hooks.length > 0);
}

export const openhandsAdapter: AgentAdapter = {
  name: "openhands",
  description: "OpenHands Agent SDK (via .openhands/hooks.json)",

  detectInstalled(projectRoot: string): boolean {
    return fs.existsSync(path.join(projectRoot, HOOKS_DIR));
  },

  install(projectRoot: string, pkgRoot: string): AgentInstallResult {
    const log: string[] = [];

    const hooksDir = path.join(projectRoot, HOOKS_DIR);
    fs.mkdirSync(hooksDir, { recursive: true });
    const hooksPath = path.join(hooksDir, HOOKS_FILE);

    // Merge into an existing hooks.json rather than clobbering it —
    // the user may already have their own OpenHands hooks here.
    let doc: HooksJson = {};
    if (fs.existsSync(hooksPath)) {
      try {
        doc = JSON.parse(fs.readFileSync(hooksPath, "utf-8")) as HooksJson;
      } catch {
        log.push(`  Warning: ${HOOKS_DIR}/${HOOKS_FILE} was unparseable — replaced.`);
        doc = {};
      }
    }
    doc.hooks = doc.hooks ?? {};

    // Idempotent: only add our entry if not already present.
    if (!hasOurHook(doc.hooks.PreToolUse)) {
      doc.hooks.PreToolUse = [
        ...(doc.hooks.PreToolUse ?? []),
        { matcher: "*", hooks: [{ command: preCmd(pkgRoot), timeout: HOOK_TIMEOUT }] },
      ];
    }
    if (!hasOurHook(doc.hooks.PostToolUse)) {
      doc.hooks.PostToolUse = [
        ...(doc.hooks.PostToolUse ?? []),
        { matcher: "*", hooks: [{ command: postCmd(pkgRoot), timeout: HOOK_TIMEOUT }] },
      ];
    }
    fs.writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + "\n", "utf-8");

    // Sandbox config + backup dir.
    const configDir = getConfigDir(projectRoot);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    saveConfig(DEFAULT_CONFIG, projectRoot);

    appendGitignore(projectRoot, ".chats-sandbox/");

    log.push("CHATS-Sandbox installed successfully for OpenHands!");
    log.push(`  Hooks wired into ${HOOKS_DIR}/${HOOKS_FILE}`);
    log.push(`  Config at ${configDir}/config.json`);
    log.push(`  Backups will be stored in ${DEFAULT_CONFIG.backupDir}/`);
    log.push("");
    log.push("The OpenHands SDK does not auto-load hooks.json — pass it");
    log.push("to your Conversation explicitly:");
    log.push("");
    log.push("  from openhands.sdk.hooks import HookConfig");
    log.push("  hook_config = HookConfig.load(working_dir=os.getcwd())");
    log.push("  Conversation(agent=agent, workspace=cwd, hook_config=hook_config)");
    log.push("");
    log.push("Every PreToolUse / PostToolUse then fires tier-0..3 backup.");
    log.push("To check backup state: chats-sandbox status");
    log.push("To view timeline:      chats-sandbox dashboard");
    log.push("To disable:            chats-sandbox uninstall openhands");
    return { log };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const log: string[] = [];
    const hooksPath = path.join(projectRoot, HOOKS_DIR, HOOKS_FILE);
    if (fs.existsSync(hooksPath)) {
      try {
        const doc = JSON.parse(fs.readFileSync(hooksPath, "utf-8")) as HooksJson;
        if (doc.hooks) {
          doc.hooks.PreToolUse = stripOurHooks(doc.hooks.PreToolUse);
          doc.hooks.PostToolUse = stripOurHooks(doc.hooks.PostToolUse);
          // Drop now-empty event arrays.
          for (const k of ["PreToolUse", "PostToolUse"] as const) {
            if (doc.hooks[k]?.length === 0) delete doc.hooks[k];
          }
        }
        const empty = !doc.hooks || Object.keys(doc.hooks).length === 0;
        if (empty && Object.keys(doc).length <= 1) {
          // The file was ours alone — remove it entirely.
          fs.rmSync(hooksPath, { force: true });
          log.push(`  Removed ${HOOKS_DIR}/${HOOKS_FILE}`);
        } else {
          fs.writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + "\n", "utf-8");
          log.push(`  Removed CHATS-Sandbox hooks from ${HOOKS_DIR}/${HOOKS_FILE}`);
        }
      } catch {
        log.push(`  Could not parse ${HOOKS_DIR}/${HOOKS_FILE} — left untouched.`);
      }
    }
    log.push("CHATS-Sandbox uninstalled from OpenHands.");
    log.push("  Config and backups left in .chats-sandbox/ (delete manually if desired)");
    return { log };
  },
};
