/**
 * Tier-3 subagent backup via `claude -p` subprocess.
 *
 * When the hook detects an outside-workspace action that no targeted
 * manifest can cover, it shells out to Claude Code in headless mode
 * with a constrained prompt. The subagent runs synchronously, its
 * output is captured, parsed, and persisted to the action folder's
 * metadata.json as a `subagent` strategy artifact.
 *
 * Key safety properties:
 *   - CHATS_SANDBOX_NO_HOOK=1 is set in the subprocess environment,
 *     so the subagent's own tool calls won't re-trigger this hook
 *     (prevents infinite recursion).
 *   - Subprocess timeout is hard-limited via config.subagentTimeoutSeconds.
 *   - Any failure (claude CLI missing, timeout, parse error) falls back
 *     silently to just the tier-2 git snapshot.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
// js-yaml is LAZY-loaded (see loadYaml) — it's an external dep that may be
// absent in trimmed deployments (e.g. a benchmark container that ships only
// dist/). It's used solely by filteredHermesHome (hermes MCP filtering); the
// common backup path must never crash on a missing module at import time.
function loadYaml(): { load: (s: string) => unknown; dump: (o: unknown) => string } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("js-yaml");
  } catch {
    return null;
  }
}
import type { BackupArtifact, HookContext, SandboxConfig } from "../types.js";
import { describeToolAction } from "../types.js";
import { extractJsonObject } from "../util/extract_json.js";
import { serverFromToolName } from "../explore/experiences.js";

/** Shape of the JSON the subagent is instructed to return */
interface SubagentResponse {
  /** Short description of what was backed up */
  description: string;
  /** Commands the subagent ran to create the backup */
  backup_commands: string[];
  /** Commands to run for recovery (reverse the upcoming action) */
  recovery_commands: string[];
  /** Optional: paths to backup artifact files the subagent wrote */
  artifact_paths?: string[];
  /** True when the canned recovery_commands can't be trusted later
   *  (remote/dynamic state) and restore should spawn a fresh subagent
   *  instead of replaying the commands. */
  live_restore?: boolean;
  /** live_restore=false ONLY: the exact MCP tool call(s) that reverse a
   *  remote/MCP action, to be replayed verbatim at restore via tools/call.
   *  Each is {tool, args} (+ optional server). Empty/absent for live_restore
   *  reversals (those use recovery_commands prose) and local shell reversals. */
  recovery_mcp_calls?: Array<{ server?: string; tool: string; args: Record<string, unknown> }>;
  /** True when the subagent inspected the upcoming action and determined
   *  it is READ-ONLY — it changes nothing outside the workspace, so no
   *  backup is needed. Honored as a clean skip (no artifact, no warning),
   *  NOT a failure. Safe because tiers 0–2 still cover the workspace
   *  independently; this only suppresses the generic tier-3 backup. */
  no_backup_needed?: boolean;
}

function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Environment for spawned subagent processes.
 *   - CHATS_SANDBOX_NO_HOOK=1: recursion guard — the subagent's own tool
 *     calls fire our hooks; this makes them exit early in the subprocess.
 *   - IS_SANDBOX=1 (root only): `claude --dangerously-skip-permissions`
 *     refuses to run as root unless this is set. Sandboxed containers —
 *     this tool's primary deployment — routinely run as root, and without
 *     it every tier-3 backup fails instantly.
 */
function subagentEnv(): NodeJS.ProcessEnv {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  return {
    ...process.env,
    CHATS_SANDBOX_NO_HOOK: "1",
    ...(isRoot ? { IS_SANDBOX: "1" } : {}),
    // Browser MCP servers (playwright via npx) cold-start slowly — give
    // claude time to connect before the subagent's first tool call,
    // otherwise it reports "MCP still connecting" and skips the reversal.
    MCP_TIMEOUT: process.env.MCP_TIMEOUT || "60000",
  };
}

/**
 * Build the subprocess invocation for the tier-3 subagent, branching on
 * config.subagentRunner.
 *
 *   claude   — `claude -p <prompt> --output-format json …` (Claude Code).
 *   hermes   — `hermes chat -q <prompt> -m <model> --provider <p> -Q --yolo`
 *              (Hermes deployments). The provider API key is read from
 *              the environment (OPENROUTER_API_KEY etc.) inherited from
 *              the parent process — never stored in config.
 *   openclaw — `openclaw agent --local --json --session-id <fresh> -m
 *              <prompt>` (OpenClaw deployments). Same env-key contract.
 *
 * Returns null when the configured runner's CLI isn't on PATH, so the
 * caller degrades gracefully (skip backup / report restore failure)
 * exactly as it did for the missing-claude case.
 */
export function buildSubagentInvocation(
  prompt: string,
  config: SandboxConfig,
  opts?: { withMcp?: boolean; isolateBrowserProfile?: boolean; neededServer?: string | null; maxTurns?: number; toolAllow?: string[] },
): { bin: string; args: string[]; runner: "claude" | "hermes" | "openclaw" | "codex"; env?: Record<string, string> } | null {
  const runner = config.subagentRunner ?? "claude";

  if (runner === "codex") {
    if (!isCommandAvailable("codex")) return null;
    // Headless one-shot turn. IMPORTANT: codex exec waits on stdin when
    // it's an open pipe ("Reading additional input from stdin…"), so
    // the spawn site passes input: "" to close it immediately.
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--sandbox", "danger-full-access",
    ];
    if (config.subagentCodexModel) {
      args.push("-m", config.subagentCodexModel);
    }
    args.push(prompt);
    return { bin: "codex", args, runner };
  }

  if (runner === "openclaw") {
    if (!isCommandAvailable("openclaw")) return null;
    // Headless one-shot turn on the embedded agent. A fresh session id
    // keeps the backup turn out of the user's conversation history.
    // The plugin's CHATS_SANDBOX_NO_HOOK guard (set via subagentEnv)
    // stops the subagent's own tool calls from re-entering our hooks.
    const args = [
      "agent", "--local", "--json",
      "--session-id", `chats-sandbox-${Date.now().toString(36)}`,
      "-m", prompt,
    ];
    if (config.subagentOpenclawModel) {
      args.push("--model", config.subagentOpenclawModel);
    }
    return { bin: "openclaw", args, runner };
  }

  if (runner === "hermes") {
    if (!isCommandAvailable("hermes")) return null;
    const model = config.subagentHermesModel || "anthropic/claude-haiku-4.5";
    const provider = config.subagentHermesProvider || "openrouter";
    // Dynamic MCP loading: for an MCP/browser action, hand hermes a HOME
    // whose config loads ONLY that action's server (skip booting chromium
    // for a DB action, etc.). null/undefined server → keep the global config.
    let env: Record<string, string> | undefined;
    if (opts?.neededServer) {
      const home = filteredHermesHome(opts.neededServer, opts.isolateBrowserProfile, opts.toolAllow);
      // Point hermes at the filtered home via BOTH HOME and HERMES_HOME. hermes
      // resolves its config dir as getenv("HERMES_HOME", ~/.hermes) — it checks
      // HERMES_HOME FIRST, so relying on HOME alone is unreliable (an inherited
      // HERMES_HOME, or a hermes launcher that resets HOME, sends it back to the
      // GLOBAL config — which still pins the agent's live /tmp browser profile,
      // causing the subagent's playwright to collide on the locked profile).
      if (home) env = { HOME: home, HERMES_HOME: path.join(home, ".hermes") };
    }
    // Lean toolset: a backup subagent only needs to run shell/file commands
    // (and the action's MCP for remote backups). Restricting to these strips
    // the skills catalog + persistent-memory boilerplate from hermes's system
    // prompt — ~2.3k tokens of dead weight per call. The main agent already
    // does this; the subagent now matches.
    const toolsets = "terminal,file" + (opts?.neededServer ? `,mcp-${opts.neededServer}` : "");
    return {
      bin: "hermes",
      runner,
      env,
      // -Q quiet (programmatic), --yolo skip approval prompts so the
      // headless subagent can run git/bash without blocking. --max-turns
      // hard-bounds the loop (strict pass passes a tight 6; the default 90
      // let qwen burn ~80s "still thinking").
      args: ["chat", "--toolsets", toolsets, "-q", prompt, "-m", model, "--provider", provider, "-Q", "--yolo", "--max-turns", String(opts?.maxTurns ?? 15)],
    };
  }

  // Default: claude -p
  if (!isCommandAvailable("claude")) return null;
  const permissionMode = config.subagentPermissionMode ?? "bypassPermissions";
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--no-session-persistence",
    "--setting-sources", "user",
  ];
  if (permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", permissionMode);
  }
  if (config.subagentModel && config.subagentModel !== "inherit") {
    args.push("--model", config.subagentModel);
  }
  // Hand the subagent the same MCP tools the agent used (e.g. a postgres
  // server, or a playwright browser) so it can READ pre-state at backup
  // time and REVERSE state at restore time through the real interface —
  // no privileged DB backdoor assumed. At BACKUP time the agent's browser
  // is still live, so a shared browser profile would collide on the
  // single-instance lock; isolateBrowserProfile gives the subagent its own
  // (auth-seeded) copy. Non-browser MCP servers have no such collision.
  if (opts?.withMcp && config.subagentMcpConfig) {
    if (opts.neededServer) {
      // Dynamic MCP loading: only this action's server, and ignore every
      // other MCP source (--strict-mcp-config).
      args.push("--mcp-config",
        filteredClaudeMcpConfig(config.subagentMcpConfig, opts.neededServer, !!opts.isolateBrowserProfile));
      args.push("--strict-mcp-config");
    } else {
      args.push("--mcp-config",
        opts.isolateBrowserProfile ? isolatedMcpConfig(config.subagentMcpConfig) : config.subagentMcpConfig);
    }
  }
  return { bin: "claude", args, runner };
}

