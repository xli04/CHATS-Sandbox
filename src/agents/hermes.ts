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
    side effect on disk. The timeout must be GENEROUS — a tier-3
    subagent that scrapes remote state (e.g. a Hermes subagent driving
    Playwright MCP) can legitimately take 1-3 minutes. It must stay
    larger than config.subagentTimeoutSeconds, otherwise this wrapper
    kills the Node hook mid-backup and the artifact is lost. Past the
    cap we move on rather than block tool execution forever.
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
            timeout=600.0,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            env=child_env,
        )
    except Exception as e:
        logger.warning("chats-sandbox hook failed (%s): %s", hook_path, e)


# Set by attach(). Used to detect MCP tools so their names can be
# normalized — see _normalize_tool_name.
_registry = None


def _toolset_of(tool_name: str):
    """Return the registry toolset name for a tool, or '' if unknown."""
    reg = _registry
    if reg is None:
        return ""
    # Prefer the public-ish accessor; fall back to the _tools dict.
    getter = getattr(reg, "get_toolset_for_tool", None)
    if callable(getter):
        try:
            ts = getter(tool_name)
            if ts:
                return str(ts)
        except Exception:
            pass
    try:
        entry = getattr(reg, "_tools", {}).get(tool_name)
        if entry is not None:
            return str(getattr(entry, "toolset", "") or "")
    except Exception:
        pass
    return ""


def _normalize_tool_name(tool_name: str) -> str:
    """Map a Hermes MCP tool name to the mcp__<server>__<tool> form the
    Node hooks expect.

    Two remote-state cases get normalized:

      1. MCP tools — Hermes registers these under a toolset named
         'mcp-<server>' (tools/mcp_tool.py: toolset_name = f"mcp-{name}").

      2. Hermes's built-in 'browser' toolset — web automation whose
         browser_* tools mutate remote page state exactly like a
         Playwright MCP would. Same risk profile, so it gets the same
         tier-3 treatment.

    The CHATS-Sandbox hooks key tier-3 (remote-state) detection on the
    Claude-Code 'mcp__' double-underscore prefix; without this rewrite
    those actions never trigger the tier-3 subagent on Hermes.

    Non-remote tools (file I/O, shell, etc.) pass through unchanged.
    """
    toolset = _toolset_of(tool_name)
    server = None
    for sep in ("mcp-", "mcp_"):
        if toolset.startswith(sep):
            server = toolset[len(sep):]
            break
    # Built-in browser automation toolset → treat as a remote namespace.
    if not server and toolset == "browser":
        server = "browser"
    if not server:
        return tool_name
    # Strip a redundant mcp_<server>_ / mcp__<server>__ prefix that some
    # Hermes versions bake into the tool name itself, then re-wrap in
    # the canonical double-underscore form.
    bare = tool_name
    for pre in (f"mcp__{server}__", f"mcp_{server}_"):
        if bare.startswith(pre):
            bare = bare[len(pre):]
            break
    normalized = f"mcp__{server}__{bare}"
    if normalized != tool_name:
        logger.debug("chats-sandbox: normalized %s -> %s (toolset=%s)",
                     tool_name, normalized, toolset)
    return normalized


def _pre_hook(tool_name: str, args: dict) -> None:
    _run_hook(_PRE_TOOL_HOOK, {
        "hook_event": "PreToolUse",
        "tool_name": _normalize_tool_name(tool_name),
        "tool_input": args,
    })


def _post_hook(tool_name: str, args: dict, result: str) -> None:
    # The post hook also accepts hook_event="PostToolUseFailure" — but
    # Hermes's dispatch swallows tool errors into a JSON error string
    # and still returns a result, so we always send PostToolUse.
    _run_hook(_POST_TOOL_HOOK, {
        "hook_event": "PostToolUse",
        "tool_name": _normalize_tool_name(tool_name),
        "tool_input": args,
        "tool_output": result,
    })


def attach(registry) -> None:
    """Hermes calls this at ToolRegistry init time."""
    global _registry
    _registry = registry
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

    // Sandbox config + backup dir. The tier-3 subagent runs as a
    // headless `hermes chat` subagent (not `claude -p`), so a Hermes
    // deployment with no Claude CLI still gets working out-of-workspace
    // / remote-state backup. The subagent's provider API key is read
    // from the environment at run time — never written to config.
    const configDir = getConfigDir(projectRoot);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const hermesConfig = {
      ...DEFAULT_CONFIG,
      subagentRunner: "hermes" as const,
      subagentHermesModel: "anthropic/claude-haiku-4.5",
      subagentHermesProvider: "openrouter",
    };
    saveConfig(hermesConfig, projectRoot);

    appendGitignore(projectRoot, ".chats-sandbox/");

    log.push("CHATS-Sandbox installed successfully for Hermes!");
    log.push(`  Plugin written to ${PLUGINS_DIR}/${PLUGIN_FILENAME}`);
    log.push(`  Config at ${configDir}/config.json`);
    log.push(`  Backups will be stored in ${DEFAULT_CONFIG.backupDir}/`);
    log.push("");
    log.push("On the next Hermes session, ToolRegistry will auto-load");
    log.push("this plugin and wrap every tool call with backup hooks.");
    log.push("");
    log.push("Tier-3 (out-of-workspace / remote) backup runs a headless");
    log.push(`Hermes subagent: ${hermesConfig.subagentHermesModel}`);
    log.push(`via ${hermesConfig.subagentHermesProvider}. It needs:`);
    log.push("  - the `hermes` CLI on PATH");
    log.push("  - a provider API key in the environment (e.g.");
    log.push("    OPENROUTER_API_KEY) — inherited from the Hermes process.");
    log.push("Change the subagent model/provider with:");
    log.push("  chats-sandbox config set subagentHermesModel <id>");
    log.push("  chats-sandbox config set subagentHermesProvider <name>");
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
