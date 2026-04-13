/**
 * Tests for the tier-3 subagent backup flow.
 *
 * These tests use a MOCK `claude` binary placed early in PATH. The mock
 * emits a canned JSON response instead of making real API calls. This
 * lets us test the full subagent → artifact → restore pipeline
 * deterministically and quickly.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runSubagentBackup } from "../src/backup/subagent.js";
import { runBackup, resetAction } from "../src/backup/strategies.js";
import { restoreArtifact } from "../src/restore/restore.js";
import { DEFAULT_CONFIG, type HookContext, type SandboxConfig, type BackupArtifact } from "../src/types.js";

function makeCtx(toolName: string, toolInput: Record<string, unknown>): HookContext {
  return { hook_event: "PreToolUse", tool_name: toolName, tool_input: toolInput };
}

// ── Mock claude CLI ──────────────────────────────────────────────────

const MOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chats-mock-claude-"));
const MOCK_CLAUDE = path.join(MOCK_DIR, "claude");
let originalPath = "";

function installMockClaude(responseJson: string): void {
  // Write the canned response to a sidecar file, then have the mock
  // script `cat` it. This avoids shell escaping entirely — we can
  // handle arbitrary JSON (even with embedded newlines and quotes).
  const responseFile = path.join(MOCK_DIR, "response.txt");
  fs.writeFileSync(responseFile, responseJson, "utf-8");
  const script = `#!/bin/sh
cat > /dev/null   # drain stdin (ignored — claude -p can take prompt as arg too)
cat "${responseFile}"
`;
  fs.writeFileSync(MOCK_CLAUDE, script);
  fs.chmodSync(MOCK_CLAUDE, 0o755);
}

function installBrokenMockClaude(): void {
  const script = `#!/bin/sh
echo "not JSON — completely broken output"
exit 0
`;
  fs.writeFileSync(MOCK_CLAUDE, script);
  fs.chmodSync(MOCK_CLAUDE, 0o755);
}

before(() => {
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${MOCK_DIR}:${originalPath}`;
});

after(() => {
  process.env.PATH = originalPath;
  try { fs.rmSync(MOCK_DIR, { recursive: true, force: true }); } catch { /* */ }
});

// ── Test setup helper ────────────────────────────────────────────────

function setup(): { workspace: string; config: SandboxConfig; originalCwd: string } {
  const originalCwd = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chats-sub-"));
  process.chdir(workspace);
  const config: SandboxConfig = {
    ...DEFAULT_CONFIG,
    backupDir: path.join(workspace, ".chats-sandbox", "backups"),
    maxActions: 10,
    subagentEnabled: true, // enable for these tests
    subagentTimeoutSeconds: 10,
  };
  // Create the action folder
  fs.mkdirSync(config.backupDir, { recursive: true });
  return { workspace, config, originalCwd };
}

function teardown(workspace: string, originalCwd: string): void {
  process.chdir(originalCwd);
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* */ }
}

// ── runSubagentBackup direct tests ───────────────────────────────────

