/**
 * Hermes adapter.
 *
 * Hermes scans `~/.hermes/plugins/*.py` and `<project>/.hermes/plugins/*.py`
 * on ToolRegistry init. Each plugin defines `attach(registry)` and
 * registers pre/post hooks. We write one file: a plugin that shells
 * out to our Node hooks (same JSON contract used by Claude Code's
 * hook system), preserving full reuse of the tier-0..3 backup logic.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter, AgentInstallResult } from "./index.js";
import { appendGitignore } from "./index.js";
import { saveConfig, getConfigDir } from "../config/load.js";
import { DEFAULT_CONFIG } from "../types.js";

const PLUGINS_DIR = ".hermes/plugins";
const PLUGIN_FILENAME = "chats_sandbox.py";

function pluginSource(pkgRoot: string): string {
  const preToolJs  = JSON.stringify(path.join(pkgRoot, "hooks", "pre-tool.js"));
  const postToolJs = JSON.stringify(path.join(pkgRoot, "hooks", "post-tool.js"));
  return `"""CHATS-Sandbox plugin for Hermes.

Installed by \`chats-sandbox install hermes\`. Do not edit by hand —
the file is regenerated on every \`install\`.

When Hermes's ToolRegistry boots, this plugin's attach(registry) is
called. We register pre+post hooks that shell out to the same Node
hooks Claude Code uses (dist/hooks/pre-tool.js and post-tool.js),
so tier-0 / tier-1 / tier-2 / tier-3 backup logic is fully reused
across agents.

The JSON contract we send on stdin mirrors Claude Code's PreToolUse /
PostToolUse hook input shape:

    {
      "hook_event": "PreToolUse" | "PostToolUse",
      "tool_name": <str>,
      "tool_input": <dict>,
      "tool_output": <any>           # only on PostToolUse
    }
"""

from __future__ import annotations

import json
import logging
import subprocess
import os

logger = logging.getLogger(__name__)

_PRE_TOOL_HOOK  = ${preToolJs}
_POST_TOOL_HOOK = ${postToolJs}

# Recursion guard env var. CHATS_SANDBOX_NO_HOOK=1 tells the Node hook
# "you're inside a chats-sandbox-spawned subagent, exit early." We
# honor it on the way IN (skip firing if Hermes was itself launched
# inside a backup subagent) and clear it on the way OUT (the hook
# we're about to run isn't a subagent, it's a real top-level hook).
_NO_HOOK_ENV = "CHATS_SANDBOX_NO_HOOK"


def _run_hook(hook_path: str, payload: dict) -> None:
    """Pipe JSON into the Node hook and discard its output.

    The hooks are fire-and-forget; informational output goes to
    /dev/tty (in Claude Code), and backup bookkeeping happens as a
    side effect on disk. We give the subprocess a generous timeout —
    a tier-3 subagent fire can take 10-30 s and we want to let it
    complete — but past 120 s we move on rather than block tool
    execution.
    """
    if os.environ.get(_NO_HOOK_ENV) == "1":
        return
    if not os.path.exists(hook_path):
        # Plugin installed but Node hooks missing — log once and skip.
        logger.warning("chats-sandbox hook missing: %s", hook_path)
        return
    # IMPORTANT: do NOT propagate CHATS_SANDBOX_NO_HOOK=1 into the
    # hook's own env. That flag is meant for subagents spawned BY the
    # hook (tier-3) — setting it here would make the hook itself exit
    # early and no backup would ever happen. Strip if present.
    child_env = {k: v for k, v in os.environ.items() if k != _NO_HOOK_ENV}
    try:
        subprocess.run(
            ["node", hook_path],
            input=json.dumps(payload).encode("utf-8"),
            timeout=120.0,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            env=child_env,
        )
    except Exception as e:
        logger.warning("chats-sandbox hook failed (%s): %s", hook_path, e)


def _pre_hook(tool_name: str, args: dict) -> None:
    _run_hook(_PRE_TOOL_HOOK, {
        "hook_event": "PreToolUse",
        "tool_name": tool_name,
        "tool_input": args,
    })


def _post_hook(tool_name: str, args: dict, result: str) -> None:
    # The post hook also accepts hook_event="PostToolUseFailure" — but
    # Hermes's dispatch swallows tool errors into a JSON error string
    # and still returns a result, so we always send PostToolUse.
    _run_hook(_POST_TOOL_HOOK, {
        "hook_event": "PostToolUse",
        "tool_name": tool_name,
        "tool_input": args,
        "tool_output": result,
    })


def attach(registry) -> None:
    """Hermes calls this at ToolRegistry init time."""
    registry.add_pre_hook(_pre_hook)
    registry.add_post_hook(_post_hook)
    logger.info("chats-sandbox plugin attached")
`;
}

export const hermesAdapter: AgentAdapter = {
  name: "hermes",
  description: "Hermes agent (via .hermes/plugins/chats_sandbox.py)",

  detectInstalled(projectRoot: string): boolean {
    // Detect a hermes project by either an installed plugin dir or
    // a hermes-shaped config we'd recognize. Plugin dir alone is the
    // strongest signal a user has wired Hermes here.
    return fs.existsSync(path.join(projectRoot, PLUGINS_DIR));
  },

  install(projectRoot: string, pkgRoot: string): AgentInstallResult {
    const log: string[] = [];

    // Ensure the plugins dir + write the plugin file.
    const pluginsDir = path.join(projectRoot, PLUGINS_DIR);
    fs.mkdirSync(pluginsDir, { recursive: true });
    const pluginFile = path.join(pluginsDir, PLUGIN_FILENAME);
    fs.writeFileSync(pluginFile, pluginSource(pkgRoot), "utf-8");

    // Sandbox config + backup dir.
    const configDir = getConfigDir(projectRoot);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    saveConfig(DEFAULT_CONFIG, projectRoot);

    appendGitignore(projectRoot, ".chats-sandbox/");

    log.push("CHATS-Sandbox installed successfully for Hermes!");
    log.push(`  Plugin written to ${PLUGINS_DIR}/${PLUGIN_FILENAME}`);
    log.push(`  Config at ${configDir}/config.json`);
    log.push(`  Backups will be stored in ${DEFAULT_CONFIG.backupDir}/`);
    log.push("");
    log.push("On the next Hermes session, ToolRegistry will auto-load");
    log.push("this plugin and wrap every tool call with backup hooks.");
    log.push("");
    log.push("To check backup state: chats-sandbox status");
    log.push("To view timeline:      chats-sandbox dashboard");
    log.push("To disable:            chats-sandbox uninstall hermes");
    return { log };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const log: string[] = [];
    const pluginFile = path.join(projectRoot, PLUGINS_DIR, PLUGIN_FILENAME);
    if (fs.existsSync(pluginFile)) {
      fs.unlinkSync(pluginFile);
      log.push(`  Removed ${PLUGINS_DIR}/${PLUGIN_FILENAME}`);
    }
    // Don't delete .hermes/plugins/ itself — user might have other plugins.
    log.push("CHATS-Sandbox uninstalled from Hermes.");
    log.push("  Config and backups left in .chats-sandbox/ (delete manually if desired)");
    return { log };
  },
};
