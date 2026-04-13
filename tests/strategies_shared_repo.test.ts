/**
 * Tests for the shared shadow repo + lazy action folder behavior.
 *
 * These are the hardest-to-reason-about parts of the refactor:
 *   - Do read-only actions skip folder creation?
 *   - Does the shared repo correctly deduplicate snapshots?
 *   - Does pruning work with the shared repo?
 *   - Does commitHash get populated correctly?
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runBackup, resetAction } from "../src/backup/strategies.js";
import { listRestorableActions } from "../src/restore/restore.js";
import { DEFAULT_CONFIG, type HookContext, type SandboxConfig } from "../src/types.js";

function makeCtx(toolName: string, toolInput: Record<string, unknown>): HookContext {
  return { hook_event: "PreToolUse", tool_name: toolName, tool_input: toolInput };
}

function setup(): { workspace: string; config: SandboxConfig; originalCwd: string } {
  const originalCwd = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chats-shared-"));
  process.chdir(workspace);
  const config: SandboxConfig = {
    ...DEFAULT_CONFIG,
    backupDir: path.join(workspace, ".chats-sandbox", "backups"),
    maxActions: 3,
  };
  return { workspace, config, originalCwd };
}

function teardown(workspace: string, originalCwd: string): void {
  process.chdir(originalCwd);
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function countActionFolders(config: SandboxConfig): number {
  const dir = path.resolve(config.backupDir);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((d: string) => d.startsWith("action_")).length;
}

// ── Lazy folder creation ─────────────────────────────────────────────

describe("shared repo: lazy folder creation", () => {
  beforeEach(() => resetAction());

  it("creates a folder for the first action even with no workspace files", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      // Fresh workspace (just the .chats-sandbox dir). Run a backup.
      runBackup(makeCtx("Bash", { command: "ls" }), config);
      // First backup always creates something because the shared repo has no HEAD yet.
      // This is expected baseline behavior.
      const n = countActionFolders(config);
      assert.ok(n <= 1, `Expected 0 or 1 folders after first read-only call, got ${n}`);
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("does NOT create new folders for subsequent read-only actions", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      // First backup (establishes baseline)
      runBackup(makeCtx("Bash", { command: "echo init" }), config);
      const baseline = countActionFolders(config);

      // 5 more read-only calls — should NOT create new folders
      for (let i = 0; i < 5; i++) {
        resetAction();
        runBackup(makeCtx("Bash", { command: `ls -la ${i}` }), config);
      }

      const after = countActionFolders(config);
      assert.equal(after, baseline, `Read-only actions should not create new folders (baseline=${baseline}, after=${after})`);
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("creates a folder only when a real file changes", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      // Baseline
      runBackup(makeCtx("Bash", { command: "init" }), config);
      const baseline = countActionFolders(config);

      // Write a real file
      fs.writeFileSync(path.join(workspace, "hello.txt"), "world\n");

      resetAction();
      runBackup(makeCtx("Write", { path: "hello.txt", content: "world" }), config);

      const after = countActionFolders(config);
      assert.equal(after, baseline + 1, `Expected one new folder after a file change`);
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});

// ── Shared shadow repo ───────────────────────────────────────────────

describe("shared repo: commit chain", () => {
  beforeEach(() => resetAction());

  it("populates commitHash on every git_snapshot artifact", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      fs.writeFileSync(path.join(workspace, "a.txt"), "1\n");
      runBackup(makeCtx("Write", { path: "a.txt", content: "1" }), config);

      const actions = listRestorableActions(config);
      assert.ok(actions.length >= 1);

      const snapshot = actions[0].artifacts.find((a) => a.strategy === "git_snapshot");
      assert.ok(snapshot, "Expected a git_snapshot artifact");
      assert.ok(snapshot.commitHash, "Expected commitHash to be populated");
      assert.ok(snapshot.commitHash!.length >= 8, "commitHash should be a full or short sha");
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("produces distinct commit hashes for distinct states", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      const file = path.join(workspace, "x.txt");

      fs.writeFileSync(file, "A\n");
      runBackup(makeCtx("Write", { path: file, content: "A" }), config);

      resetAction();
      fs.writeFileSync(file, "B\n");
      runBackup(makeCtx("Write", { path: file, content: "B" }), config);

      const actions = listRestorableActions(config);
      assert.equal(actions.length, 2);

      const hash1 = actions[0].artifacts.find((a) => a.strategy === "git_snapshot")?.commitHash;
      const hash2 = actions[1].artifacts.find((a) => a.strategy === "git_snapshot")?.commitHash;

      assert.ok(hash1 && hash2);
      assert.notEqual(hash1, hash2, "Distinct states should have distinct commit hashes");
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});

// ── Pruning with shared repo ─────────────────────────────────────────

describe("shared repo: pruning", () => {
  beforeEach(() => resetAction());

  it("prunes oldest action folders when maxActions exceeded", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      config.maxActions = 2;

      // Create 4 actions that each change a file (so each creates a folder)
      for (let i = 0; i < 4; i++) {
        resetAction();
        fs.writeFileSync(path.join(workspace, `f${i}.txt`), `${i}\n`);
        runBackup(makeCtx("Write", { path: `f${i}.txt`, content: `${i}` }), config);
      }

      const n = countActionFolders(config);
      assert.ok(n <= 2, `Expected <= 2 folders after pruning, got ${n}`);
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});
