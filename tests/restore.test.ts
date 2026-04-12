/**
 * Tests for the restore engine (restore/restore.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { restoreArtifact } from "../src/restore/restore.js";
import type { BackupArtifact } from "../src/types.js";

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
    assert.equal(r.success, true);
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
