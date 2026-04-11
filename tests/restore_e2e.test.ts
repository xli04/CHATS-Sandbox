/**
 * End-to-end tests for the restore engine (restore/restore.ts).
 *
 * Creates a real temp workspace, runs actual backups via strategies.ts,
 * then exercises restoreInteractionDirect and restoreInteractionLoop.
 * These tests catch bugs the unit tests miss — like the HEAD-vs-commit-hash
 * bug that the refactor to a shared shadow repo introduced.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runBackup, resetInteraction } from "../src/backup/strategies.js";
import {
  restoreInteractionDirect,
  restoreInteractionLoop,
  listRestorableInteractions,
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
    maxInteractions: 20,
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
  beforeEach(() => resetInteraction());

  it("restores file content from interaction 1", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      // Initial state
      const filePath = path.join(workspace, "hello.txt");
      fs.writeFileSync(filePath, "original content\n");

      // Backup before edit
      runBackup(makeCtx("Write", { path: filePath, content: "new" }), config);

      // Simulate the edit
      fs.writeFileSync(filePath, "new content\n");

      // Listing should show 1 interaction
      const interactions = listRestorableInteractions(config);
      assert.equal(interactions.length, 1);

      // Restore direct
      const results = restoreInteractionDirect(interactions[0].name, config);
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

describe("restore e2e: restoreInteractionLoop", () => {
  beforeEach(() => resetInteraction());

  it("walks back through multiple interactions", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      const filePath = path.join(workspace, "main.py");

      // Step 1: create v1
      fs.writeFileSync(filePath, "version_1\n");
      runBackup(makeCtx("Write", { path: filePath, content: "v1" }), config);

      // Step 2: edit to v2
      resetInteraction();
      fs.writeFileSync(filePath, "version_2\n");
      runBackup(makeCtx("Write", { path: filePath, content: "v2" }), config);

      // Step 3: edit to v3
      resetInteraction();
      fs.writeFileSync(filePath, "version_3\n");
      runBackup(makeCtx("Write", { path: filePath, content: "v3" }), config);

      const interactions = listRestorableInteractions(config);
      assert.equal(interactions.length, 3);

      // Loop restore back to interaction 1
      const results = restoreInteractionLoop(interactions[0].name, config);

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

  it("rejects nonexistent interaction name", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      const results = restoreInteractionLoop("interaction_999_00000000000000", config);
      assert.equal(results.length, 1);
      assert.equal(results[0].success, false);
      assert.ok(results[0].description.includes("not found"));
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("returns already-at-target when restoring to latest", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      const filePath = path.join(workspace, "a.txt");
      fs.writeFileSync(filePath, "one\n");
      runBackup(makeCtx("Write", { path: filePath, content: "x" }), config);

      const interactions = listRestorableInteractions(config);
      // Restoring to the last interaction is a no-op
      const results = restoreInteractionLoop(interactions[interactions.length - 1].name, config);
      assert.ok(results.some((r) => r.description.includes("Already at")));
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});

// ── Commit-hash regression (the bug we just fixed) ───────────────────

describe("restore e2e: specific-commit targeting (not HEAD)", () => {
  beforeEach(() => resetInteraction());

  it("restoreInteractionDirect uses the specific commit (not HEAD)", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      const filePath = path.join(workspace, "data.txt");

      // Three interactions with distinct contents
      fs.writeFileSync(filePath, "A\n");
      runBackup(makeCtx("Write", { path: filePath, content: "A" }), config);

      resetInteraction();
      fs.writeFileSync(filePath, "B\n");
      runBackup(makeCtx("Write", { path: filePath, content: "B" }), config);

      resetInteraction();
      fs.writeFileSync(filePath, "C\n");
      runBackup(makeCtx("Write", { path: filePath, content: "C" }), config);

      // Current state is "C"
      const interactions = listRestorableInteractions(config);
      assert.equal(interactions.length, 3);

      // Restore to interaction 1 → should get "A" (not "C", which would be the HEAD bug)
      const res1 = restoreInteractionDirect(interactions[0].name, config);
      assert.ok(res1.every((r) => r.success || r.subagentPrompt));
      assert.equal(fs.readFileSync(filePath, "utf-8"), "A\n");

      // After restoring to 1, ALL folders (1, 2, 3) should be pruned.
      // Snapshot 1 = state BEFORE interaction 1, so interaction 1's folder
      // is also removed (its snapshot has been applied to the workspace).
      const remaining = listRestorableInteractions(config);
      assert.equal(remaining.length, 0, "All folders should be pruned after restoring to first interaction");
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("restoreInteractionDirect to middle interaction prunes only later ones", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      const filePath = path.join(workspace, "data.txt");

      fs.writeFileSync(filePath, "A\n");
      runBackup(makeCtx("Write", { path: filePath, content: "A" }), config);

      resetInteraction();
      fs.writeFileSync(filePath, "B\n");
      runBackup(makeCtx("Write", { path: filePath, content: "B" }), config);

      resetInteraction();
      fs.writeFileSync(filePath, "C\n");
      runBackup(makeCtx("Write", { path: filePath, content: "C" }), config);

      const interactions = listRestorableInteractions(config);

      // Restore to interaction 2 → should get "B", prune interactions 2 and 3
      // (snapshot 2 = state BEFORE interaction 2, so folder 2 is also removed)
      const res = restoreInteractionDirect(interactions[1].name, config);
      assert.ok(res.every((r) => r.success || r.subagentPrompt));
      assert.equal(fs.readFileSync(filePath, "utf-8"), "B\n");

      const remaining = listRestorableInteractions(config);
      assert.equal(remaining.length, 1, "Only interaction 1 should remain");
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});

// ── File deletion on restore (the webpack.common.ts bug) ─────────────

describe("restore e2e: files added after target commit are deleted", () => {
  beforeEach(() => resetInteraction());

  it("restoreInteractionDirect removes files created by later interactions", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      // Interaction 1: create file_a
      const fileA = path.join(workspace, "file_a.txt");
      fs.writeFileSync(fileA, "a\n");
      runBackup(makeCtx("Write", { path: fileA, content: "a" }), config);

      // Interaction 2: create file_b (file_a still exists)
      resetInteraction();
      const fileB = path.join(workspace, "file_b.txt");
      fs.writeFileSync(fileB, "b\n");
      runBackup(makeCtx("Write", { path: fileB, content: "b" }), config);

      // Interaction 3: create file_c (file_a + file_b still exist)
      resetInteraction();
      const fileC = path.join(workspace, "file_c.txt");
      fs.writeFileSync(fileC, "c\n");
      runBackup(makeCtx("Write", { path: fileC, content: "c" }), config);

      // All 3 files exist
      assert.ok(fs.existsSync(fileA));
      assert.ok(fs.existsSync(fileB));
      assert.ok(fs.existsSync(fileC));

      // Restore to interaction 1 — only file_a should remain
      const interactions = listRestorableInteractions(config);
      const res = restoreInteractionDirect(interactions[0].name, config);
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

  it("restoreInteractionLoop removes files created by undone interactions", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      const fileA = path.join(workspace, "alpha.txt");
      fs.writeFileSync(fileA, "alpha\n");
      runBackup(makeCtx("Write", { path: fileA, content: "alpha" }), config);

      resetInteraction();
      const fileB = path.join(workspace, "beta.txt");
      fs.writeFileSync(fileB, "beta\n");
      runBackup(makeCtx("Write", { path: fileB, content: "beta" }), config);

      // Restore via loop to interaction 1
      const interactions = listRestorableInteractions(config);
      restoreInteractionLoop(interactions[0].name, config);

      assert.ok(fs.existsSync(fileA), "alpha.txt should exist");
      assert.ok(!fs.existsSync(fileB), "beta.txt should be deleted");
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});

// ── Single-file restore (fileOnly option) ────────────────────────────

describe("restore e2e: --file single-file restore", () => {
  beforeEach(() => resetInteraction());

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
      resetInteraction();
      fs.writeFileSync(fileA, "a_modified\n");
      fs.writeFileSync(fileB, "b_modified\n");
      runBackup(makeCtx("Write", { path: fileA, content: "a_modified" }), config);

      // Now restore ONLY a.txt from interaction 1
      const interactions = listRestorableInteractions(config);
      const results = restoreInteractionDirect(interactions[0].name, config, { fileOnly: "a.txt" });

      const failures = results.filter((r) => !r.success);
      assert.equal(failures.length, 0, `Unexpected failures: ${JSON.stringify(failures)}`);

      // a.txt should be back to original, b.txt should still be modified
      assert.equal(fs.readFileSync(fileA, "utf-8"), "a_original\n", "a.txt should be restored");
      assert.equal(fs.readFileSync(fileB, "utf-8"), "b_modified\n", "b.txt should remain modified");
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("returns failure when interaction has no git_snapshot", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      // Create an interaction folder manually with only a non-git-snapshot artifact
      const interactionDir = path.join(config.backupDir, "interaction_001_19990101000000");
      fs.mkdirSync(interactionDir, { recursive: true });
      fs.writeFileSync(
        path.join(interactionDir, "metadata.json"),
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

      const results = restoreInteractionDirect(
        "interaction_001_19990101000000",
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