/**
 * Produce a temp MCP-config whose browser server (if any) uses its OWN
 * `--user-data-dir` — a copy of the agent's profile, so it inherits the
 * logged-in session but holds a SEPARATE lock. This lets the backup
 * subagent open a browser to read pre-action state while the agent's
 * browser is still live. Non-browser servers pass through unchanged.
 * Best-effort: on any failure, returns the original config path.
 */
export function isolatedMcpConfig(mcpPath: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(mcpPath, "utf-8")) as {
      mcpServers?: Record<string, { args?: unknown[] }>;
    };
    const servers = raw.mcpServers ?? {};
    let rewrote = false;
    for (const name of Object.keys(servers)) {
      const args = servers[name].args;
      if (!Array.isArray(args)) continue;
      const i = args.indexOf("--user-data-dir");
      if (i >= 0 && typeof args[i + 1] === "string") {
        const orig = String(args[i + 1]);
        const copy = path.join(os.tmpdir(), `chats-sub-profile-${process.pid}-${name}`);
        try { fs.rmSync(copy, { recursive: true, force: true }); } catch { /* ignore */ }
        // Copy the LIVE profile. This frequently throws partway because the
        // agent's browser is mutating files under it — that's fine, the login
        // cookies land early; we just must not let the throw skip the lock
        // strip below (the bug that left SingletonLock in the copy and made
        // the subagent's browser report "locked by parent").
        // Copy the profile with a FAULT-TOLERANT shell `cp`, not fs.cpSync:
        // the agent's browser is actively writing the LIVE profile, and
        // cpSync THROWS on the first busy/locked file, leaving NO copy at all
        // (the bug: subagent then gets a broken profile → "locked by parent").
        // `cp` logs per-file errors but keeps going, so the auth files
        // (Cookies, Local Storage) still land. Errors are swallowed (|| true).
        try {
          if (fs.existsSync(orig)) {
            const { execSync } = require("node:child_process");
            fs.mkdirSync(copy, { recursive: true });
            execSync(`cp -a -- '${orig.replace(/'/g, "'\\''")}/.' '${copy.replace(/'/g, "'\\''")}/' 2>/dev/null || true`,
              { timeout: 60_000 });
          }
        } catch { /* partial copy is acceptable — login cookies land early */ }
        // Belt-and-suspenders strip of any Singleton* that slipped through.
        // MUST use unlinkSync, NOT rmSync: rmSync follows the symlink to its
        // (dangling, hostname-pid) target and no-ops, leaving the link behind.
        try {
          for (const f of (fs.existsSync(copy) ? fs.readdirSync(copy) : [])) {
            if (f.startsWith("Singleton")) {
              try { fs.unlinkSync(path.join(copy, f)); } catch { /* ignore */ }
            }
          }
        } catch { /* ignore */ }
        args[i + 1] = copy;
        rewrote = true;
      }
    }
    if (!rewrote) return mcpPath;
    const out = path.join(os.tmpdir(), `chats-sub-mcp-${process.pid}.json`);
    fs.writeFileSync(out, JSON.stringify(raw));
    return out;
  } catch {
    return mcpPath;
  }
}

/**
 * Dynamic MCP loading (claude runner): write a `--mcp-config` containing
 * ONLY the server this action uses, so a postgres action doesn't boot the
 * browser MCP (and vice-versa). Combine with `isolatedMcpConfig` when the
 * kept server is a browser. Returns the temp config path (falls back to the
 * original on any error).
 */
