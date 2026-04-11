/**
 * Restore engine — reverse a backup artifact to recover prior state.
 *
 * Tiers 1-2: deterministic restore (known inverse for each strategy).
 * Tier 3 (subagent): returns a prompt for the subagent to execute.
 *
 * Restore never deletes the backup — it stays in the interaction folder
 * so you can restore again or inspect what was there.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { BackupArtifact, SandboxConfig } from "../types.js";
import { listInteractions } from "../backup/manifest.js";

// ── Types ────────────────────────────────────────────────────────────

export interface RestoreResult {
  success: boolean;
  /** What was restored */
  description: string;
  /** If subagent is needed, this contains the prompt */
  subagentPrompt?: string;
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
    const packages = Object.entries(deps)
      .map(([name, info]: [string, unknown]) => {
        const version = (info as Record<string, string>)?.version;
        return version ? `${name}@${version}` : name;
      })
      .join(" ");

    if (!packages) {
      return { success: true, description: "No packages to restore" };
    }

    const result = exec(`npm install ${packages}`);
    if (result.ok) {
      return { success: true, description: `Restored npm packages from ${listPath}` };
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
  // which may be a later interaction than the one we want to restore.
  const commit = artifact.commitHash ?? artifact.id;
  if (!commit) {
    return { success: false, description: "Artifact is missing commit hash" };
  }

  // Verify the commit exists in the shadow repo
  const verifyResult = exec(`git rev-parse ${commit}`, shadowDir);
  if (!verifyResult.ok) {
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

// ── Tier 3: subagent restore prompt ──────────────────────────────────

function buildSubagentRestorePrompt(artifact: BackupArtifact): string {
  const commands = artifact.subagentCommands?.length
    ? artifact.subagentCommands.map((c, i) => `  ${i + 1}. ${c}`).join("\n")
    : "  (no commands recorded)";

  const action = artifact.originalAction ?? artifact.toolName;

  return (
    `RESTORE TASK: A previous modification needs to be reversed.\n\n` +
    `ORIGINAL ACTION:\n  ${action}\n\n` +
    `WHAT WAS BACKED UP:\n  ${artifact.description}\n\n` +
    `BACKUP COMMANDS THAT WERE RUN:\n${commands}\n\n` +
    `BACKUP ARTIFACT LOCATION:\n  ${artifact.artifactPath}\n\n` +
    `INSTRUCTIONS:\n` +
    `- Use the backup artifacts above to restore the prior state.\n` +
    `- Reverse the effects of the original action.\n` +
    `- If the backup includes files, restore them to their original locations.\n` +
    `- If the backup includes remote state (git tags, API snapshots), use them to revert.\n` +
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
export function restoreArtifact(artifact: BackupArtifact): RestoreResult {
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
      return {
        success: true,
        description: "Subagent restore needed",
        subagentPrompt: buildSubagentRestorePrompt(artifact),
      };
    default:
      return { success: false, description: `Unknown strategy: ${artifact.strategy}` };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Delete interaction folders from the target onwards (inclusive).
 *
 * Since each snapshot captures the state BEFORE the interaction ran,
 * restoring to interaction N means "undo N." So folder N itself should
 * also be deleted — the workspace is now in the pre-N state, and
 * folder N's snapshot has been applied.
 *
 * Commits in the shared shadow repo remain as dangling objects
 * (git will garbage-collect them eventually).
 *
 * Returns the number of folders deleted.
 */
function pruneIntermediateFolders(
  targetInteractionName: string,
  config: SandboxConfig
): number {
  const backupRoot = path.resolve(config.backupDir);
  const interactions = listRestorableInteractions(config);
  const targetIdx = interactions.findIndex((i) => i.name === targetInteractionName);

  if (targetIdx === -1) {
    return 0;
  }

  let deleted = 0;
  // Delete from targetIdx onwards (inclusive — target folder is also removed)
  for (let i = targetIdx; i < interactions.length; i++) {
    const folder = path.join(backupRoot, interactions[i].name);
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
 * Check if all results in a restore operation succeeded (allowing
 * subagent-needed as "success" since the deterministic part worked).
 */
function allSucceeded(results: RestoreResult[]): boolean {
  return results.every((r) => r.success || r.subagentPrompt !== undefined);
}

/**
 * Direct restore — jump straight to interaction N's snapshot.
 * Fast for workspace files (git_snapshot), but only covers what that
 * single interaction backed up. Use for quick workspace rollback.
 *
 * After a successful full-state restore (not --file mode), intermediate
 * folders (interactions AFTER the target) are deleted.
 */
export function restoreInteractionDirect(
  interactionName: string,
  config: SandboxConfig,
  options?: { fileOnly?: string }
): RestoreResult[] {
  const backupRoot = path.resolve(config.backupDir);
  const interactionDir = path.join(backupRoot, interactionName);
  const metaPath = path.join(interactionDir, "metadata.json");

  if (!fs.existsSync(metaPath)) {
    return [{ success: false, description: `No metadata found in ${interactionName}` }];
  }

  let artifacts: BackupArtifact[];
  try {
    artifacts = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return [{ success: false, description: `Corrupt metadata in ${interactionName}` }];
  }

  if (options?.fileOnly) {
    const snapshot = artifacts.find((a) => a.strategy === "git_snapshot");
    if (!snapshot) {
      return [{ success: false, description: `No git snapshot found in ${interactionName}` }];
    }

    const shadowDir = snapshot.artifactPath;
    // Use the specific commit hash for this interaction, not HEAD.
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
      // the other files in later interactions may still be wanted.
      return [{
        success: true,
        description: `Restored ${options.fileOnly} from ${interactionName} snapshot`,
      }];
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return [{ success: false, description: `File restore failed: ${msg.slice(0, 200)}` }];
    }
  }

  // Full restore — apply all artifacts, then prune intermediate folders.
  const results = artifacts.map((a) => restoreArtifact(a));

  if (allSucceeded(results)) {
    const deleted = pruneIntermediateFolders(interactionName, config);
    if (deleted > 0) {
      results.push({
        success: true,
        description: `Pruned ${deleted} intermediate interaction folder${deleted === 1 ? "" : "s"}`,
      });
    }
  }

  return results;
}

/**
 * Reverse-loop restore — undo interactions one by one from latest back to N+1.
 *
 * For each interaction being undone (in reverse order):
 *   - git_snapshot: restore workspace from that interaction's snapshot
 *   - pip_freeze / npm_list / env_snapshot: restore from that interaction's manifest
 *   - subagent: generate prompt for subagent
 *
 * This is safer than direct jump because each step is a small, well-defined
 * reversal. If one step fails, you know exactly where it stopped.
 *
 * After a successful restore, intermediate folders (those we walked through)
 * are deleted — they're off the main timeline now.
 */
export function restoreInteractionLoop(
  targetInteractionName: string,
  config: SandboxConfig
): RestoreResult[] {
  const interactions = listRestorableInteractions(config);
  const targetIdx = interactions.findIndex((i) => i.name === targetInteractionName);

  if (targetIdx === -1) {
    return [{ success: false, description: `Interaction not found: ${targetInteractionName}` }];
  }

  // Nothing to undo — already at or before target
  if (targetIdx >= interactions.length - 1) {
    return [{ success: true, description: `Already at interaction ${targetInteractionName}` }];
  }

  const results: RestoreResult[] = [];
  let anyFailed = false;

  // Walk backwards: undo interactions from latest down to targetIdx + 1
  // Each step restores the state that existed BEFORE that interaction.
  for (let i = interactions.length - 1; i > targetIdx; i--) {
    const inter = interactions[i];
    results.push({
      success: true,
      description: `--- Undoing ${inter.name} ---`,
    });

    for (const artifact of inter.artifacts) {
      const r = restoreArtifact(artifact);
      results.push(r);

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

  // Finally, restore the target interaction's state directly.
  // IMPORTANT: call restoreArtifact on each artifact of the target rather than
  // restoreInteractionDirect — the latter would itself try to prune folders
  // and we want to coordinate pruning at this level.
  results.push({
    success: true,
    description: `--- Restoring target: ${targetInteractionName} ---`,
  });
  const targetInteraction = interactions[targetIdx];
  for (const artifact of targetInteraction.artifacts) {
    const r = restoreArtifact(artifact);
    results.push(r);
    if (!r.success && !r.subagentPrompt) {
      anyFailed = true;
    }
  }

  // Prune intermediate folders only if everything succeeded.
  // If any step failed, leave the folders so the user can inspect/retry.
  if (!anyFailed) {
    const deleted = pruneIntermediateFolders(targetInteractionName, config);
    if (deleted > 0) {
      results.push({
        success: true,
        description: `Pruned ${deleted} intermediate interaction folder${deleted === 1 ? "" : "s"}`,
      });
    }
  } else {
    results.push({
      success: false,
      description: "Intermediate folders NOT pruned (some restore steps failed). Inspect and retry.",
    });
  }

  return results;
}

// Keep backward compat alias
export const restoreInteraction = restoreInteractionDirect;

/**
 * List all interactions with their artifact summaries for the restore CLI.
 */
export function listRestorableInteractions(config: SandboxConfig): Array<{
  name: string;
  artifacts: BackupArtifact[];
}> {
  const backupRoot = path.resolve(config.backupDir);
  const dirs = listInteractions(config);

  return dirs.map((name) => {
    const metaPath = path.join(backupRoot, name, "metadata.json");
    let artifacts: BackupArtifact[] = [];
    if (fs.existsSync(metaPath)) {
      try {
        artifacts = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      } catch {
        // skip corrupt
      }
    }
    return { name, artifacts };
  });
}
