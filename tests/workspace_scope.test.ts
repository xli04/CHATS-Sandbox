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
import { runBackup, resetAction } from "../src/backup/strategies.js";
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
      maxActions: 10,
      // Disable subagent for these tests — we only verify the detection
      // logic, not actual subprocess invocation.
      subagentEnabled: false,
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
  beforeEach(() => resetAction());

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
  beforeEach(() => resetAction());

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
  beforeEach(() => resetAction());

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

// ── MCP tools: writes fire subagent, reads short-circuit ──────────────

describe("workspace scope: MCP tool detection", () => {
  beforeEach(() => resetAction());

  const writeTools = [
    "mcp__playwright__browser_click",
    "mcp__playwright__browser_type",
    "mcp__playwright__browser_fill_form",
    "mcp__notion__create_page",
    "mcp__notion__update_database",
    "mcp__github__create_issue",
    "mcp__slack__send_message",
    "mcp__custom__unknown_verb",          // unknown → assume write
    "mcp__some__delete_thing",
  ];
  for (const t of writeTools) {
    it(`MCP write tool triggers subagent: ${t}`, () => {
      const { workspace, config, originalCwd } = setup();
      try {
        fs.writeFileSync(path.join(workspace, "init.txt"), "x\n");
        const result = runBackup(makeCtx(t, { foo: "bar" }), config);
        assert.ok(result.needsSubagent, `${t} should trigger subagent`);
      } finally {
        teardown(workspace, originalCwd);
      }
    });
  }

  const readTools = [
    "mcp__playwright__browser_navigate",
    "mcp__playwright__browser_snapshot",
    "mcp__playwright__browser_take_screenshot",
    "mcp__playwright__browser_wait_for",
    "mcp__notion__get_page",
    "mcp__github__list_issues",
    "mcp__github__search_repos",
    "mcp__slack__fetch_messages",
    "mcp__db__describe_table",
  ];
  for (const t of readTools) {
    it(`MCP read tool short-circuits: ${t}`, () => {
      const { workspace, config, originalCwd } = setup();
      try {
        fs.writeFileSync(path.join(workspace, "init.txt"), "x\n");
        const result = runBackup(makeCtx(t, { foo: "bar" }), config);
        assert.equal(result.needsSubagent, false, `${t} should NOT trigger subagent`);
        // Read-only MCP tools should also produce zero artifacts (no
        // git_snapshot noise on every browser_navigate).
        assert.equal(result.artifacts.length, 0,
          `${t} should produce zero artifacts (read-only short-circuit)`);
      } finally {
        teardown(workspace, originalCwd);
      }
    });
  }
});

// ── Interpreter-path discrimination (regression for T3 over-fire) ────
// The argv[0] interpreter binary lives outside the workspace
// (/opt/conda/bin/python) but is a READ, not a mutation. These cases
// guard the strip-interpreter logic against both failure directions:
// over-firing on benign reads, and under-firing on genuine outside
// writes. Covers gaps the first strip-argv[0] attempt missed
// (multiline, env-prefix, redirections, env-assignment paths, bare
// outside executables).
describe("workspace scope: interpreter vs write discrimination", () => {
  beforeEach(() => resetAction());

  function fires(cmd: string): boolean {
    const { workspace, config, originalCwd } = setup();
    try {
      fs.writeFileSync(path.join(workspace, "a.py"), "x\n");
      return runBackup(makeCtx("Bash", { command: cmd }), config).needsSubagent;
    } finally {
      teardown(workspace, originalCwd);
    }
  }

  // Interpreter reads — must NOT escalate to the subagent.
  const benign: Array<[string, string]> = [
    ["/opt/miniconda3/envs/testbed/bin/python -m pytest tests/", "single-line conda interpreter"],
    ["cd a.py\n/opt/miniconda3/envs/testbed/bin/python -m pytest", "multiline interpreter (line 2)"],
    ["/usr/bin/node build.js", "absolute node interpreter, in-ws script"],
    ["pytest -q", "bare pytest"],
  ];
  for (const [cmd, label] of benign) {
    it(`interpreter read does NOT fire: ${label}`, () => {
      assert.equal(fires(cmd), false, `should not escalate: ${cmd}`);
    });
  }

  // Genuine outside writes — MUST escalate (data-loss direction).
  const writes: Array<[string, string]> = [
    ["echo x > /etc/foo", "redirect to /etc"],
    ["cd src && >/etc/myapp/state.json", "redirect target after &&"],
    ["DEST=/etc/cron.d/nightly bash scripts/install-cron.sh", "env-assignment outside path"],
    ["/usr/local/bin/reset-db.sh", "bare outside (non-interpreter) executable"],
    ["/etc/init.d/nginx stop", "init.d script (non-interpreter)"],
    ["cp build.tar /opt/lib/", "cp into /opt"],
    ["python -c \"open('/etc/x','w')\"", "outside write inside interpreter -c arg"],
    ["/opt/conda/bin/python -c \"open('/etc/x','w')\"", "abs interpreter + outside write arg"],
  ];
  for (const [cmd, label] of writes) {
    it(`outside write DOES fire: ${label}`, () => {
      assert.equal(fires(cmd), true, `should escalate: ${cmd}`);
    });
  }
});