function filteredClaudeMcpConfig(mcpPath: string, neededServer: string, isolateBrowser: boolean): string {
  try {
    const raw = JSON.parse(fs.readFileSync(mcpPath, "utf-8")) as { mcpServers?: Record<string, unknown> };
    const all = raw.mcpServers ?? {};
    const kept: Record<string, unknown> = {};
    if (all[neededServer]) kept[neededServer] = all[neededServer];
    const outPath = path.join(os.tmpdir(), `chats-sub-filtered-${process.pid}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ mcpServers: kept }));
    return isolateBrowser ? isolatedMcpConfig(outPath) : outPath;
  } catch {
    return mcpPath;
  }
}

/**
 * Dynamic MCP loading (hermes runner): hermes always reads
 * `$HOME/.hermes/config.yaml` and has no per-call MCP flag, so give the
 * subagent its OWN HOME — a copy of the user's `.hermes` (auth/sessions
 * preserved) whose `mcp_servers` is filtered to ONLY the needed server.
 * Returns the temp HOME dir, or null to keep the global config.
 */
function filteredHermesHome(neededServer: string, isolateBrowserProfile?: boolean, toolAllow?: string[]): string | null {
  try {
    const srcHomeDir = path.join(os.homedir(), ".hermes");
    const srcCfg = path.join(srcHomeDir, "config.yaml");
    if (!fs.existsSync(srcCfg)) return null;
    // The home name keys on process.pid and is pre-wiped below. Each tool-call
    // hook is a fresh short-lived process, so on a multi-backup run the OS can
    // reuse a pid and this pre-wipe would delete a PRIOR backup's home (its
    // session log + request dumps) before anything reads it. For benchmark
    // forensics (CHATS_KEEP_SUBAGENT_HOME=1) give every call a UNIQUE home and
    // never pre-wipe, so prior backups' artifacts survive for capture. Default
    // behavior is unchanged (pid-named + pre-wiped).
    const _keepHome = process.env.CHATS_KEEP_SUBAGENT_HOME === "1";
    const _suffix = _keepHome
      ? `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : String(process.pid);
    const tmpHome = path.join(os.tmpdir(), `chats-sub-home-${_suffix}`);
    if (!_keepHome) fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.cpSync(srcHomeDir, path.join(tmpHome, ".hermes"), { recursive: true });
    const yaml = loadYaml();
    if (!yaml) return null; // no js-yaml → skip MCP filtering, use global config
    const cfg = (yaml.load(fs.readFileSync(srcCfg, "utf-8")) ?? {}) as { mcp_servers?: Record<string, unknown> };
    const all = cfg.mcp_servers ?? {};
    cfg.mcp_servers = all[neededServer] ? { [neededServer]: all[neededServer] } : {};

    // Action-aware tool allowlist: register ONLY the tools the CALLER passed
    // (via hermes' `mcp_servers.<name>.tools.include`), cutting the per-call
    // tool-schema cost without losing coverage. Uses raw (unprefixed) MCP tool
    // names. There is NO hardcoded per-server tool map: a caller that passes no
    // `toolAllow` (the backup path, restore) leaves the server UNFILTERED — its
    // own tools, the safe default. The only current caller that narrows is
    // self-exploration's verify, which derives the set from the server's OWN
    // live tools (not a curated guess), so this stays fully server-general.
    const allow = toolAllow;
    const kept0 = cfg.mcp_servers[neededServer];
    if (allow && kept0 && typeof kept0 === "object" && !Array.isArray(kept0)) {
      const srv = kept0 as Record<string, unknown>;
      const existing = (srv.tools && typeof srv.tools === "object") ? srv.tools as Record<string, unknown> : {};
      srv.tools = { ...existing, include: allow };
    }

    // Shared-live-browser design (replaces the old profile-copy isolation):
    // the playwright server now runs in HTTP mode and the kept config carries
    // a `url:` entry, NOT a stdio `command`/`--user-data-dir`. The subagent
    // connects to the SAME shared browser the main agent uses, so there is no
    // profile to copy and no single-instance lock to strip — it reads the TRUE
    // live pre-state (the main is paused on the exact pre-mutation page) and
    // works in its OWN tab. `isolateBrowserProfile` is therefore a no-op for a
    // url server; we keep the parameter only for the (legacy) stdio path and
    // the Claude-runner equivalent. If a kept server still has a stdio
    // `--user-data-dir` (no url), we deliberately do NOT copy it: with the
    // shared server the copy was the source of lock/symlink/stale-snapshot
    // bugs the new design eliminates.
    void isolateBrowserProfile;
    fs.writeFileSync(path.join(tmpHome, ".hermes", "config.yaml"), yaml.dump(cfg));
    return tmpHome;
  } catch {
    return null;
  }
}

/**
 * Write a status message directly to the user's controlling terminal.
 *
 * Claude Code captures hook stderr silently (it doesn't display in the
 * user's terminal), so this is the only way to show real-time progress.
 * /dev/tty bypasses stderr/stdout entirely and writes to whichever
 * terminal the user is sitting at.
 *
 * Falls back silently if /dev/tty is not writable (Windows, headless,
 * piped contexts).
 */
function tellUser(message: string): void {
  try {
    fs.writeFileSync("/dev/tty", `${message}\n`);
  } catch {
    // /dev/tty not available — fall back to stderr (visible in some setups)
    try {
      process.stderr.write(`${message}\n`);
    } catch {
      // give up
    }
  }
}

/** The tier-3 subagent prompt = the "subagent"-mode shared backup guidance. */
function buildSubagentPrompt(
  ctx: HookContext,
  actionDir: string,
  config?: SandboxConfig,
): string {
  return buildBackupGuidance({
    mode: "subagent",
    toolName: ctx.tool_name,
    command: String(ctx.tool_input.command ?? ""),
    args: JSON.stringify(ctx.tool_input, null, 2),
    cwd: process.cwd(),
    actionDir,
    config,
  });
}

/** Options for {@link buildBackupGuidance}. */
export interface BackupGuidanceOpts {
  mode: "subagent" | "inline";
  toolName?: string;
  command?: string;
  args?: string;
  cwd?: string;
  actionDir?: string;
  config?: SandboxConfig;
  /** Override the resolved MCP server (e.g. "playwright" for the inline reddit lane). */
  server?: string | null;
  /** Explicit experience to inject (else derived from the server). */
  experienceName?: string;
}

/** SHARED backup knowledge for BOTH the tier-3 subagent and the inline-backup
 *  baseline, so the two can never drift. `mode` only changes the wrapper — the
 *  header, the "you're blocking / HARD LIMIT" line, and the result handoff. The
 *  PIN rule, browser directive, experiences, and category strategies are
 *  identical across modes. */
export function buildBackupGuidance(opts: BackupGuidanceOpts): string {
  const { mode, config } = opts;
  const toolName = opts.toolName ?? "";
  const command = opts.command ?? "";
  const args = opts.args ?? "";
  const cwd = opts.cwd ?? process.cwd();
  const actionDir = opts.actionDir ?? "<backup-storage-dir>";

  // Resolve the action's MCP server via the listed tool registry (membership
  // — robust to bare names), falling back to name-parsing. Used both to pick
  // the experience and to give browser actions a content-pinning directive.
  let server: string | null = opts.server ?? null;
  if (!server && toolName) {
    try {
      const { serverFromToolName } = require("../explore/experiences.js");
      const { loadToolRegistry, serverForTool } = require("../explore/tool_registry.js");
      server = serverForTool(toolName, loadToolRegistry(config ?? ({} as SandboxConfig)))
        || serverFromToolName(toolName);
    } catch { /* ignore */ }
  }
  const isBrowser = server === "playwright";

  // Inject the learned backup SKILL for this MCP server (from
  // `chats-sandbox explore`). Prefer-cheap-reversal guidance.
  // ABLATION KNOB: CHATS_SANDBOX_NO_EXP_INJECT=1 suppresses ONLY this prompt
  // block. Everything else the experience file drives — the gate's learned
  // triggers, deterministic reverters, capture_tools tool-narrowing — stays
  // active, so an ablation can isolate the value of the injected knowledge
  // itself (arms differ in the subagent prompt and nothing else).
  let experienceBlock = "";
  if (config && process.env.CHATS_SANDBOX_NO_EXP_INJECT !== "1") {
    try {
      const { loadExperiences, renderExperiencesForPrompt, serverToExperienceMap } =
        require("../explore/experiences.js");
      // server → experience. Dedicated MCPs match by name (postgres →
      // postgres); a browser-driven site differs, bridged by the experience's
      // appliesTo (reddit.appliesTo=["playwright"]) or experienceForServer.
      const map = serverToExperienceMap(config);
      const expName = opts.experienceName || (server && (config.experienceForServer?.[server] || map[server])) || server;
      if (expName) {
        experienceBlock = renderExperiencesForPrompt(loadExperiences(config, expName));
      }
    } catch { /* experiences optional */ }
  }

  // Browser (playwright) actions create entities with NO id at backup time,
  // so the recovery must PIN BY CONTENT. Read the form/page and capture the
  // identifying text verbatim — the exact TITLE for a post/submission, the
  // FULL text for a comment — so restore targets that one entity, not "the
  // most recent". This is the targeted version of the generic PIN-THE-TARGET
  // rule, and the fix for create-via-browser deleting the wrong post.
  // The values the agent just typed (title/body) — captured by the hook from
  // the earlier fill/type actions, so the subagent doesn't have to re-derive
  // the title from a live browser snapshot.
  let recentInputBlock = "";
  if (isBrowser && config) {
    try {
      const { loadRecentBrowserInput } = require("./strategies.js");
      const recent: string[] = loadRecentBrowserInput(config);
      if (recent.length) {
        recentInputBlock = `\n  **VALUES THE AGENT JUST TYPED** (use these as the EXACT title/body — do NOT re-derive or guess): ${recent.map((v) => JSON.stringify(v)).join(" , ")}`;
      }
    } catch { /* optional */ }
  }
  // PRE-STATE (subagent only): the agent's last page VIEW (snapshot/navigate)
  // = WHERE the change happens + the ORIGINAL values. Sourced from the PAGE, so
  // it works even when the mutation was a browser_run_code_unsafe (which hides
  // its action in a `code` arg, blind to recentInputBlock). GATE: if no fresh
  // view, say so and FORBID fabrication — fail to UNVERIFIED, not a wrong recovery.
  let preStateBlock = "";
  if (config && (isBrowser || toolName.startsWith("mcp__"))) {
    try {
      const { loadRecentBrowserSnapshot } = require("./strategies.js");
      const snap = loadRecentBrowserSnapshot(config);
      if (snap && snap.text) {
        preStateBlock = `
**THE ORIGINAL PRE-STATE is in PAGE_STATE below** — the agent's last page view BEFORE this action (URL: ${snap.url || "unknown"}).
**You have NO browser. Write the recovery DIRECTLY from PAGE_STATE** — do not browse, do not navigate, do not guess.
<<<PAGE_STATE
${snap.text}
PAGE_STATE>>>
  - **EDIT** → recovery = restore the field to the ORIGINAL value shown in PAGE_STATE. Put that original VERBATIM in recovery_commands; NEVER the just-typed new value.
  - **DELETE** → capture the entity's CURRENT content from PAGE_STATE into remote-state.json.
  - **CREATE** → the new entity isn't in the page yet; pin it by the typed values above.
  PAGE_STATE may include a "PRE-CAPTURED FORM CONTROLS ... = [...]" digest: a JSON list of the page's editable fields with their ORIGINAL values. A field PRESENT in that list IS the captured pre-state — if its "value" is "" that means the field was genuinely EMPTY (restore it to empty), NOT "not captured". Use the field's listed value VERBATIM as the original.
  **ONLY IF the field you need is ENTIRELY ABSENT from PAGE_STATE** (not listed in the digest AND not in the page text): DO NOT fabricate (no assumed-empty, no turning an edit into "delete the post"). Instead set live_restore=true and begin the description with EXACTLY "UNVERIFIED: pre-state value not in snapshot" so a restore step re-derives instead of replaying a wrong command.`;
      } else {
        preStateBlock = `
**NO PRE-STATE PAGE VIEW AVAILABLE** — you were NOT handed the page the agent is on, so the ORIGINAL value is unknown to you. If you can read the current state with your tools, do so. If you CANNOT, do NOT fabricate (do NOT assume the original was empty; do NOT turn an edit into "delete the post"): set live_restore=true and put "UNVERIFIED: pre-state not captured" in the description so a restore agent re-derives instead of replaying a wrong command.`;
      }
    } catch { /* optional */ }
  }
  // Split for cache friendliness: the pin RULES are per-server static (join
  // the cached prefix); only the typed VALUES are per-action (dynamic tail).
  const browserPinStatic = isBrowser ? `
**BROWSER ACTION — PIN THE NEW ENTITY BY CONTENT** (it has no id yet):
  The exact text being committed is in the typed values (see DYNAMIC CONTEXT below, preferred) or one snapshot of the form; put it VERBATIM in recovery_commands:
  - creating a POST/submission → capture the exact TITLE (e.g. recovery: "delete the submission whose title == '<exact title>'").
  - creating a COMMENT/reply  → capture the FULL comment text (it has no title; the body IS the identifier).
  - editing → capture the entity's id/title AND the original text to restore.
  NEVER target by position/recency ("the most recent", "the first") — that deletes the WRONG entity.
` : "";
  // Inline mode renders once (no prefix caching) — keep the combined form.
  const browserPinDirective = isBrowser ? `${browserPinStatic}${recentInputBlock ? `${recentInputBlock}\n` : ""}` : "";

  // Guidance (GENERAL — "capture / confirm / write", not tied to any one
  // MCP server) to keep the backup fast. This is a PROMPT instruction, not
  // a hard cap — the watcher wrapper still ends the run once the result is
  // written, so an over-eager model can't drag the tail out either way.
  const directive = mode === "inline" ? `For EACH step that creates / edits / deletes state OUTSIDE your workspace (a file outside the project, a package install, an env change, a remote / MCP / browser / database mutation) and would be hard to undo: CAPTURE what you need to reverse it, perform the step, then RECORD the reversal (see RECOVERY NOTE FORMAT). Take the target + method from the LEARNED BACKUP SKILL and the matching strategy below.
**PIN THE TARGET:** if the action creates / edits / deletes an identifiable entity (a record, post, comment, row, file, ticket, document…), your recovery MUST identify that EXACT entity by a captured STABLE IDENTIFIER — its id, or a unique attribute (exact title/key) when the id does not exist yet (a fresh create). Capture that identifier NOW. NEVER target by position or recency ("the most recent", "the first", "the latest") — that reverses the WRONG entity. For a create, the reversal is "delete the entity whose <id/title> == <captured value>"; for an edit, "restore <id>'s field to <captured original>".` : `**BE FAST** — you are blocking the agent. **TWO steps only:**
  **STEP 1 — CAPTURE** the state the upcoming action will change, in as FEW calls as possible (ideally one). Take the target + method from the TRIGGERING ACTION + the LEARNED BACKUP SKILL below; if a pattern matches, apply it as-is.
  **STEP 2 — WRITE the result JSON** (see OUTPUT FORMAT), then STOP.
**HARD LIMIT ~3 calls** (a 4th FAILS the backup). **Do NOT explore / list / enumerate / navigate / re-read / verify** — the action + patterns already tell you exactly what to capture.
**PIN THE TARGET** by a captured **stable identifier** — its id, or a unique attribute (exact title/key) for a fresh create. **NEVER by position or recency** ("the most recent", "the first") — that reverses the WRONG entity. Create → "delete the entity whose <id/title> == <captured value>"; edit → "restore <id>'s field to <captured original>".`;

  // ── Action-category dispatch ──────────────────────────────────────────
  // The plugin already knows the action type, so send ONLY the relevant
  // backup STRATEGY rather than the whole A–R catalog (~2.1k tokens of which
  // only one block ever applies on any given call). Categories E (anything-
  // else) + R (read-only) compress into a two-sentence fallback appended to
  // every dispatch. Category text is kept verbatim from the prior catalog.
  const CAT_A = `### Category A: Local file write outside the current workspace
Example: Write tool with path /Users/foo/other_project/src/file.ts

STRATEGY — shadow git repo scoped to the AFFECTED FILES ONLY:
1. Pick the work-tree root: the affected file's parent directory (or the
   nearest project marker like .git/package.json if one is close). The
   root may be a big shared directory — that is fine because you will
   only ever add the affected file(s), never the whole tree.
2. Create a shadow git repo at <STORAGE_DIR>/external-shadow/:
     mkdir -p '<STORAGE_DIR>/external-shadow'
     GIT_DIR='<STORAGE_DIR>/external-shadow' GIT_WORK_TREE='<root>' git init
     GIT_DIR='<STORAGE_DIR>/external-shadow' GIT_WORK_TREE='<root>' git config user.email "chats-sandbox@local"
     GIT_DIR='<STORAGE_DIR>/external-shadow' GIT_WORK_TREE='<root>' git config user.name "CHATS-Sandbox"
     GIT_DIR='<STORAGE_DIR>/external-shadow' GIT_WORK_TREE='<root>' git add -- <affected file(s), relative to root>
     GIT_DIR='<STORAGE_DIR>/external-shadow' GIT_WORK_TREE='<root>' git commit -m "pre-action snapshot" --allow-empty-message
   NEVER use \`git add -A\` here — the root may contain gigabytes of
   unrelated files.
3. Record the root path and the commit hash.
4. recovery_commands — two-step restore of exactly those files:
     GIT_DIR='<STORAGE_DIR>/external-shadow' GIT_WORK_TREE='<root>' git read-tree <hash>
     GIT_DIR='<STORAGE_DIR>/external-shadow' GIT_WORK_TREE='<root>' git checkout-index -f -a
   If the upcoming action CREATES a file that does not exist yet, the
   recovery for that file is an explicit \`rm '<absolute path>'\` instead.
   NEVER include \`git clean -fd\` in recovery_commands: on a shared
   work-tree it deletes every unrelated untracked file under the root.`;

  const CAT_B = `### Category B: Remote state (git push, curl POST/PUT/DELETE, API calls)
STRATEGY — document recovery for out-of-band state:
- For git push: create a local git tag at the current HEAD (backup_commands), and provide recovery_commands that would force-push the tag back if needed.
- For remote API calls: you likely can't back up the remote state. Document what would be needed for manual recovery in description.`;

  const CAT_C = `### Category C: System package install/uninstall (pip, npm, apt, brew)
STRATEGY — save a manifest:
- pip install → pip freeze > <STORAGE_DIR>/pip_freeze.txt, recovery = pip install -r that file
- npm install -g → npm list -g --json > <STORAGE_DIR>/npm_list.json
- apt install → dpkg --get-selections > <STORAGE_DIR>/apt_list.txt
- brew install → brew list > <STORAGE_DIR>/brew_list.txt`;

  const CAT_D = `### Category D: Environment variable mutation (export, unset, source)
STRATEGY — snapshot env vars: env > <STORAGE_DIR>/env.txt`;

  const CAT_F = `### Category F: Remote state via an MCP tool (mcp__*)
The TRIGGERING ACTION above already names the exact tool + args being changed — you do NOT need to discover anything.

1. CAPTURE pre-state ONLY IF the action edits/deletes existing state: with the SAME MCP, read EXACTLY the affected entity (one call) and write the ACTUAL DATA verbatim — not a summary — to <STORAGE_DIR>/remote-state.json with enough fields to recreate it (id, parent id, title, body, timestamps…). For a SQL DELETE/UPDATE capture the affected rows (SELECT * with the SAME WHERE clause); for DROP/TRUNCATE the whole table; page through large results, do not truncate. (A fresh CREATE has no prior state — pin its identifier instead.) Do NOT navigate / list / enumerate to "understand" the system — read only the one affected entity, or nothing.

2. **RECORD the true inverse of the action's EFFECT** (not the UI interaction):
   - **DESTRUCTIVE** (delete/close/remove/archive) → recovery RE-CREATES the captured state.
   - **CONSTRUCTIVE** (create/insert/send/post/add) → recovery DELETES the entity this action created, by its captured id/unique key (never by position).
   - **MUTATING** (edit/update/rename) → recovery RESTORES the prior content from remote-state.json.

3. **CHOOSE THE RECOVERY FORM** — two mutually-exclusive modes:
   - **DETERMINISTIC (live_restore:false):** the reversal is a fixed MCP call you can write out NOW. Put it in recovery_mcp_calls as {"tool":"<a tool on THIS server>","args":{…}} using this server's own tool/arg shapes; leave recovery_commands EMPTY. e.g. a deleted row → {"tool":"execute_sql","args":{"sql":"INSERT …"}}.
   - **LIVE (live_restore:true):** reversing genuinely needs CURRENT state read at restore (refs/layout shift — typical of browser/UI). Leave recovery_mcp_calls EMPTY and describe the fix as prose in recovery_commands.
   **Prefer DETERMINISTIC** whenever the reversal is a self-contained MCP call.

If the MCP exposes no clean read-side counterpart, save what you can (URL/DOM) and emit a JSON note — SOMETHING beats nothing.`;

  // Classify from what the plugin already knows; pick ONE strategy block.
  const pickCategory = (): string => {
    if (isBrowser || toolName.startsWith("mcp__")) return CAT_F;
    if (/\b(pip3?|npm|yarn|pnpm|apt|apt-get|brew|conda|gem|cargo)\b[^\n]*\binstall\b/.test(command)) return CAT_C;
    if (/\bgit\s+push\b/.test(command) ||
        (/\bcurl\b/.test(command) && (/-X\s*(POST|PUT|DELETE|PATCH)/i.test(command) || /(--data|\s-d\s|\s-F\s)/.test(command)))) return CAT_B;
    if (/(^|\s)(export|unset|source)\s/.test(command)) return CAT_D;
    if (/^(Write|Edit|MultiEdit|patch|str_replace)$/i.test(toolName) ||
        /(>|>>|\btee\b|\bcp\b|\bmv\b|\bdd\b|\btruncate\b|install\s+-)/.test(command)) return CAT_A;
    return "";
  };
  const picked = pickCategory();
  const categoryGuidance = mode === "inline" ? `## HOW TO BACK UP EACH ACTION
Apply the strategy that matches each action. The common case in this task is a remote / MCP / browser mutation:
${CAT_F}
For other action types — a local file write outside the project, a package install (pip/npm/apt/brew), or an env change — apply the analogous "capture the prior state, then record the exact inverse" strategy. If an action only READS (mutates nothing outside the workspace), it needs no backup.` : `## HOW TO BACK UP THIS ACTION
${picked ? `\n${picked}\n` : ""}
If the action is READ-ONLY (only reads/inspects, mutates nothing outside the workspace) return no_backup_needed:true with empty backup_commands/recovery_commands — be conservative, only when CERTAIN it mutates nothing. If nothing above fits, capture whatever recoverable state you can into <STORAGE_DIR> or clearly document what cannot be recovered.`;

  if (mode === "inline") {
    const persistDir = `${cwd}/.chats-sandbox/inline-backups`;
    return `You are completing a normal task. In ADDITION to doing it, you must record how to reverse every action that changes state OUTSIDE your workspace, so it can be undone later.

${directive}
${browserPinDirective}${experienceBlock}

${categoryGuidance}

(Wherever the instructions above say <STORAGE_DIR>, use ${persistDir})

## RECOVERY NOTE FORMAT — RECORD **AND PERSIST TO DISK** (a recovery is only usable if it survives)
After performing each out-of-workspace action, do ALL of the following:

1. CAPTURE pre-state when the action DELETES or EDITS existing state: first use the SAME MCP/tools to read that state and WRITE it (the actual data, verbatim — not a summary) to a file under ${persistDir}/ (e.g. remote-state.json) with your write-file tool, so a future restore can re-create it. (A fresh CREATE has no prior state — pin its identifier instead, per above.)

2. PERSIST the recovery: with your write-file tool, write a JSON object to ${persistDir}/recovery_<short-unique-id>.json with EXACTLY this shape:
     {"description":"...","recovery_commands":["..."],"artifact_paths":["..."],"live_restore":false,"no_backup_needed":false}
   - recovery_commands: the exact inverse (e.g. "delete the submission whose title == '<exact title>'", "pip install -r <freeze>", or a file restore). For a create → delete-by-pinned-identifier; for an edit → restore the original from the captured file.
   - live_restore: false when the recovery is a fixed, replayable command; true when reversing needs LIVE state at restore (a web/UI reversal — element refs/layout move).
   - This written file is the AUTHORITATIVE backup artifact.

3. ALSO emit the same recovery note inline, wrapped in [BACKUP] and [/BACKUP], mirroring the persisted file, so it is visible in your transcript.

You DO perform the actions — you are not only backing up.`;
  }

  // ── PROMPT ORDER = CACHE ORDER ────────────────────────────────────────
  // Providers cache on an identical PREFIX, so the prompt is assembled
  // static-first: [identity + directive + category strategy + output format]
  // is byte-identical across calls, [experience block] is per-server static,
  // and everything per-action (triggering action, PAGE_STATE, typed values,
  // paths) lives in the DYNAMIC CONTEXT tail. The static blocks refer to the
  // storage path as <STORAGE_DIR>; the tail binds it to the real path.
  return `You are a backup subagent for CHATS-Sandbox. A tool call is about to execute that affects state OUTSIDE the workspace. Your job: **actually CREATE a minimal recovery artifact BEFORE the action runs**, then report what you did as a single JSON object.

${directive}
${browserPinStatic}
${categoryGuidance}
${experienceBlock}

## OUTPUT FORMAT

Your **result** is a single JSON object, **separate from any artifact file** (remote-state.json, dumps — those are NOT the result). As your **very last step**, write it to **<STORAGE_DIR>/subagent_result.json** (also print to stdout as a fallback; the file is authoritative). Exact shape:

{"description":"...","backup_commands":["..."],"recovery_commands":["..."],"recovery_mcp_calls":[{"tool":"...","args":{}}],"artifact_paths":["..."],"live_restore":false,"no_backup_needed":false}

- **description**: short summary.
- **backup_commands**: the commands you ACTUALLY RAN to create the backup.
- **recovery_commands**: how to reverse the action. For a LOCAL shell reversal (file/package/env) — run verbatim by restore. For a LIVE remote reversal (live_restore:true) — PROSE the restore subagent follows via the MCP. **EMPTY for a deterministic remote reversal** (use recovery_mcp_calls instead).
- **recovery_mcp_calls**: deterministic remote/MCP reversal ONLY (live_restore:false) — the exact call(s) replayed VERBATIM at restore: {"tool":"<a tool on the action's own server>","args":{…}} (optional "server" to override). EMPTY for live or local-shell reversals.
- **artifact_paths**: files you created in the storage directory.
- **live_restore**: **false** when the reversal is a fixed, replayable command/MCP call (most backups); **true** only when reversing needs CURRENT state read at restore (web/UI — refs/layout move).
- **no_backup_needed**: **true ONLY when the action is READ-ONLY** (changes nothing outside the workspace), with backup/recovery empty. Default false; be conservative.

## DYNAMIC CONTEXT (this action)
${recentInputBlock}
TRIGGERING ACTION (what is about to change state):
  Tool: ${toolName}
  Args: ${args}
  Command: ${command}
${preStateBlock}

WORKSPACE (files inside this directory are already captured by tier-2 git snapshot):
  ${cwd}

BACKUP STORAGE DIRECTORY — this is <STORAGE_DIR>: substitute it wherever the instructions above say <STORAGE_DIR>, and write any artifact files here:
  ${actionDir}

**CRITICAL:** **DO NOT execute the upcoming action** — you only back it up. **Actually RUN your backup_commands** (don't just describe them). The LAST thing you do is **write ${actionDir}/subagent_result.json**. Keep the JSON **under 2KB**. **NEVER ask for clarification** or present options — decide yourself and act.`;
}

/** Validate + normalize a candidate object into our SubagentResponse
 *  shape, or null if it doesn't match. Module-scoped so both the
 *  result-file reader and the stdout parser can use it. */
function extractOurShape(candidate: unknown): SubagentResponse | null {
  if (
    typeof candidate === "object" && candidate !== null &&
    typeof (candidate as Record<string, unknown>).description === "string" &&
    Array.isArray((candidate as Record<string, unknown>).backup_commands) &&
    Array.isArray((candidate as Record<string, unknown>).recovery_commands)
  ) {
    const c = candidate as Record<string, unknown>;
    // Lenient extraction of structured recovery MCP calls: keep only
    // entries that are objects with a string `tool` and an object `args`;
    // `server` is optional (string). Drop anything malformed.
    let recoveryMcpCalls: Array<{ server?: string; tool: string; args: Record<string, unknown> }> | undefined;
    if (Array.isArray(c.recovery_mcp_calls)) {
      const cleaned = (c.recovery_mcp_calls as unknown[])
        .filter((e): e is Record<string, unknown> =>
          typeof e === "object" && e !== null &&
          typeof (e as Record<string, unknown>).tool === "string" &&
          typeof (e as Record<string, unknown>).args === "object" &&
          (e as Record<string, unknown>).args !== null &&
          !Array.isArray((e as Record<string, unknown>).args))
        .map((e) => ({
          tool: String(e.tool),
          args: e.args as Record<string, unknown>,
          ...(typeof e.server === "string" ? { server: e.server } : {}),
        }));
      if (cleaned.length) recoveryMcpCalls = cleaned;
    }
    return {
      description: String(c.description),
      backup_commands: (c.backup_commands as unknown[]).map(String),
      recovery_commands: (c.recovery_commands as unknown[]).map(String),
      artifact_paths: Array.isArray(c.artifact_paths)
        ? (c.artifact_paths as unknown[]).map(String)
        : undefined,
      live_restore: typeof c.live_restore === "boolean" ? c.live_restore : undefined,
      recovery_mcp_calls: recoveryMcpCalls,
      no_backup_needed: c.no_backup_needed === true,
    };
  }
  return null;
}

/** Read the subagent's result from the canonical handoff file the
 *  prompt instructs it to write. Far more robust than parsing stdout —
 *  required for the hermes runner whose stdout is TUI-decorated.
 *  Returns null if the file is missing or malformed. */
function readSubagentResultFile(actionDir: string): SubagentResponse | null {
  try {
    const f = path.join(actionDir, "subagent_result.json");
    if (fs.existsSync(f)) {
      const shaped = extractOurShape(JSON.parse(fs.readFileSync(f, "utf-8")));
      if (shaped) return shaped;
    }
    // Fallback: a weak subagent may write the result to the WRONG filename
    // (e.g. backlog_manifest.json) instead of emitting it / using the
    // canonical name. Scan the action dir for ANY JSON file whose content
    // matches our shape (has backup_commands + recovery_commands).
    for (const name of fs.readdirSync(actionDir)) {
      if (!name.endsWith(".json") || name === "metadata.json") continue;
      try {
        const shaped = extractOurShape(JSON.parse(fs.readFileSync(path.join(actionDir, name), "utf-8")));
        if (shaped) return shaped;
      } catch { /* not our shape — keep scanning */ }
    }
    return null;
  } catch {
    return null;
  }
}

function parseSubagentOutput(raw: string): SubagentResponse | null {
  // When claude -p is called with --output-format json, the response is a
  // JSON wrapper like {"result": "...", "session_id": "...", ...}.
  // The `result` field contains the actual text the subagent produced,
  // which should itself be (or contain) our backup JSON.
  //
  // We try in this order:
  //   1. Parse raw as JSON wrapper → extract `result` → parse result as our JSON
  //   2. Parse the first {...} block in raw directly (fallback for text mode)

  // Try 1: parse raw as claude -p JSON wrapper
  try {
    const wrapper = JSON.parse(raw);
    if (wrapper && typeof wrapper === "object") {
      const result = (wrapper as Record<string, unknown>).result;
      if (typeof result === "string") {
        // Pick the balanced {...} block that has our shape (not a greedy
        // first-to-last span that merges narration + JSON and fails).
        const inner = extractJsonObject(result, (o) => !!extractOurShape(o));
        if (inner) {
          const shaped = extractOurShape(inner);
          if (shaped) return shaped;
        }
      }
      // openclaw agent --json wrapper: { payloads: [{ text }], meta }.
      // Join the payload texts and extract our JSON block from them.
      const payloads = (wrapper as Record<string, unknown>).payloads;
      if (Array.isArray(payloads)) {
        const text = payloads
          .map((p) => (p && typeof p === "object" ? String((p as Record<string, unknown>).text ?? "") : ""))
          .join("\n");
        const found = extractJsonObject(text, (o) => !!extractOurShape(o));
        if (found) {
          const shaped = extractOurShape(found);
          if (shaped) return shaped;
        }
      }
      // Maybe the wrapper itself has our shape (if claude passed through)
      const direct = extractOurShape(wrapper);
      if (direct) return direct;
    }
  } catch {
    // Not valid JSON at top level, fall through
  }

  // Try 2: find any balanced {...} block in the raw text that has our shape
  const found = extractJsonObject(raw, (o) => !!extractOurShape(o));
  if (found) {
    const shaped = extractOurShape(found);
    if (shaped) return shaped;
  }

  return null;
}

/**
 * Invoke a subagent via `claude -p` to reason about an out-of-workspace
 * action and create a backup artifact. Synchronous — blocks until the
 * subagent finishes or the timeout expires.
 *
 * Returns a BackupArtifact with strategy="subagent" on success, or null
 * on any failure (missing claude CLI, timeout, parse error, etc.).
 */
/** A real artifact, the "read_only" verdict (clean skip — the subagent
 *  judged the action read-only), or null (no/failed backup). */
export type SubagentOutcome = BackupArtifact | "read_only" | null;

export function runSubagentBackup(
  ctx: HookContext,
  actionDir: string,
  config: SandboxConfig,
  opts?: { toolAllow?: string[] },
): SubagentOutcome {
  if (!config.subagentEnabled) return null;

  // Always write diagnostic trace to a log file so users can debug
  // silent subagent failures without needing verbose mode.
  const debugLogPath = path.join(path.dirname(path.resolve(config.backupDir)), "subagent.log");
  const logDebug = (msg: string): void => {
    try {
      fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
      fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      // best-effort
    }
  };

  const prompt = buildSubagentPrompt(ctx, actionDir, config);
  const timeoutMs = Math.max(10_000, config.subagentTimeoutSeconds * 1000);

  // Build the runner invocation — claude -p or hermes chat — see
  // buildSubagentInvocation. Returns null when the runner's CLI is
  // missing, in which case we skip the backup (graceful degradation).
  // BACKUP needs the remote tools too: to recover a delete/edit we must
  // READ the pre-state BEFORE the agent's action runs. Give the subagent
  // the same MCP, with an isolated browser profile so it doesn't collide
  // with the agent's live browser lock.
  const _server = serverFromToolName(ctx.tool_name);
  // SIMPLEST backup design: a BROWSER action's backup subagent gets NO browser.
  // The main agent already took a browser_snapshot before its mutation; the hook
  // cached it (recordBrowserSnapshot) and it's injected into the prompt as
  // PAGE_STATE. The subagent writes the recovery straight from that snapshot —
  // it physically cannot browse (so it can't fabricate via a live read or
  // collide with the agent's browser). If the value it needs isn't in PAGE_STATE
  // it must mark the backup UNVERIFIED (see the prompt's preStateBlock gate).
  // Non-browser servers (e.g. postgres) keep their MCP — capture there IS a
  // remote read/insert, not a snapshot replay.
  const _isBrowser = _server === "playwright";
  const invocation = buildSubagentInvocation(prompt, config, {
    withMcp: !_isBrowser,
    isolateBrowserProfile: true,
    // Dynamic MCP loading: only boot the server THIS action uses. For a browser
    // action, boot NOTHING — the subagent runs with only terminal,file toolsets.
    neededServer: _isBrowser ? null : _server,
    // Narrow the MCP tool schema to the capture-relevant tools (read + inverse),
    // derived by the caller from the experience. Undefined → server unfiltered.
    toolAllow: opts?.toolAllow,
    // HARD turn cap (the watcher also ends the run the instant the result file
    // is valid, so a tight cap only ever trims a pathological tail). Fixed at 3:
    // the worst legit case (a delete) needs check-info -> read the original
    // value -> write the backup result = 3 calls. Narrowed tools (toolAllow)
    // mean the subagent still cannot waste a call enumerating.
    maxTurns: 3,
  });
  if (!invocation) {
    const runner = config.subagentRunner ?? "claude";
    logDebug(`skipped: ${runner} CLI not found in PATH`);
    if (config.verbose) {
      process.stderr.write(`[CHATS-Sandbox] subagent skipped: ${runner} CLI not found\n`);
    }
    return null;
  }
  const { bin, args } = invocation;

  logDebug(`invoking: ${bin} [runner=${invocation.runner}] [prompt=${prompt.length} chars] ${args.filter((a) => a !== prompt).join(" ")} (timeout=${timeoutMs}ms)`);

  // Tell the user what we're about to do — claude -p can take 5-30s and
  // there's otherwise no signal that anything is happening.
  const cmdPreview = String(ctx.tool_input.command ?? "")
    || String(ctx.tool_input.path ?? ctx.tool_input.file_path ?? "");
  const modelLabel = invocation.runner === "hermes"
    ? (config.subagentHermesModel || "hermes")
    : invocation.runner === "openclaw"
      ? (config.subagentOpenclawModel || "openclaw")
      : invocation.runner === "codex"
        ? (config.subagentCodexModel || "codex")
        : config.subagentModel;
  tellUser(
    `[CHATS-Sandbox] Out-of-workspace action detected. Invoking ${modelLabel} subagent to back up... ` +
    `(${ctx.tool_name}${cmdPreview ? `: ${cmdPreview.slice(0, 60)}` : ""})`
  );

  const startTime = Date.now();
  let stdout = "";
  let stderr = "";
  try {
    // Run the subagent THROUGH the watcher wrapper: it kills the subagent
    // the instant it writes a valid subagent_result.json, skipping the
    // model's post-backup "still thinking" tail. The wrapper enforces the
    // timeout itself, so give execFileSync a small margin on top.
    const { execFileSync } = require("node:child_process");
    const watcher = path.join(__dirname, "subagent_watch.js");
    const resultFile = path.join(actionDir, "subagent_result.json");
    stdout = execFileSync(
      process.execPath,
      [watcher, resultFile, String(timeoutMs), bin, ...args],
      {
        encoding: "utf-8",
        timeout: timeoutMs + 10_000,
        env: { ...subagentEnv(), ...(invocation.env ?? {}) },
        // Close stdin immediately — codex exec (and possibly others)
        // block forever reading an open stdin pipe.
        input: "",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024, // 4 MB cap
      },
    );
    logDebug(`stdout (${stdout.length} chars): ${stdout.slice(0, 500)}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const errWithOutput = e as { stdout?: string; stderr?: string };
    if (errWithOutput.stdout) stdout = String(errWithOutput.stdout);
    if (errWithOutput.stderr) stderr = String(errWithOutput.stderr);
    logDebug(`FAILED: ${msg.slice(0, 500)}`);
    if (stderr) logDebug(`stderr: ${stderr.slice(0, 500)}`);
    if (stdout) logDebug(`partial stdout: ${stdout.slice(0, 500)}`);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

    // The watcher KILLS the subagent the instant it writes a valid result
    // file — that kill surfaces HERE as a non-zero exit / thrown
    // execFileSync. So a throw is NOT necessarily a failure: if the
    // subagent already wrote its result, the backup SUCCEEDED and we must
    // proceed to promote it (otherwise live_restore recovery is silently
    // discarded — exactly the browser case, whose long "thinking tail"
    // means the watcher always has to kill it). Only bail when there is no
    // usable result file.
    const killedButHasResult = readSubagentResultFile(actionDir);
    if (killedButHasResult) {
      logDebug("subagent killed by watcher AFTER writing its result — proceeding to promote it");
      stdout = ""; // result file is authoritative; ignore partial stdout
    } else {
      // Detect common auth failure and log a clear message
      if (stdout.includes("Not logged in") || stderr.includes("Not logged in")) {
        logDebug("DIAGNOSIS: claude CLI is not logged in. Run `claude` interactively once to authenticate.");
        tellUser(
          "[CHATS-Sandbox] Subagent skipped: claude CLI not logged in. " +
          "Run `claude` interactively once to authenticate, or disable the subagent with " +
          "`chats-sandbox config set subagentEnabled false`."
        );
      } else {
        tellUser(`[CHATS-Sandbox] Subagent failed after ${elapsedSec}s: ${msg.slice(0, 120)}`);
      }
      return null;
    }
  }

  // Prefer the canonical result file the subagent was told to write —
  // robust regardless of stdout format (the hermes runner's stdout is
  // TUI-decorated and not cleanly parseable). Fall back to stdout
  // parsing for older subagents / the claude runner's JSON wrapper.
  const fileResult = readSubagentResultFile(actionDir);
  if (fileResult) logDebug("result read from subagent_result.json");
  const parsed = fileResult ?? parseSubagentOutput(stdout);
  if (!parsed) {
    logDebug(`parse failed (no subagent_result.json, stdout unparseable). Raw stdout was: ${stdout.slice(0, 2000)}`);

    // Detect permission denial (subagent couldn't run bash) and warn clearly
    if (stdout.includes("permission_denials") || stdout.includes("permission denied") ||
        stdout.includes("approval is needed") || stdout.includes("cannot proceed")) {
      logDebug("DIAGNOSIS: subagent was denied tool permissions despite bypass flag. " +
        "This usually means a stale `claude` CLI version — upgrade and retry.");
      tellUser(
        "[CHATS-Sandbox] Subagent could not run backup commands (tool permission denied). " +
        "Upgrade the `claude` CLI (npm i -g @anthropic-ai/claude-code) or set " +
        "subagentPermissionMode=acceptEdits for filesystem-only backups."
      );
    } else {
      tellUser("[CHATS-Sandbox] Subagent returned unparseable output — backup skipped.");
    }
    return null;
  }

  // The subagent now OUTPUTS the JSON (instead of writing the file itself —
  // weak models reliably drop that last file-write step). Persist what we
  // parsed from stdout to the canonical path so forensics and any
  // file-based reader still find it.
  if (!fileResult) {
    try {
      fs.writeFileSync(path.join(actionDir, "subagent_result.json"), JSON.stringify(parsed));
      logDebug("saved parsed stdout JSON to subagent_result.json");
    } catch { /* best-effort */ }
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  logDebug(`parse success: ${parsed.description}`);

  // LOUD UNVERIFIED flag: the simplest backup design hands the subagent the
  // cached PAGE_STATE and NO browser. If the original value it needed wasn't in
  // that snapshot (e.g. hidden in an input's value attribute), the subagent
  // marks the result UNVERIFIED rather than fabricating. Surface that here so
  // it's visible in forensics (subagent.log) and on the user's terminal — this
  // is the ONE case we want flagged for a possible future live-read.
  const _descUpper = (parsed.description || "").trimStart().toUpperCase();
  // A deterministic remote reversal records its inverse as structured
  // recovery_mcp_calls (recovery_commands stays empty) — that is NOT an
  // unverified backup, so only flag when BOTH forms are empty.
  const _noRecovery = (parsed.recovery_commands ?? []).length === 0 &&
    (parsed.recovery_mcp_calls ?? []).length === 0;
  if (_descUpper.startsWith("UNVERIFIED") || _noRecovery) {
    logDebug(`[CHATS-Sandbox] BACKUP UNVERIFIED: pre-state value not captured for ${ctx.tool_name} — ${(parsed.description || "").slice(0, 120)}`);
    tellUser(`[CHATS-Sandbox] BACKUP UNVERIFIED: pre-state value not captured for ${ctx.tool_name}`);
  }

  // READ-ONLY VERDICT: the subagent inspected the action and determined
  // it mutates nothing outside the workspace. Honor it as a CLEAN SKIP —
  // not a failed/unverified backup. This is the smart second-layer
  // read-only check beyond the regex filter, for the ambiguous tail.
  // Safe: tiers 0–2 already covered the workspace independently, so this
  // only declines the generic tier-3 backup for something the subagent
  // judged read-only. The caller treats "read_only" specially: no
  // artifact, no "unprotected" warning, and the empty action dir is
  // cleaned up.
  if (parsed.no_backup_needed === true) {
    logDebug(`subagent verdict: read-only, no backup needed (${parsed.description.slice(0, 80)})`);
    return "read_only";
  }

  // VERIFY the backup before trusting it. The subagent reports success
  // as free text; without a check, a hallucinated backup ("done!") is
  // recorded as recoverable and the destructive action proceeds — the
  // exact case where restore later fails on a nonexistent artifact.
  // A backup is trustworthy only when it produced something durable:
  //   - a declared artifact_path that exists and is non-empty, OR
  //   - it's a live_restore action (recovery is re-derived from remote
  //     state at restore time — no local artifact to check), OR
  //   - the action is remote/MCP AND recovery_commands were recorded
  //     (the snapshot lives in the remote system, e.g. an in-DB copy).
  const declaredPaths = (parsed.artifact_paths ?? [])
    .map((p) => (path.isAbsolute(p) ? p : path.join(actionDir, p)));
  const durableArtifact = declaredPaths.some((p) => {
    try { return fs.statSync(p).size > 0; } catch { return false; }
  });
  // "Live" actions mutate state that lives in an external system
  // (remote, daemon, cluster), not in a local file — so recovery is
  // inherently re-derived from that system and there is no local
  // artifact to verify. recovery_commands is the backup for these.
  const cmdStr = String((ctx.tool_input as { command?: unknown }).command ?? "");
  const isRemote = ctx.tool_name.startsWith("mcp__") ||
    /^browser_/.test(ctx.tool_name) ||                       // bare playwright/browser tools
    /\b(git\s+push|curl|wget|ssh|scp|rsync|docker|kubectl|helm|terraform|aws|gcloud|az|systemctl)\b/.test(cmdStr) ||
    /\b(psql|mysql|mariadb|mongo|mongosh|redis-cli)\b/.test(cmdStr); // DB clients
  const modelLiveRestore = parsed.live_restore ?? false;
  // A remote reversal can be recorded either as prose recovery_commands OR
  // as structured recovery_mcp_calls (the deterministic, live_restore=false
  // mode). Either form counts as recovery for the verification gate.
  const hasRecovery = (parsed.recovery_commands ?? []).length > 0 ||
    (parsed.recovery_mcp_calls ?? []).length > 0;
  // NOTE: a tighter gate ("remote backup must have a captured artifact") was
  // considered to stop confident-empty backups, but it regresses legitimate
  // CREATE actions (docker run, pip install, create-post) whose reversal is a
  // known command with nothing to capture. Distinguishing destructive-vs-create
  // here is non-trivial; deferred. The action-aware tool allowlist (superset)
  // already gives the subagent the tools to actually capture, which is the real
  // mitigation for confident-empty backups.
  const verified = durableArtifact || modelLiveRestore || (isRemote && hasRecovery);
  // Recovery MECHANISM is the subagent's OWN call (it knows whether its
  // recovery needs live re-derivation). live_restore=false → run the
  // recorded recovery_commands directly at restore (deterministic, no agent
  // — the fast path for simple cases like a SQL reversal). live_restore=true
  // → spawn a fresh agent that re-reads live state (the dynamic cases like a
  // browser/UI reversal where the page has changed).
  const liveRestore = modelLiveRestore;

  if (!verified) {
    logDebug(
      "subagent backup UNVERIFIED: no durable artifact " +
      `(declared ${declaredPaths.length} path(s), none exist+nonempty), ` +
      "not live_restore, not remote-with-recovery — refusing to record.",
    );
    tellUser(
      "[CHATS-Sandbox] Subagent reported a backup but produced no verifiable " +
      "artifact — NOT recording it as recoverable. Out-of-workspace state may " +
      "be unprotected; proceed with caution.",
    );
    return null;
  }

  // Persist the raw subagent response as a file alongside the artifact
  const id = Math.random().toString(36).slice(2, 10);
  const artifactFile = path.join(actionDir, `subagent_${id}.json`);
  fs.mkdirSync(actionDir, { recursive: true });
  fs.writeFileSync(artifactFile, JSON.stringify(parsed, null, 2), "utf-8");

  // Tell the user the backup succeeded
  tellUser(`[CHATS-Sandbox] Subagent backup done in ${elapsedSec}s: ${parsed.description.slice(0, 100)}`);

  return {
    id,
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: `Subagent backup: ${parsed.description}`,
    strategy: "subagent",
    artifactPath: artifactFile,
    subagentCommands: parsed.recovery_commands,
    recoveryMcpCalls: parsed.recovery_mcp_calls,
    liveRestore,
    originalAction: describeToolAction(ctx.tool_name, ctx.tool_input),
  };
}

/**
 * Spawn a fresh `claude -p` subagent to perform a restore. Used when
 * an artifact was tagged `liveRestore: true` by the backup subagent
 * (i.e. the canned recovery_commands can't be trusted — remote state,
 * dynamic systems). The subagent reads live state and runs whatever
 * commands it decides are needed.
 *
 * Returns { success, detail }. `detail` contains either the result
 * text (on success) or the error message (on failure).
 *
 * Mirrors the subprocess setup of runSubagentBackup:
 *   - scratch cwd to escape project .claude/settings.json deny rules
 *   - CHATS_SANDBOX_NO_HOOK=1 to prevent hook recursion
 *   - --dangerously-skip-permissions for the bypass path
 *   - timeout from config.subagentTimeoutSeconds
 */
export function invokeRestoreSubagent(
  prompt: string,
  config: SandboxConfig,
  neededServer?: string | null,
): { success: boolean; detail: string } {
  // Restore is where the model must perform precise multi-step UI actions
  // (find the pinned entity → delete → confirm). The cheap backup model
  // (e.g. haiku) often can't, so allow a STRONGER model just for restore via
  // subagentRestoreModel — backup stays cheap, restore gets capability.
  if (config.subagentRestoreModel) {
    config = {
      ...config,
      subagentModel: config.subagentRestoreModel as typeof config.subagentModel,
      subagentHermesModel: config.subagentRestoreModel,
    };
  }
  const timeoutMs = Math.max(10_000, config.subagentTimeoutSeconds * 1000);

  // Same runner branching as the backup path — claude -p or hermes chat —
  // but this is the live-restore path, so request the MCP tools (browser)
  // when configured so the subagent can execute the UI reversal. Dynamic
  // MCP loading: only the action's own server is booted.
  const invocation = buildSubagentInvocation(prompt, config, { withMcp: true, neededServer });
  if (!invocation) {
    const runner = config.subagentRunner ?? "claude";
    return { success: false, detail: `${runner} CLI not found in PATH` };
  }
  const { bin, args } = invocation;

  const modelLabel = invocation.runner === "hermes"
    ? (config.subagentHermesModel || "hermes")
    : invocation.runner === "openclaw"
      ? (config.subagentOpenclawModel || "openclaw")
      : invocation.runner === "codex"
        ? (config.subagentCodexModel || "codex")
        : config.subagentModel;
  tellUser(
    `[CHATS-Sandbox] Live-restore: invoking ${modelLabel} subagent to reverse remote/dynamic state...`,
  );

  try {
    const { execFileSync } = require("node:child_process");
    const stdout: string = execFileSync(bin, args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      env: { ...subagentEnv(), ...(invocation.env ?? {}) },
      // Close stdin immediately — codex exec (and possibly others)
      // block forever reading an open stdin pipe.
      input: "",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });

    // Extract the result text from the claude -p JSON wrapper for display.
    let detail = stdout.slice(0, 500);
    try {
      const wrapper = JSON.parse(stdout);
      if (wrapper && typeof wrapper === "object") {
        const result = (wrapper as Record<string, unknown>).result;
        if (typeof result === "string") detail = result.slice(0, 500);
      }
    } catch {
      // raw stdout is fine
    }
    return { success: true, detail };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, detail: msg.slice(0, 500) };
  }
}

/**
 * Run the configured runner (claude -p / hermes chat) on an arbitrary
 * reasoning prompt and return its text result. Used by the self-
 * exploration pipeline to extract recovery patterns — a pure-text task,
 * no tools or backup framing. Returns null on any failure.
 */
export function runRunnerForText(
  prompt: string,
  config: SandboxConfig,
  timeoutSeconds = 180,
  opts?: { neededServer?: string | null; toolAllow?: string[] },
): string | null {
  // Self-exploration pins the server it's exploring, so the verify agent ALWAYS
  // gets that server's live MCP tools (mcp-<server>). This is NOT the backup
  // path's dynamic per-action injection — for explore the server is constant.
  const invocation = buildSubagentInvocation(
    prompt,
    config,
    opts?.neededServer ? { neededServer: opts.neededServer, withMcp: true, toolAllow: opts.toolAllow } : undefined,
  );
  if (!invocation) return null;
  const { bin, args } = invocation;
  try {
    const { execFileSync } = require("node:child_process");
    const stdout: string = execFileSync(bin, args, {
      encoding: "utf-8",
      timeout: Math.max(10_000, timeoutSeconds * 1000),
      env: { ...subagentEnv(), ...(invocation.env ?? {}) },
      // Close stdin immediately — codex exec (and possibly others)
      // block forever reading an open stdin pipe.
      input: "",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    // claude -p --output-format json wraps the text in {result}. Hermes
    // prints decorated text. Try the wrapper first, else raw stdout.
    try {
      const wrapper = JSON.parse(stdout);
      const r = (wrapper as Record<string, unknown>).result;
      if (typeof r === "string") return r;
    } catch { /* not json-wrapped */ }
    return stdout;
  } catch {
    return null;
  }
}