describe("subagent: runSubagentBackup with mock claude CLI", () => {
  beforeEach(() => resetAction());

  it("parses claude -p --output-format json wrapper (result field)", () => {
    // Real claude -p --output-format json output looks like:
    // {"result": "...", "session_id": "...", ...}
    // The `result` field contains the model's text response, which
    // we expect to contain our JSON shape.
    const innerJson = JSON.stringify({
      description: "wrapper test",
      backup_commands: ["echo bw"],
      recovery_commands: ["echo rw"],
    });
    const wrapper = JSON.stringify({
      result: `Here is the backup plan:\n\n${innerJson}\n\nDone.`,
      session_id: "test-session",
    });
    installMockClaude(wrapper);

    const { workspace, config, originalCwd } = setup();
    try {
      const actionDir = path.join(config.backupDir, "action_test");
      fs.mkdirSync(actionDir, { recursive: true });

      const artifact = runSubagentBackup(
        makeCtx("Bash", { command: "curl -X POST https://api.example.com" }),
        actionDir,
        config
      );

      assert.ok(artifact, `Expected artifact, got null`);
      assert.ok(artifact!.description.includes("wrapper test"));
      assert.deepEqual(artifact!.subagentCommands, ["echo rw"]);
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("returns a BackupArtifact when mock claude emits valid JSON", () => {
    installMockClaude(JSON.stringify({
      description: "captured API state",
      backup_commands: ["echo captured"],
      recovery_commands: ["echo restored"],
      artifact_paths: [],
    }));

    const { workspace, config, originalCwd } = setup();
    try {
      const actionDir = path.join(config.backupDir, "action_test");
      fs.mkdirSync(actionDir, { recursive: true });

      const artifact = runSubagentBackup(
        makeCtx("Bash", { command: "curl -X POST https://api.example.com" }),
        actionDir,
        config
      );

      assert.ok(artifact, "Expected artifact to be returned");
      assert.equal(artifact!.strategy, "subagent");
      assert.ok(artifact!.description.includes("captured API state"));
      assert.deepEqual(artifact!.subagentCommands, ["echo restored"]);
      assert.ok(artifact!.originalAction?.includes("curl"));
      // Artifact file should exist on disk
      assert.ok(fs.existsSync(artifact!.artifactPath), "Artifact file not written");
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("returns null when claude output is unparseable", () => {
    installBrokenMockClaude();
    const { workspace, config, originalCwd } = setup();
    try {
      const actionDir = path.join(config.backupDir, "action_test");
      fs.mkdirSync(actionDir, { recursive: true });

      const artifact = runSubagentBackup(
        makeCtx("Bash", { command: "curl -X POST https://api.example.com" }),
        actionDir,
        config
      );
      assert.equal(artifact, null, "Expected null on broken output");
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("returns null when subagentEnabled is false", () => {
    installMockClaude(JSON.stringify({
      description: "x",
      backup_commands: [],
      recovery_commands: ["echo x"],
    }));
    const { workspace, config, originalCwd } = setup();
    try {
      config.subagentEnabled = false;
      const actionDir = path.join(config.backupDir, "action_test");
      fs.mkdirSync(actionDir, { recursive: true });

      const artifact = runSubagentBackup(
        makeCtx("Bash", { command: "curl -X POST https://api.example.com" }),
        actionDir,
        config
      );
      assert.equal(artifact, null);
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});

// ── runBackup integration with subagent ──────────────────────────────

describe("subagent: runBackup wires subagent into tier-3", () => {
  beforeEach(() => resetAction());

  it("uses subagent for outside-workspace action when enabled", () => {
    installMockClaude(JSON.stringify({
      description: "captured docker state",
      backup_commands: ["docker ps > /tmp/state.txt"],
      recovery_commands: ["docker restart myservice"],
    }));

    const { workspace, config, originalCwd } = setup();
    try {
      // docker run matches outside-workspace but has no targeted pattern
      const result = runBackup(
        makeCtx("Bash", { command: "docker run ubuntu" }),
        config
      );

      // Should have a subagent artifact
      const subagentArtifact = result.artifacts.find((a) => a.strategy === "subagent");
      assert.ok(subagentArtifact, `Expected subagent artifact, got: ${JSON.stringify(result.artifacts.map((a) => a.strategy))}`);
      assert.deepEqual(subagentArtifact!.subagentCommands, ["docker restart myservice"]);
      // needsSubagent should be false because subagent succeeded
      assert.equal(result.needsSubagent, false);
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("falls back to needsSubagent=true when mock subagent fails", () => {
    installBrokenMockClaude();

    const { workspace, config, originalCwd } = setup();
    try {
      const result = runBackup(
        makeCtx("Bash", { command: "docker run ubuntu" }),
        config
      );
      // No subagent artifact should be present
      const sub = result.artifacts.find((a) => a.strategy === "subagent");
      assert.equal(sub, undefined);
      // Fallback: needsSubagent flag set
      assert.equal(result.needsSubagent, true);
      assert.ok(result.subagentReason);
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});

// ── Restore subagent artifacts ───────────────────────────────────────

describe("subagent: restore executes recovery commands", () => {
  it("executes each command in subagentCommands sequentially", () => {
    const tmpFile = path.join(os.tmpdir(), `chats-sub-marker-${Date.now()}.txt`);
    const artifact: BackupArtifact = {
      id: "test1",
      timestamp: new Date().toISOString(),
      trigger: "rule",
      toolName: "Bash",
      description: "test backup",
      strategy: "subagent",
      artifactPath: "/nonexistent",
      subagentCommands: [
        `echo hello > "${tmpFile}"`,
        `echo world >> "${tmpFile}"`,
      ],
    };

    try {
      const r = restoreArtifact(artifact);
      assert.equal(r.success, true, `Expected success, got: ${r.description}`);
      assert.ok(fs.existsSync(tmpFile));
      const content = fs.readFileSync(tmpFile, "utf-8");
      assert.ok(content.includes("hello"));
      assert.ok(content.includes("world"));
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* */ }
    }
  });

  it("stops on first failing command and reports partial execution", () => {
    const artifact: BackupArtifact = {
      id: "test2",
      timestamp: new Date().toISOString(),
      trigger: "rule",
      toolName: "Bash",
      description: "test",
      strategy: "subagent",
      artifactPath: "/nonexistent",
      subagentCommands: [
        "true",               // succeeds
        "false",              // fails
        "echo should-not-run", // should not execute
      ],
    };

    const r = restoreArtifact(artifact);
    assert.equal(r.success, false);
    assert.ok(r.description.includes("1/3") || r.description.includes("partially"));
  });

  it("falls back to subagent prompt when no commands recorded", () => {
    const artifact: BackupArtifact = {
      id: "test3",
      timestamp: new Date().toISOString(),
      trigger: "rule",
      toolName: "Bash",
      description: "no commands",
      strategy: "subagent",
      artifactPath: "/nonexistent",
    };

    const r = restoreArtifact(artifact);
    assert.equal(r.success, true);
    assert.ok(r.subagentPrompt);
  });
});

// ── Recursion guard test (env var check) ─────────────────────────────

describe("subagent: recursion guard env var", () => {
  it("CHATS_SANDBOX_NO_HOOK=1 is set in subprocess env", () => {
    // We can't directly inspect the subprocess env, but we verify that
    // runSubagentBackup sets it by using a mock claude that echoes it.
    const script = `#!/bin/sh
cat > /dev/null
if [ "$CHATS_SANDBOX_NO_HOOK" = "1" ]; then
  echo '{"description":"guard ok","backup_commands":[],"recovery_commands":["true"]}'
else
  echo '{"description":"GUARD MISSING","backup_commands":[],"recovery_commands":[]}'
fi
`;
    fs.writeFileSync(MOCK_CLAUDE, script);
    fs.chmodSync(MOCK_CLAUDE, 0o755);

    const { workspace, config, originalCwd } = setup();
    try {
      const actionDir = path.join(config.backupDir, "action_test");
      fs.mkdirSync(actionDir, { recursive: true });

      const artifact = runSubagentBackup(
        makeCtx("Bash", { command: "docker run ubuntu" }),
        actionDir,
        config
      );
      assert.ok(artifact);
      assert.ok(artifact!.description.includes("guard ok"),
        `Expected guard ok, got: ${artifact!.description}`);
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});
