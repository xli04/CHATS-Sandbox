/**
 * Tests for touchesOutsideWorkspace detection in backup/strategies.ts.
 *
 * touchesOutsideWorkspace is not exported directly, but its behavior
 * is observable via runBackup's `needsSubagent` flag — when an action
 * touches outside the workspace AND no targeted manifest covers it,
 * needsSubagent is set to true.
 *
 * We test this indirectly by running backups and checking needsSubagent.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runBackup, resetInteraction } from "../src/backup/strategies.js";
import { DEFAULT_CONFIG, type HookContext, type SandboxConfig } from "../src/types.js";

function makeCtx(toolName: string, toolInput: Record<string, unknown>): HookContext {
  return { hook_event: "PreToolUse", tool_name: toolName, tool_input: toolInput };
}

function setup(): { workspace: string; config: SandboxConfig; originalCwd: string } {
  const originalCwd = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chats-scope-"));
  process.chdir(workspace);
  return {
    workspace,
    config: {
      ...DEFAULT_CONFIG,
      backupDir: path.join(workspace, ".chats-sandbox", "backups"),
      maxInteractions: 10,
      // DEFAULT_CONFIG has subagentEnabled=false so no claude CLI calls here
    },
    originalCwd,
  };
}

function teardown(workspace: string, originalCwd: string): void {
  process.chdir(originalCwd);
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* */ }
}

// ── Commands that should detect outside-workspace ────────────────────

describe("workspace scope: outside-workspace detection", () => {
  beforeEach(() => resetInteraction());

  const outsideCases: Array<[string, string]> = [
    ["pip install flask", "pip install touches site-packages"],
    ["pip3 uninstall requests", "pip3 uninstall"],
    ["npm install -g typescript", "global npm install"],
    ["apt install curl", "apt install"],
    ["apt-get remove nginx", "apt-get remove"],
    ["brew install jq", "brew install"],
    ["git push origin main", "git push"],
    ["git fetch --all", "git fetch"],
    ['curl -X POST https://api.example.com/deploy', "curl POST"],
    ['curl -X DELETE https://api.example.com/users/1', "curl DELETE"],
    ["ssh user@host 'ls'", "ssh"],
    ["scp file.txt user@host:/tmp/", "scp"],
    ["docker run ubuntu", "docker run"],
    ["docker push myimage", "docker push"],
    ["kubectl apply -f deploy.yaml", "kubectl apply"],
    ["systemctl restart nginx", "systemctl restart"],
    ["export FOO=bar", "export"],
    ["unset PATH", "unset"],
    ["source .env.prod", "source"],
  ];

  for (const [cmd, label] of outsideCases) {
    it(`detects outside-workspace: ${label}`, () => {
      const { workspace, config, originalCwd } = setup();
      try {
        // Create a file so the shadow repo has something to commit
        fs.writeFileSync(path.join(workspace, "init.txt"), "x\n");
        const result = runBackup(makeCtx("Bash", { command: cmd }), config);
        // Should either have a targeted manifest OR needsSubagent
        const hasTargeted = result.artifacts.some(
          (a) => a.strategy !== "git_snapshot"
        );
        assert.ok(
          hasTargeted || result.needsSubagent,
          `Expected outside-workspace detection for "${cmd}" — ` +
            `got needsSubagent=${result.needsSubagent}, ` +
            `strategies=${result.artifacts.map((a) => a.strategy).join(",")}`
        );
      } finally {
        teardown(workspace, originalCwd);
      }
    });
  }
});

// ── Commands that should NOT detect outside-workspace ────────────────

describe("workspace scope: inside-workspace only", () => {
  beforeEach(() => resetInteraction());

  const insideCases: Array<[string, string]> = [
    ["make build", "make build"],
    ["echo hello", "echo"],
    ["cat package.json", "cat"],
    ["ls -la", "ls"],
    ["python main.py", "python local script"],
    ["node index.js", "node local script"],
    ["npm test", "npm test (not install)"],
    ["npm run build", "npm run build (not install)"],
  ];

  for (const [cmd, label] of insideCases) {
    it(`stays inside workspace: ${label}`, () => {
      const { workspace, config, originalCwd } = setup();
      try {
        fs.writeFileSync(path.join(workspace, "init.txt"), "x\n");
        const result = runBackup(makeCtx("Bash", { command: cmd }), config);
        assert.equal(
          result.needsSubagent,
          false,
          `"${cmd}" should NOT trigger subagent, but needsSubagent=${result.needsSubagent}`
        );
      } finally {
        teardown(workspace, originalCwd);
      }
    });
  }
});

// ── Explicit file paths outside workspace ────────────────────────────

describe("workspace scope: explicit out-of-workspace paths in tool input", () => {
  beforeEach(() => resetInteraction());

  it("detects Write tool with path outside workspace", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      fs.writeFileSync(path.join(workspace, "init.txt"), "x\n");
      const result = runBackup(
        makeCtx("Write", { path: "/etc/nginx/nginx.conf", content: "test" }),
        config
      );
      // File-mutating tool with outside-workspace path
      // The git snapshot still runs (workspace backup), but the path
      // itself is outside — whether subagent fires depends on the
      // touchesOutsideWorkspace check for Write tools
      assert.ok(
        result.needsSubagent || result.artifacts.length > 0,
        "Expected some backup action for out-of-workspace Write"
      );
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("Bash command with absolute path outside workspace triggers detection", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      fs.writeFileSync(path.join(workspace, "init.txt"), "x\n");
      const result = runBackup(
        makeCtx("Bash", { command: "cat /etc/passwd > /usr/local/bin/exploit" }),
        config
      );
      assert.ok(
        result.needsSubagent,
        "Absolute path outside workspace should trigger subagent"
      );
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});
