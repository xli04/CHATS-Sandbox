/**
 * End-to-end tests for the restore engine (restore/restore.ts).
 *
 * Creates a real temp workspace, runs actual backups via strategies.ts,
 * then exercises restoreActionDirect and restoreActionLoop.
 * These tests catch bugs the unit tests miss — like the HEAD-vs-commit-hash
 * bug that the refactor to a shared shadow repo introduced.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runBackup, resetAction } from "../src/backup/strategies.js";
import {
  restoreActionDirect,
  restoreActionLoop,
  listRestorableActions,
} from "../src/restore/restore.js";
import { DEFAULT_CONFIG, type HookContext, type SandboxConfig } from "../src/types.js";

function makeCtx(toolName: string, toolInput: Record<string, unknown>): HookContext {
  return { hook_event: "PreToolUse", tool_name: toolName, tool_input: toolInput };
}

/**
 * Create a temp workspace, chdir to it, return a config pointing at it.
 * Tests that use this MUST save and restore process.cwd.
 */
function setupWorkspace(): { workspace: string; config: SandboxConfig; originalCwd: string } {
  const originalCwd = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chats-restore-e2e-"));
  process.chdir(workspace);
  const config: SandboxConfig = {
    ...DEFAULT_CONFIG,
    backupDir: path.join(workspace, ".chats-sandbox", "backups"),
    maxActions: 20,
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

// ── Single file overwrite → restore ──────────────────────────────────

describe("restore e2e: single file overwrite", () => {
  beforeEach(() => resetAction());

  it("restores file content from action 1", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      // Initial state
      const filePath = path.join(workspace, "hello.txt");
      fs.writeFileSync(filePath, "original content\n");

      // Backup before edit
      runBackup(makeCtx("Write", { path: filePath, content: "new" }), config);

      // Simulate the edit
      fs.writeFileSync(filePath, "new content\n");

      // Listing should show 1 action
      const actions = listRestorableActions(config);
      assert.equal(actions.length, 1);

      // Restore direct
      const results = restoreActionDirect(actions[0].name, config);
      const ok = results.every((r) => r.success || r.subagentPrompt);
      assert.ok(ok, `Expected all results to succeed, got: ${JSON.stringify(results)}`);

      // File should be back to original
      const restored = fs.readFileSync(filePath, "utf-8");
      assert.equal(restored, "original content\n");
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});

// ── Multi-step restore loop ──────────────────────────────────────────

describe("restore e2e: restoreActionLoop", () => {
  beforeEach(() => resetAction());

  it("walks back through multiple actions", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      const filePath = path.join(workspace, "main.py");

      // Step 1: create v1
      fs.writeFileSync(filePath, "version_1\n");
      runBackup(makeCtx("Write", { path: filePath, content: "v1" }), config);

      // Step 2: edit to v2
      resetAction();
      fs.writeFileSync(filePath, "version_2\n");
      runBackup(makeCtx("Write", { path: filePath, content: "v2" }), config);

      // Step 3: edit to v3
      resetAction();
      fs.writeFileSync(filePath, "version_3\n");
      runBackup(makeCtx("Write", { path: filePath, content: "v3" }), config);

      const actions = listRestorableActions(config);
      assert.equal(actions.length, 3);

      // Loop restore back to action 1
      const results = restoreActionLoop(actions[0].name, config);

      // Every step should have succeeded
      const failures = results.filter((r) => !r.success && !r.subagentPrompt);
      assert.equal(failures.length, 0, `Unexpected failures: ${JSON.stringify(failures)}`);

      // File should be back to version_1
      const content = fs.readFileSync(filePath, "utf-8");
      assert.equal(content, "version_1\n");
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("rejects nonexistent action name", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      const results = restoreActionLoop("action_999_00000000000000", config);
      assert.equal(results.length, 1);
      assert.equal(results[0].success, false);
      assert.ok(results[0].description.includes("not found"));
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("single-action restore applies the only snapshot", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      // Create an original file BEFORE the first backup
      const filePath = path.join(workspace, "a.txt");
      fs.writeFileSync(filePath, "original\n");

      // First action: snapshot captures state with "original"
      runBackup(makeCtx("Write", { path: filePath, content: "new" }), config);

      // Now modify the file (simulating what the tool would have done)
      fs.writeFileSync(filePath, "new content\n");
      assert.equal(fs.readFileSync(filePath, "utf-8"), "new content\n");

      // Restore to action 1 (the only one) — should revert to "original"
      const actions = listRestorableActions(config);
      assert.equal(actions.length, 1);
      const results = restoreActionLoop(actions[0].name, config);

      // Should have actually restored (not short-circuited)
      const failures = results.filter((r) => !r.success && !r.subagentPrompt);
      assert.equal(failures.length, 0, `Unexpected failures: ${JSON.stringify(failures)}`);

      // File should be back to "original"
      assert.equal(fs.readFileSync(filePath, "utf-8"), "original\n");
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});

// ── Commit-hash regression (the bug we just fixed) ───────────────────

describe("restore e2e: specific-commit targeting (not HEAD)", () => {
  beforeEach(() => resetAction());

  it("restoreActionDirect uses the specific commit (not HEAD)", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      const filePath = path.join(workspace, "data.txt");

      // Three actions with distinct contents
      fs.writeFileSync(filePath, "A\n");
      runBackup(makeCtx("Write", { path: filePath, content: "A" }), config);

      resetAction();
      fs.writeFileSync(filePath, "B\n");
      runBackup(makeCtx("Write", { path: filePath, content: "B" }), config);

      resetAction();
      fs.writeFileSync(filePath, "C\n");
      runBackup(makeCtx("Write", { path: filePath, content: "C" }), config);

      // Current state is "C"
      const actions = listRestorableActions(config);
      assert.equal(actions.length, 3);

      // Restore to action 1 → should get "A" (not "C", which would be the HEAD bug)
      const res1 = restoreActionDirect(actions[0].name, config);
      assert.ok(res1.every((r) => r.success || r.subagentPrompt));
      assert.equal(fs.readFileSync(filePath, "utf-8"), "A\n");

      // After restoring to 1, ALL folders (1, 2, 3) should be pruned.
      // Snapshot 1 = state BEFORE action 1, so action 1's folder
      // is also removed (its snapshot has been applied to the workspace).
      const remaining = listRestorableActions(config);
      assert.equal(remaining.length, 0, "All folders should be pruned after restoring to first action");
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("restoreActionDirect to middle action prunes only later ones", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      const filePath = path.join(workspace, "data.txt");

      fs.writeFileSync(filePath, "A\n");
      runBackup(makeCtx("Write", { path: filePath, content: "A" }), config);

      resetAction();
      fs.writeFileSync(filePath, "B\n");
      runBackup(makeCtx("Write", { path: filePath, content: "B" }), config);

      resetAction();
      fs.writeFileSync(filePath, "C\n");
      runBackup(makeCtx("Write", { path: filePath, content: "C" }), config);

      const actions = listRestorableActions(config);

      // Restore to action 2 → should get "B", prune actions 2 and 3
      // (snapshot 2 = state BEFORE action 2, so folder 2 is also removed)
      const res = restoreActionDirect(actions[1].name, config);
      assert.ok(res.every((r) => r.success || r.subagentPrompt));
      assert.equal(fs.readFileSync(filePath, "utf-8"), "B\n");

      const remaining = listRestorableActions(config);
      assert.equal(remaining.length, 1, "Only action 1 should remain");
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});

// ── File deletion on restore (the webpack.common.ts bug) ─────────────

describe("restore e2e: files added after target commit are deleted", () => {
  beforeEach(() => resetAction());

  it("restoreActionDirect removes files created by later actions", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      // Action 1: create file_a
      const fileA = path.join(workspace, "file_a.txt");
      fs.writeFileSync(fileA, "a\n");
      runBackup(makeCtx("Write", { path: fileA, content: "a" }), config);

      // Action 2: create file_b (file_a still exists)
      resetAction();
      const fileB = path.join(workspace, "file_b.txt");
      fs.writeFileSync(fileB, "b\n");
      runBackup(makeCtx("Write", { path: fileB, content: "b" }), config);

      // Action 3: create file_c (file_a + file_b still exist)
      resetAction();
      const fileC = path.join(workspace, "file_c.txt");
      fs.writeFileSync(fileC, "c\n");
      runBackup(makeCtx("Write", { path: fileC, content: "c" }), config);

      // All 3 files exist
      assert.ok(fs.existsSync(fileA));
      assert.ok(fs.existsSync(fileB));
      assert.ok(fs.existsSync(fileC));

      // Restore to action 1 — only file_a should remain
      const actions = listRestorableActions(config);
      const res = restoreActionDirect(actions[0].name, config);
      assert.ok(res.every((r) => r.success || r.subagentPrompt),
        `Restore failed: ${JSON.stringify(res)}`);

      assert.ok(fs.existsSync(fileA), "file_a should still exist");
      assert.ok(!fs.existsSync(fileB), "file_b should be deleted (created after target)");
      assert.ok(!fs.existsSync(fileC), "file_c should be deleted (created after target)");

      assert.equal(fs.readFileSync(fileA, "utf-8"), "a\n");
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("restoreActionLoop removes files created by undone actions", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      const fileA = path.join(workspace, "alpha.txt");
      fs.writeFileSync(fileA, "alpha\n");
      runBackup(makeCtx("Write", { path: fileA, content: "alpha" }), config);

      resetAction();
      const fileB = path.join(workspace, "beta.txt");
      fs.writeFileSync(fileB, "beta\n");
      runBackup(makeCtx("Write", { path: fileB, content: "beta" }), config);

      // Restore via loop to action 1
      const actions = listRestorableActions(config);
      restoreActionLoop(actions[0].name, config);

      assert.ok(fs.existsSync(fileA), "alpha.txt should exist");
      assert.ok(!fs.existsSync(fileB), "beta.txt should be deleted");
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});

// ── Single-file restore (fileOnly option) ────────────────────────────

describe("restore e2e: --file single-file restore", () => {
  beforeEach(() => resetAction());

  it("restores only the specified file, leaves others untouched", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      const fileA = path.join(workspace, "a.txt");
      const fileB = path.join(workspace, "b.txt");

      // Initial state
      fs.writeFileSync(fileA, "a_original\n");
      fs.writeFileSync(fileB, "b_original\n");
      runBackup(makeCtx("Write", { path: fileA, content: "a_original" }), config);

      // Modify BOTH files
      resetAction();
      fs.writeFileSync(fileA, "a_modified\n");
      fs.writeFileSync(fileB, "b_modified\n");
      runBackup(makeCtx("Write", { path: fileA, content: "a_modified" }), config);

      // Now restore ONLY a.txt from action 1
      const actions = listRestorableActions(config);
      const results = restoreActionDirect(actions[0].name, config, { fileOnly: "a.txt" });

      const failures = results.filter((r) => !r.success);
      assert.equal(failures.length, 0, `Unexpected failures: ${JSON.stringify(failures)}`);

      // a.txt should be back to original, b.txt should still be modified
      assert.equal(fs.readFileSync(fileA, "utf-8"), "a_original\n", "a.txt should be restored");
      assert.equal(fs.readFileSync(fileB, "utf-8"), "b_modified\n", "b.txt should remain modified");
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("returns failure when action has no git_snapshot", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      // Create an action folder manually with only a non-git-snapshot artifact
      const actionDir = path.join(config.backupDir, "action_001_19990101000000");
      fs.mkdirSync(actionDir, { recursive: true });
      fs.writeFileSync(
        path.join(actionDir, "metadata.json"),
        JSON.stringify([
          {
            id: "abc123",
            timestamp: new Date().toISOString(),
            trigger: "rule",
            toolName: "Bash",
            description: "pip freeze only",
            strategy: "pip_freeze",
            artifactPath: "/tmp/fake_pip_freeze.txt",
          },
        ]),
      );

      const results = restoreActionDirect(
        "action_001_19990101000000",
        config,
        { fileOnly: "some_file.txt" },
      );

      assert.equal(results.length, 1);
      assert.equal(results[0].success, false);
      assert.ok(results[0].description.toLowerCase().includes("no git snapshot"));
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});

// ── Partial restore failure → pruning skipped ────────────────────────

describe("restore e2e: partial failure preserves folders", () => {
  beforeEach(() => resetAction());

  it("restoreActionLoop does NOT prune when a step fails", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      // Action 1: real backup
      const fileA = path.join(workspace, "good.txt");
      fs.writeFileSync(fileA, "good\n");
      runBackup(makeCtx("Write", { path: fileA, content: "good" }), config);

      // Action 2: real backup
      resetAction();
      fs.writeFileSync(fileA, "changed\n");
      runBackup(makeCtx("Write", { path: fileA, content: "changed" }), config);

      // Now corrupt action 2's metadata to force a restore failure:
      // replace the commitHash with a nonexistent one
      const actions = listRestorableActions(config);
      assert.equal(actions.length, 2);

      const inter2Dir = path.join(
        path.resolve(config.backupDir),
        actions[1].name
      );
      const metaPath = path.join(inter2Dir, "metadata.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      for (const a of meta) {
        if (a.strategy === "git_snapshot") {
          a.commitHash = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        }
      }
      fs.writeFileSync(metaPath, JSON.stringify(meta));

      // Try to loop-restore to action 1
      const results = restoreActionLoop(actions[0].name, config);

      // Should have at least one failure
      const failures = results.filter((r: { success: boolean }) => !r.success);
      assert.ok(failures.length > 0, "Expected at least one failure from corrupted commit");

      // Folders should NOT be pruned because restore had a failure
      const remaining = listRestorableActions(config);
      assert.ok(
        remaining.length >= 2,
        `Expected folders preserved on failure, got ${remaining.length}`
      );
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});
