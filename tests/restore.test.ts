/**
 * Tests for the restore engine (restore/restore.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { restoreArtifact } from "../src/restore/restore.js";
import type { BackupArtifact, SandboxConfig, HookContext } from "../src/types.js";

function makeArtifact(overrides: Partial<BackupArtifact>): BackupArtifact {
  return {
    id: "test123",
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: "Bash",
    description: "test artifact",
    strategy: "pip_freeze",
    artifactPath: "/nonexistent",
    ...overrides,
  };
}

describe("restore - pip_freeze", () => {
  it("fails when backup file is missing", () => {
    const r = restoreArtifact(makeArtifact({
      strategy: "pip_freeze",
      artifactPath: "/tmp/nonexistent_pip_freeze.txt",
    }));
    assert.equal(r.success, false);
    assert.ok(r.description.includes("not found"));
  });
});

describe("restore - env_snapshot", () => {
  it("returns a restore command for env snapshots", () => {
    const tmpFile = path.join(os.tmpdir(), `env_test_${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "FOO=bar\nBAZ=qux\n", "utf-8");

    const r = restoreArtifact(makeArtifact({
      strategy: "env_snapshot",
      artifactPath: tmpFile,
    }));
    assert.equal(r.success, true);
    assert.ok(r.description.includes("source"), "Should provide a source command");

    fs.unlinkSync(tmpFile);
  });

  it("fails when env file is missing", () => {
    const r = restoreArtifact(makeArtifact({
      strategy: "env_snapshot",
      artifactPath: "/tmp/nonexistent_env.txt",
    }));
    assert.equal(r.success, false);
  });
});

describe("restore - git_tag", () => {
  it("fails when tag does not exist", () => {
    const r = restoreArtifact(makeArtifact({
      strategy: "git_tag",
      artifactPath: "chats-sandbox/nonexistent-tag-999",
    }));
    assert.equal(r.success, false);
    assert.ok(r.description.includes("not found"));
  });
});

describe("restore - git_snapshot", () => {
  it("fails when shadow repo is missing", () => {
    const r = restoreArtifact(makeArtifact({
      strategy: "git_snapshot",
      artifactPath: "/tmp/nonexistent_shadow_repo",
    }));
    assert.equal(r.success, false);
    assert.ok(r.description.includes("not found"));
  });

  it("verifies commit exists by querying with GIT_DIR (not cwd)", () => {
    // Regression: previously `git rev-parse <commit>` was called with
    // cwd=shadowDir, which fails because the shadow dir is bare-style
    // (no .git/ subdir). This made every restore_direct on an older
    // action mis-report "Commit not found in shadow repo" once an
    // intermediate restore pruned the latest commit's metadata folder.

    // Build a real shadow repo in a tmpdir + commit a file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chats-shadow-test-"));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "chats-work-test-"));
    const shadow = path.join(dir, "shadow-repo");
    fs.mkdirSync(shadow, { recursive: true });
    const env = { ...process.env, GIT_DIR: shadow, GIT_WORK_TREE: work };
    const opts = { encoding: "utf-8" as const, env, stdio: "pipe" as const };
    const { execSync } = require("node:child_process");
    execSync("git init -q", opts);
    execSync("git config user.email t@l", opts);
    execSync("git config user.name t", opts);
    fs.writeFileSync(path.join(work, "f.txt"), "hello\n");
    execSync("git add -A && git commit -qm seed", opts);
    const head = execSync("git rev-parse HEAD", opts).toString().trim();

    // Restore should succeed when the commit exists.
    const cwdBefore = process.cwd();
    process.chdir(work);
    try {
      // Modify f.txt so restore has work to do
      fs.writeFileSync(path.join(work, "f.txt"), "modified\n");
      const r = restoreArtifact(makeArtifact({
        strategy: "git_snapshot",
        artifactPath: shadow,
        commitHash: head,
      }));
      assert.equal(r.success, true, `restore failed: ${r.description}`);
      assert.equal(fs.readFileSync(path.join(work, "f.txt"), "utf-8"), "hello\n");
    } finally {
      process.chdir(cwdBefore);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("restore - subagent", () => {
  it("returns a subagent prompt", () => {
    // subagent restore now EXECUTES the recovery commands deterministically.
    // Use a safe, always-succeeding command so the test is hermetic.
    const r = restoreArtifact(makeArtifact({
      strategy: "subagent",
      description: "backup complete",
      subagentCommands: ["true"],   // POSIX 'true' always succeeds
      originalAction: "some risky action",
    }));
    assert.equal(r.success, true);
    assert.ok(
      r.description.includes("executed") || r.description.includes("recovery"),
      `Expected executed/recovery in description, got: ${r.description}`
    );
  });

  it("returns failure when a recovery command fails", () => {
    const r = restoreArtifact(makeArtifact({
      strategy: "subagent",
      description: "backup",
      subagentCommands: ["false"],  // POSIX 'false' always exits non-zero
      originalAction: "test action",
    }));
    assert.equal(r.success, false);
    assert.ok(r.description.toLowerCase().includes("fail"),
      `Expected failure description, got: ${r.description}`);
  });

  it("handles missing subagentCommands gracefully", () => {
    const r = restoreArtifact(makeArtifact({
      strategy: "subagent",
      description: "Some backup",
    }));
    // A prompt-only deferral did NOT restore anything, so it must
    // report success:false (was previously true, which let callers
    // prune folders and show a false "✓ restored"). The prompt is
    // still surfaced so the caller knows what work remains.
    assert.equal(r.success, false);
    assert.ok(r.subagentPrompt!.includes("no commands recorded"));
  });
});

describe("restore - unknown strategy", () => {
  it("fails for unknown strategy", () => {
    const r = restoreArtifact(makeArtifact({
      strategy: "file_copy" as "pip_freeze", // file_copy was removed but test the fallback
    }));
    // file_copy doesn't exist as a strategy in restore — should handle gracefully
    // Actually file_copy is still in the type union, it just has no restore handler
    // The switch falls to default
    assert.equal(r.success, false);
  });
});

// Regression: rapid/concurrent backups group multiple git_snapshots into one
// action. Restore must collapse them to the OLDEST (pre-group) snapshot, not
// replay them newest-last (which would leave the agent's edits un-reverted).
// See collapseGitSnapshots() in restore.ts.
describe("restore - grouped git_snapshots (concurrent-backup regression)", () => {
  it("reverts all edits when one action holds multiple snapshots", () => {
    const cp = require("node:child_process") as typeof import("node:child_process");
    const { runBackup } = require("../src/backup/strategies.js") as typeof import("../src/backup/strategies.js");
    const { restoreActionLoop } = require("../src/restore/restore.js") as typeof import("../src/restore/restore.js");

    const W = fs.mkdtempSync(path.join(os.tmpdir(), "grp-"));
    const cwd0 = process.cwd();
    try {
      process.chdir(W);
      cp.execSync("git init -q && git config user.email e@x && git config user.name e");
      fs.writeFileSync("a.py", "A-orig\n");
      fs.writeFileSync("tests.py", "TESTS-orig\n");
      cp.execSync("git add -A && git commit -qm base");

      const cfg = { backupDir: path.join(W, ".chats-sandbox", "backups"), subagentEnabled: false, maxActions: 50 } as unknown as SandboxConfig;
      const ctx = (p: string): HookContext => ({ hook_event: "PreToolUse", tool_name: "patch", tool_input: { path: p } });
      // 3 rapid backups (same pending action) with edits between them
      runBackup(ctx("a.py"), cfg);
      fs.writeFileSync("a.py", "A-edit1\n");
      runBackup(ctx("tests.py"), cfg);
      fs.writeFileSync("tests.py", "TESTS-EDITED\n");
      runBackup(ctx("a.py"), cfg);
      fs.writeFileSync("a.py", "A-edit2\n");

      const acts = fs.readdirSync(cfg.backupDir).filter((d: string) => d.startsWith("action_")).sort();
      const meta = JSON.parse(fs.readFileSync(path.join(cfg.backupDir, acts[0], "metadata.json"), "utf-8"));
      const snaps = meta.filter((m: { strategy: string }) => m.strategy === "git_snapshot").length;
      assert.ok(snaps >= 2, `expected grouped snapshots, got ${snaps}`);

      restoreActionLoop(acts[0], cfg);
      assert.equal(fs.readFileSync("tests.py", "utf-8").trim(), "TESTS-orig", "tests.py must revert");
      assert.equal(fs.readFileSync("a.py", "utf-8").trim(), "A-orig", "a.py must revert");
    } finally {
      process.chdir(cwd0);
      fs.rmSync(W, { recursive: true, force: true });
    }
  });
});
