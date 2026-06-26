/**
 * Restore engine — reverse a backup artifact to recover prior state.
 *
 * Tiers 1-2: deterministic restore (known inverse for each strategy).
 * Tier 3 (subagent): returns a prompt for the subagent to execute.
 *
 * Restore never deletes the backup — it stays in the action folder
 * so you can restore again or inspect what was there.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import type { BackupArtifact, SandboxConfig } from "../types.js";
import { listActions } from "../backup/manifest.js";
import { invokeRestoreSubagent } from "../backup/subagent.js";
import { serverFromToolName } from "../explore/experiences.js";

// ── Types ────────────────────────────────────────────────────────────

export interface RestoreResult {
  success: boolean;
  /** What was restored */
  description: string;
  /** If subagent is needed, this contains the prompt */
  subagentPrompt?: string;
  /** True when the restore ran but its outcome could NOT be verified
   *  (e.g. a live-restore subagent reversed remote/dynamic state we
   *  can't re-read). Such an action must NOT trigger pruning — pruning
   *  the only backup of unverified remote state is unrecoverable. */
  unverified?: boolean;
}

// ── Shell helper ─────────────────────────────────────────────────────

function exec(cmd: string, cwd?: string): { ok: boolean; stdout: string } {
  try {
    const out = execSync(cmd, {
      encoding: "utf-8",
      timeout: 30_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { ok: true, stdout: out };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, stdout: msg };
  }
}

/** Run a binary with an argument vector — NO shell. Used for recovery
 *  built from saved data (package names/versions) so values can never be
 *  interpreted as shell syntax. */
function execFileArgs(bin: string, args: string[], cwd?: string): { ok: boolean; stdout: string } {
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync(bin, args, {
      encoding: "utf-8",
      timeout: 60_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { ok: true, stdout: out };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, stdout: msg };
  }
}

/**
 * Reject catastrophic / injection-shaped recovery commands before they
 * reach a shell. `recovery_commands` are authored by an LLM whose input
 * includes untrusted remote content (post titles, issue bodies), so a
 * crafted string can carry shell injection. This is a denylist backstop
 * for the worst forms — not a substitute for a typed recovery plan, but
 * it blocks the commands that turn a restore into a wipe/exfil.
 */
export function isDangerousRecoveryCommand(cmd: string): boolean {
  const c = cmd.toLowerCase();
  return (
    /\brm\s+-[a-z]*\s*(\/(\s|$)|\/\*|~(\/|\s|$)|\$home|\$\{home\})/.test(c) || // rm -rf / | ~ | $HOME
    /\|\s*(sh|bash|zsh|dash|python[0-9.]*|perl|ruby|node)\b/.test(c) ||        // pipe into an interpreter
    /\b(curl|wget|fetch)\b[\s\S]*\|\s*(sh|bash|zsh)\b/.test(c) ||              // curl … | sh
    /:\s*\(\s*\)\s*\{/.test(cmd) ||                                            // fork bomb :(){ …
    /\bmkfs\b|\bdd\s+[\s\S]*of=\/dev\//.test(c) ||                             // disk wipe
    />\s*\/dev\/sd[a-z]/.test(c)                                               // overwrite a raw disk
  );
}

/** A recovery command that is a SQL statement (DB MCP reversal), not a
 *  shell command — must be run against the DB, not /bin/sh. */
function looksLikeSql(cmd: string): boolean {
  return /^\s*\(*\s*(insert|update|delete|create|drop|alter|truncate|merge|with|grant|revoke)\b/i.test(cmd);
}

/** Extract a postgresql:// connection string for the action's MCP server
 *  from the configured MCP source (claude's --mcp-config JSON, or the
 *  hermes ~/.hermes/config.yaml), so a SQL reversal can run deterministically
 *  via psql with no agent. Returns null if none is configured. */
function dbConnStr(config: SandboxConfig | undefined, server: string | null): string | null {
  if (!config || !server) return null;
  const grab = (text: string): string | null => {
    const m = text.match(/postgres(?:ql)?:\/\/[^\s"']+/i);
    return m ? m[0] : null;
  };
  try {
    if (config.subagentMcpConfig && fs.existsSync(config.subagentMcpConfig)) {
      const raw = JSON.parse(fs.readFileSync(config.subagentMcpConfig, "utf-8")) as
        { mcpServers?: Record<string, unknown> };
      const srv = raw.mcpServers?.[server];
      if (srv) { const c = grab(JSON.stringify(srv)); if (c) return c; }
    }
  } catch { /* */ }
  try {
    const p = path.join(os.homedir(), ".hermes", "config.yaml");
    if (fs.existsSync(p)) { const c = grab(fs.readFileSync(p, "utf-8")); if (c) return c; }
  } catch { /* */ }
  return null;
}

// ── Deterministic restore strategies ─────────────────────────────────

function restorePipFreeze(artifact: BackupArtifact): RestoreResult {
  const freezePath = artifact.artifactPath;
  if (!fs.existsSync(freezePath)) {
    return { success: false, description: `Backup file not found: ${freezePath}` };
  }

  const result = exec(`pip install -r "${freezePath}"`);
  if (result.ok) {
    return { success: true, description: `Restored packages from ${freezePath}` };
  }
  return { success: false, description: `pip install failed: ${result.stdout.slice(0, 200)}` };
}

function restoreNpmList(artifact: BackupArtifact): RestoreResult {
  const listPath = artifact.artifactPath;
  if (!fs.existsSync(listPath)) {
    return { success: false, description: `Backup file not found: ${listPath}` };
  }

  // Read the saved package list and install from it
  try {
    const data = JSON.parse(fs.readFileSync(listPath, "utf-8"));
    const deps = data.dependencies ?? {};
    // Build an argument VECTOR (no shell), and drop any spec carrying
    // shell metacharacters/whitespace — a corrupted or crafted package
    // name can't inject a command when passed via execFileSync.
    const SAFE_SPEC = /^[@\w][\w@.\/^~>=<.* -]*$/;
    const packages = Object.entries(deps)
      .map(([name, info]: [string, unknown]) => {
        const version = (info as Record<string, string>)?.version;
        return version ? `${name}@${version}` : name;
      })
      .filter((p) => SAFE_SPEC.test(p) && !/[;|&$`()\n]/.test(p));

    if (!packages.length) {
      return { success: true, description: "No packages to restore" };
    }

    const result = execFileArgs("npm", ["install", ...packages]);
    if (result.ok) {
      return { success: true, description: `Restored ${packages.length} npm package(s) from ${listPath}` };
    }
    return { success: false, description: `npm install failed: ${result.stdout.slice(0, 200)}` };
  } catch {
    return { success: false, description: `Failed to parse ${listPath}` };
  }
}

function restoreEnvSnapshot(artifact: BackupArtifact): RestoreResult {
  const envPath = artifact.artifactPath;
  if (!fs.existsSync(envPath)) {
    return { success: false, description: `Backup file not found: ${envPath}` };
  }

  // We can't actually re-export env vars into the parent process from here.
  // Instead, provide the restore command for the user/agent to run.
  return {
    success: true,
    description: `Environment snapshot at ${envPath}. To restore: source <(grep '=' "${envPath}" | sed 's/^/export /')`,
  };
}

function restoreGitTag(artifact: BackupArtifact): RestoreResult {
  const tagName = artifact.artifactPath;
  const result = exec(`git rev-parse "${tagName}"`);
  if (!result.ok) {
    return { success: false, description: `Git tag not found: ${tagName}` };
  }

  const resetResult = exec(`git reset --hard "${tagName}"`);
  if (resetResult.ok) {
    return { success: true, description: `Restored to git tag ${tagName} (${result.stdout.slice(0, 8)})` };
  }
  return { success: false, description: `git reset failed: ${resetResult.stdout.slice(0, 200)}` };
}

function restoreGitSnapshot(artifact: BackupArtifact): RestoreResult {
  const shadowDir = artifact.artifactPath;
  if (!fs.existsSync(shadowDir)) {
    return { success: false, description: `Shadow repo not found: ${shadowDir}` };
  }

  // Use the specific commit hash stored with the artifact — NOT HEAD.
  // With the shared shadow repo, HEAD points to the LATEST snapshot,
  // which may be a later action than the one we want to restore.
  const commit = artifact.commitHash ?? artifact.id;
  if (!commit) {
    return { success: false, description: "Artifact is missing commit hash" };
  }

  // Verify the commit exists in the shadow repo. The shadow repo is
  // a bare-style git dir (contents live directly in shadowDir, no
  // working tree), so we must use GIT_DIR — not cwd — to query it.
  // (Earlier versions passed cwd=shadowDir which silently failed
  // because `git rev-parse` couldn't find HEAD in cwd.)
  try {
    execSync(`git rev-parse ${commit}`, {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, GIT_DIR: shadowDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return {
      success: false,
      description: `Commit ${commit.slice(0, 8)} not found in shadow repo`,
    };
  }

  const cwd = process.cwd();
  const env = {
    ...process.env,
    GIT_DIR: shadowDir,
    GIT_WORK_TREE: cwd,
  };

  const opts = { encoding: "utf-8" as const, timeout: 30_000, env, cwd, stdio: "pipe" as const };

  try {
    // Use read-tree + checkout-index + clean instead of plain checkout.
    // `git checkout <hash> -- .` only overwrites files present in the commit
    // but does NOT delete files that were added after it. The three-step
    // approach makes the workspace exactly match the commit:
    //   read-tree: set the index to the target commit's tree
    //   checkout-index: overwrite workspace files from the index
    //   clean -fd: remove workspace files not in the index
    // The shadow repo's info/exclude protects node_modules, .env, etc.
    execSync(`git read-tree ${commit}`, opts);
    execSync("git checkout-index -f -a", opts);
    execSync("git clean -fd", opts);

    return {
      success: true,
      description: `Restored workspace from git snapshot (${commit.slice(0, 8)})`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, description: `git restore failed: ${msg.slice(0, 200)}` };
  }
}

// ── Tier 3: subagent restore ─────────────────────────────────────────

/**
 * Restore a subagent artifact. If the artifact has stored recovery_commands,
 * we execute them directly. Otherwise, fall back to returning a prompt for
 * a restore subagent to handle it.
 *
 * The recovery_commands come from the subagent's original backup step,
 * so they're trusted — they were generated by a Claude model reasoning
 * about how to reverse the action.
 */
function restoreSubagent(
  artifact: BackupArtifact,
  config?: SandboxConfig,
): RestoreResult {
  // Live-restore path: the backup subagent flagged this artifact as
  // remote/dynamic — canned commands can't be trusted. Spawn a fresh
  // subagent that reads live state and decides what to do.
  if (artifact.liveRestore) {
    if (!config) {
      // Nothing was restored — only a prompt was produced. Report
      // this honestly as a failure so callers don't prune folders
      // or claim success for unrecovered remote state.
      return {
        success: false,
        description: "Live-restore subagent needed (config unavailable in this call path)",
        subagentPrompt: buildSubagentRestorePrompt(artifact),
      };
    }
    const prompt = buildSubagentRestorePrompt(artifact);
    // Dynamic MCP loading: reverse through the SAME server the action used.
    const result = invokeRestoreSubagent(prompt, config, serverFromToolName(artifact.toolName));
    return {
      success: result.success,
      description: result.success
        ? `Live-restore subagent completed (unverified): ${result.detail.slice(0, 200)}`
        : `Live-restore subagent failed: ${result.detail.slice(0, 200)}`,
      // The subagent reversed remote/dynamic state through its own tools;
      // we cannot re-read that state to confirm it actually returned. Mark
      // unverified so the loop keeps the backup instead of pruning it.
      unverified: true,
    };
  }

  const commands = artifact.subagentCommands ?? [];

  if (commands.length === 0) {
    // Nothing to execute — only a prompt is produced, so the artifact
    // is not actually restored. Report as failure (not success) so
    // pruning is blocked and the dashboard doesn't show a false "✓".
    return {
      success: false,
      description: "Subagent restore needed (no commands recorded)",
      subagentPrompt: buildSubagentRestorePrompt(artifact),
    };
  }

  // Execute each recovery command in sequence. Stop on first failure.
  // A SQL recovery (DB MCP action) runs deterministically via psql — never
  // through /bin/sh, which can't execute SQL (and is an injection surface).
  const cwd = process.cwd();
  const connStr = dbConnStr(config, serverFromToolName(artifact.toolName));
  const executed: string[] = [];
  for (const cmd of commands) {
    if (isDangerousRecoveryCommand(cmd)) {
      return {
        success: false,
        description:
          `Refused a dangerous recovery command (possible injection) — backup kept for manual review: "${cmd.slice(0, 120)}"`,
      };
    }
    try {
      if (connStr && looksLikeSql(cmd)) {
        const r = execFileArgs("psql", [connStr, "-v", "ON_ERROR_STOP=1", "-c", cmd]);
        if (!r.ok) throw new Error(r.stdout.slice(0, 200));
      } else {
        execSync(cmd, {
          encoding: "utf-8",
          timeout: 60_000,
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
      executed.push(cmd);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        description:
          `Subagent restore partially executed (${executed.length}/${commands.length}): ` +
          `failed on "${cmd.slice(0, 80)}": ${msg.slice(0, 200)}`,
      };
    }
  }

  return {
    success: true,
    description: `Subagent restore: executed ${executed.length} recovery command(s) — ${artifact.description}`,
  };
}

function buildSubagentRestorePrompt(artifact: BackupArtifact): string {
  const commands = artifact.subagentCommands?.length
    ? artifact.subagentCommands.map((c, i) => `  ${i + 1}. ${c}`).join("\n")
    : "  (no commands recorded)";

  const action = artifact.originalAction ?? artifact.toolName;

  // The backup subagent captured the affected entity's locators (title,
  // id, URL, parent id, prior body) into remote-state.json alongside the
  // result file. The restore subagent NEEDS those to find the entity to
  // recreate/delete — inline them rather than just naming the result file.
  let capturedBlock = "";
  try {
    const dir = path.dirname(artifact.artifactPath);
    for (const name of ["remote-state.json", "remote_state.json"]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        capturedBlock = `CAPTURED PRE-ACTION STATE (use these locators to find the entity):\n` +
          "```json\n" + fs.readFileSync(p, "utf-8").slice(0, 4000) + "\n```\n\n";
        break;
      }
    }
  } catch { /* best-effort */ }

  return (
    `RESTORE TASK: A previous modification needs to be reversed.\n\n` +
    `ORIGINAL ACTION:\n  ${action}\n\n` +
    `WHAT WAS BACKED UP:\n  ${artifact.description}\n\n` +
    `BACKUP COMMANDS THAT WERE RUN:\n${commands}\n\n` +
    `BACKUP ARTIFACT LOCATION:\n  ${artifact.artifactPath}\n\n` +
    capturedBlock +
    `INSTRUCTIONS:\n` +
    `- Use the backup artifacts above to restore the prior state.\n` +
    `- Reverse the effects of the original action.\n` +
    `- If the backup includes files, restore them to their original locations.\n` +
    `- If the backup includes remote state (git tags, API snapshots), use them to revert.\n` +
    `- If the original action was a web/UI action and you have browser tools\n` +
    `  (mcp__playwright__*), reverse it through the SAME interface: the browser\n` +
    `  session may already be authenticated; reload the relevant page, read the\n` +
    `  current state, and perform the inverse interaction (e.g. retract a vote,\n` +
    `  edit a body back, delete a created item, toggle a subscription back).\n` +
    `- Be minimal — only undo what the original action changed.\n` +
    `- Report what you restored and confirm the state is back to normal.`
  );
}

// ── Main restore dispatcher ──────────────────────────────────────────

/**
 * Restore a single backup artifact.
 *
 * For tiers 1-2: executes restore deterministically.
 * For tier 3 (subagent): returns a prompt in result.subagentPrompt.
 */
export function restoreArtifact(
  artifact: BackupArtifact,
  config?: SandboxConfig,
): RestoreResult {
  switch (artifact.strategy) {
    case "pip_freeze":
      return restorePipFreeze(artifact);
    case "npm_list":
      return restoreNpmList(artifact);
    case "env_snapshot":
      return restoreEnvSnapshot(artifact);
    case "git_tag":
      return restoreGitTag(artifact);
    case "git_snapshot":
      return restoreGitSnapshot(artifact);
    case "subagent":
      return restoreSubagent(artifact, config);
    case "policy_rewrite":
      return restorePolicyRewrite(artifact);
    default:
      return { success: false, description: `Unknown strategy: ${artifact.strategy}` };
  }
}

/**
 * Reverse a tier-0 policy rewrite (e.g. rm → mv-to-trash). The pre-recorded
 * recoveryCommands are run verbatim via execSync, same contract as the
 * subagent path's replay mode.
 */
function restorePolicyRewrite(artifact: BackupArtifact): RestoreResult {
  const commands = artifact.recoveryCommands ?? [];
  if (commands.length === 0) {
    return {
      success: false,
      description: `policy_rewrite artifact ${artifact.id} has no recovery commands`,
    };
  }
  const cwd = process.cwd();
  const executed: string[] = [];
  for (const cmd of commands) {
    try {
      execSync(cmd, { encoding: "utf-8", timeout: 30_000, cwd, stdio: ["pipe", "pipe", "pipe"] });
      executed.push(cmd);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        description:
          `Policy restore partially ran (${executed.length}/${commands.length}): ` +
          `failed on "${cmd.slice(0, 80)}": ${msg.slice(0, 200)}`,
      };
    }
  }
  return {
    success: true,
    description: `Policy restore (${artifact.policyRuleId}): ran ${executed.length} recovery command(s) — ${artifact.description}`,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Delete action folders from the target onwards (inclusive).
 *
 * Since each snapshot captures the state BEFORE the action ran,
 * restoring to action N means "undo N." So folder N itself should
 * also be deleted — the workspace is now in the pre-N state, and
 * folder N's snapshot has been applied.
 *
 * Commits in the shared shadow repo remain as dangling objects
 * (git will garbage-collect them eventually).
 *
 * Returns the number of folders deleted.
 */
function pruneIntermediateFolders(
  targetActionName: string,
  config: SandboxConfig
): number {
  const backupRoot = path.resolve(config.backupDir);
  const actions = listRestorableActions(config);
  const targetIdx = actions.findIndex((i) => i.name === targetActionName);

  if (targetIdx === -1) {
    return 0;
  }

  let deleted = 0;
  // Delete from targetIdx onwards (inclusive — target folder is also removed)
  for (let i = targetIdx; i < actions.length; i++) {
    const folder = path.join(backupRoot, actions[i].name);
    try {
      fs.rmSync(folder, { recursive: true, force: true });
      deleted++;
    } catch {
      // best-effort; skip on failure
    }
  }
  return deleted;
}

/**
 * Check if all results in a restore operation succeeded.
 *
 * A result that only carries a `subagentPrompt` did NOT actually
 * restore anything — it deferred the work to a prompt nobody has run
 * yet. Counting that as success let the system prune intermediate
 * folders and report "✓ restored" while remote/dynamic state was
 * still unrecovered. We now require an executed success with no
 * pending prompt.
 */
function allSucceeded(results: RestoreResult[]): boolean {
  return results.every((r) => r.success && r.subagentPrompt === undefined);
}

/**
 * Collapse duplicate git_snapshot artifacts within a single action to the
 * OLDEST one (first in metadata = earliest backup).
 *
 * Rapid/concurrent tool calls (e.g. an agent that batches edits in one turn)
 * fire several backups before the action boundary closes, so one action folder
 * can accumulate multiple git_snapshots. Each git_snapshot restore does
 * read-tree + checkout-index, which OVERWRITES the whole tree — so replaying
 * them in metadata order (oldest→newest) lets the NEWEST (already-edited)
 * snapshot win, leaving the agent's edits un-reverted. The oldest snapshot is
 * the true "state before this group of actions", so we keep only that one and
 * drop the later intermediates. Non-snapshot artifacts (pip_freeze, subagent,
 * policy_rewrite, …) are untouched.
 */
function collapseGitSnapshots(artifacts: BackupArtifact[]): BackupArtifact[] {
  let keptSnapshot = false;
  return artifacts.filter((a) => {
    if (a.strategy !== "git_snapshot") return true;
    if (keptSnapshot) return false; // drop newer snapshots in the same action
    keptSnapshot = true;
    return true;
  });
}

/**
 * Direct restore — jump straight to action N's snapshot.
 * Fast for workspace files (git_snapshot), but only covers what that
 * single action backed up. Use for quick workspace rollback.
 *
 * After a successful full-state restore (not --file mode), intermediate
 * folders (actions AFTER the target) are deleted.
 */
function restoreActionDirectInner(
  actionName: string,
  config: SandboxConfig,
  options?: { fileOnly?: string }
): RestoreResult[] {
  const backupRoot = path.resolve(config.backupDir);
  const actionDir = path.join(backupRoot, actionName);
  const metaPath = path.join(actionDir, "metadata.json");

  if (!fs.existsSync(metaPath)) {
    return [{ success: false, description: `No metadata found in ${actionName}` }];
  }

  let artifacts: BackupArtifact[];
  try {
    artifacts = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return [{ success: false, description: `Corrupt metadata in ${actionName}` }];
  }

  if (options?.fileOnly) {
    const snapshot = artifacts.find((a) => a.strategy === "git_snapshot");
    if (!snapshot) {
      return [{ success: false, description: `No git snapshot found in ${actionName}` }];
    }

    const shadowDir = snapshot.artifactPath;
    // Use the specific commit hash for this action, not HEAD.
    const commit = snapshot.commitHash ?? snapshot.id;
    if (!commit) {
      return [{ success: false, description: "Snapshot is missing commit hash" }];
    }

    const cwd = process.cwd();
    try {
      execSync(`git checkout ${commit} -- "${options.fileOnly}"`, {
        encoding: "utf-8",
        timeout: 30_000,
        env: { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: cwd },
        cwd,
        stdio: "pipe",
      });
      // Single-file restore does NOT prune intermediate folders —
      // the other files in later actions may still be wanted.
      return [{
        success: true,
        description: `Restored ${options.fileOnly} from ${actionName} snapshot`,
      }];
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return [{ success: false, description: `File restore failed: ${msg.slice(0, 200)}` }];
    }
  }

  // Full restore — apply artifacts, then prune intermediate folders.
  const results = collapseGitSnapshots(artifacts).map((a) => restoreArtifact(a, config));

  if (allSucceeded(results)) {
    const deleted = pruneIntermediateFolders(actionName, config);
    if (deleted > 0) {
      results.push({
        success: true,
        description: `Pruned ${deleted} intermediate action folder${deleted === 1 ? "" : "s"}`,
      });
    }
  }

  return results;
}

/**
 * Reverse-loop restore — undo actions one by one from latest back to N+1.
 *
 * For each action being undone (in reverse order):
 *   - git_snapshot: restore workspace from that action's snapshot
 *   - pip_freeze / npm_list / env_snapshot: restore from that action's manifest
 *   - subagent: generate prompt for subagent
 *
 * This is safer than direct jump because each step is a small, well-defined
 * reversal. If one step fails, you know exactly where it stopped.
 *
 * After a successful restore, intermediate folders (those we walked through)
 * are deleted — they're off the main timeline now.
 */
function restoreActionLoopInner(
  targetActionName: string,
  config: SandboxConfig
): RestoreResult[] {
  const actions = listRestorableActions(config);
  const targetIdx = actions.findIndex((i) => i.name === targetActionName);

  if (targetIdx === -1) {
    return [{ success: false, description: `Action not found: ${targetActionName}` }];
  }

  // NOTE: we do NOT short-circuit when targetIdx is the latest action.
  // Each snapshot captures the state BEFORE the action ran, so
  // "restore 1" when there's only 1 action means: apply that
  // snapshot, reverting the single change the user made. The loop below
  // simply skips the "walk backwards" phase (since i > targetIdx is
  // immediately false) and proceeds directly to the target restore.

  const results: RestoreResult[] = [];
  let anyFailed = false;
  // True if any restored artifact reversed remote/dynamic state we can't
  // re-read (live-restore). We keep ALL backups in that case — pruning the
  // only copy of unverified remote state would be unrecoverable.
  let anyUnverified = false;

  // Walk backwards: undo actions from latest down to targetIdx + 1
  // Each step restores the state that existed BEFORE that action.
  for (let i = actions.length - 1; i > targetIdx; i--) {
    const inter = actions[i];
    results.push({
      success: true,
      description: `--- Undoing ${inter.name} ---`,
    });

    for (const artifact of collapseGitSnapshots(inter.artifacts)) {
      const r = restoreArtifact(artifact, config);
      results.push(r);
      if (r.unverified) anyUnverified = true;

      if (!r.success && !r.subagentPrompt) {
        anyFailed = true;
        // Non-fatal: log and continue to next artifact
        results.push({
          success: false,
          description: `Warning: failed to restore ${artifact.strategy} in ${inter.name}, continuing...`,
        });
      }
    }
  }

  // Finally, restore the target action's state directly.
  // IMPORTANT: call restoreArtifact on each artifact of the target rather than
  // restoreActionDirect — the latter would itself try to prune folders
  // and we want to coordinate pruning at this level.
  results.push({
    success: true,
    description: `--- Restoring target: ${targetActionName} ---`,
  });
  const targetAction = actions[targetIdx];
  for (const artifact of collapseGitSnapshots(targetAction.artifacts)) {
    // Pass config — without it the liveRestore branch in
    // restoreSubagent can't spawn the restore subagent and silently
    // degrades to a prompt-only no-op for the most important action
    // in the whole operation (the state we're restoring TO).
    const r = restoreArtifact(artifact, config);
    results.push(r);
    if (r.unverified) anyUnverified = true;
    if (!r.success && !r.subagentPrompt) {
      anyFailed = true;
    }
  }

  // Prune intermediate folders only if everything succeeded AND every step
  // was verifiable. A live-restore reversed remote state we can't re-read,
  // so pruning its backup would destroy the only copy on an unconfirmed
  // outcome — keep the folders in that case too.
  if (!anyFailed && !anyUnverified) {
    const deleted = pruneIntermediateFolders(targetActionName, config);
    if (deleted > 0) {
      results.push({
        success: true,
        description: `Pruned ${deleted} intermediate action folder${deleted === 1 ? "" : "s"}`,
      });
    }
  } else if (anyUnverified) {
    results.push({
      success: true,
      description: "Backups KEPT (a live-restore reversed unverifiable remote state — re-check it, restore again if needed).",
    });
  } else {
    results.push({
      success: false,
      description: "Intermediate folders NOT pruned (some restore steps failed). Inspect and retry.",
    });
  }

  return results;
}

// ── Restore history ledger ───────────────────────────────────────────
// Every restore attempt (CLI or dashboard, success or failure) is
// appended to .chats-sandbox/restore-history.jsonl so there is an audit
// trail of when the workspace was rewound and how it went. The ledger
// must never block a restore — all failures are swallowed.

export interface RestoreLogEntry {
  ts: string;
  mode: "direct" | "loop" | "file";
  action: string;
  seq: number | null;
  fileOnly?: string;
  steps: number;
  ok: number;
  failed: number;
}

function restoreHistoryPath(config: SandboxConfig): string {
  return path.join(path.dirname(path.resolve(config.backupDir)), "restore-history.jsonl");
}

function logRestoreOp(
  config: SandboxConfig,
  mode: "direct" | "loop" | "file",
  actionName: string,
  results: RestoreResult[],
  fileOnly?: string,
): void {
  try {
    const m = actionName.match(/^action_(\d+)_/);
    const entry: RestoreLogEntry = {
      ts: new Date().toISOString(),
      mode,
      action: actionName,
      seq: m ? parseInt(m[1], 10) : null,
      ...(fileOnly ? { fileOnly } : {}),
      steps: results.length,
      ok: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    };
    const file = restoreHistoryPath(config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // ledger is best-effort
  }
}

/** Read the restore ledger, newest first. */
export function readRestoreHistory(config: SandboxConfig, limit = 100): RestoreLogEntry[] {
  try {
    const file = restoreHistoryPath(config);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l: string) => l.trim());
    const out: RestoreLogEntry[] = [];
    for (const l of lines) {
      try { out.push(JSON.parse(l) as RestoreLogEntry); } catch { /* skip bad line */ }
    }
    return out.reverse().slice(0, limit);
  } catch {
    return [];
  }
}

export function restoreActionDirect(
  actionName: string,
  config: SandboxConfig,
  options?: { fileOnly?: string }
): RestoreResult[] {
  const results = restoreActionDirectInner(actionName, config, options);
  logRestoreOp(config, options?.fileOnly ? "file" : "direct", actionName, results, options?.fileOnly);
  return results;
}

export function restoreActionLoop(
  targetActionName: string,
  config: SandboxConfig
): RestoreResult[] {
  const results = restoreActionLoopInner(targetActionName, config);
  logRestoreOp(config, "loop", targetActionName, results);
  return results;
}

/**
 * List all actions with their artifact summaries for the restore CLI.
 */
export function listRestorableActions(config: SandboxConfig): Array<{
  name: string;
  artifacts: BackupArtifact[];
}> {
  const backupRoot = path.resolve(config.backupDir);
  const dirs = listActions(config);

  return dirs.map((name) => {
    const metaPath = path.join(backupRoot, name, "metadata.json");
    let artifacts: BackupArtifact[] = [];
    if (fs.existsSync(metaPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        // Guard against metadata.json that's a non-array (bad write, manual
        // edit, legacy single-object format). restoreActionLoop's
        // `for (const artifact of inter.artifacts)` would otherwise blow up
        // with "not iterable" on a plain object.
        if (Array.isArray(parsed)) {
          artifacts = parsed as BackupArtifact[];
        } else if (parsed && typeof parsed === "object") {
          // Best-effort: wrap a single-object metadata as a one-element array.
          artifacts = [parsed as BackupArtifact];
        }
        // Anything else (primitive, null) → leave as [].
      } catch {
        // corrupt JSON — leave as []
      }
    }
    return { name, artifacts };
  });
}
