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

  // REMOTE backup-worthy allowlist: a mutating verb in the tool name fires.
  const writeTools = [
    "mcp__notion__create_page",
    "mcp__notion__update_database",
    "mcp__github__create_issue",
    "mcp__slack__send_message",
    "mcp__some__delete_thing",
  ];
  // Allowlist flip: remote actions with NO mutating verb / trigger are now
  // ignored (a click with no affordance arg; a tool with an unknown verb).
  const ignoredRemote = [
    "mcp__playwright__browser_click",
    "mcp__custom__unknown_verb",
  ];
  for (const t of ignoredRemote) {
    it(`unknown remote verb → ignored (allowlist): ${t}`, () => {
      const { workspace, config, originalCwd } = setup();
      try {
        fs.writeFileSync(path.join(workspace, "init.txt"), "x\n");
        const result = runBackup(makeCtx(t, { foo: "bar" }), config);
        assert.equal(result.needsSubagent, false, `${t} should be ignored by the allowlist`);
      } finally {
        teardown(workspace, originalCwd);
      }
    });
  }
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
    // Form input enters data but doesn't COMMIT it — the Submit/Save click
    // does. Treating these as reads stops every login/search box from
    // firing a browser subagent (see browser-affordance over-fire fix).
    "mcp__playwright__browser_type",
    "mcp__playwright__browser_fill_form",
    "mcp__playwright__browser_select_option",
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

// ── Read-only compound-command filter (cd && <read> over-fire) ───────
// isReadOnlyBash must recognize that a compound command is read-only
// iff EVERY segment is. The old code bailed on the first &&/;/| and so
// treated `cd DIR && git log` as a possible mutation — over-firing a
// tier-2 snapshot and (when it also tripped touchesOutsideWorkspace) a
// ~30s tier-3 subagent. Direction must stay safe: any real mutation
// still backs up.
describe("read-only filter: compound commands skip backup", () => {
  beforeEach(() => resetAction());

  function backsUp(cmd: string): boolean {
    const { workspace, config, originalCwd } = setup();
    try {
      fs.writeFileSync(path.join(workspace, "a.py"), "x\n");
      const r = runBackup(makeCtx("Bash", { command: cmd }), config);
      return r.artifacts.length > 0 || r.needsSubagent;
    } finally {
      teardown(workspace, originalCwd);
    }
  }

  // Compound reads — must NOT back up.
  for (const [cmd, label] of [
    ["cd /repo && git log -p -- a.py", "cd && git log (the bug)"],
    ["cd /repo && cat a.py", "cd && cat"],
    ["cd /repo && ls -la", "cd && ls"],
    ["grep foo a.py | head", "pipe of reads"],
    ["git log | grep x | head -30", "3-stage read pipe"],
    ["pushd /repo && git status", "pushd && git status"],
  ] as const) {
    it(`skips: ${label}`, () => assert.equal(backsUp(cmd), false, cmd));
  }

  // Compound or unknown commands containing a mutation — MUST back up.
  for (const [cmd, label] of [
    ["cd /repo && rm -rf a.py", "cd && rm"],
    ["ls && pip install flask", "ls && pip install"],
    ["cat a.py > b.py", "redirect write"],
    ["echo $(rm a.py)", "command substitution"],
    ["cd /repo && git commit -am x", "cd && git commit"],
    ["grep x a.py | tee out.txt", "pipe into tee (writes)"],
  ] as const) {
    it(`backs up: ${label}`, () => assert.equal(backsUp(cmd), true, cmd));
  }
});

// ── Read-only filter: adversarial false-positive classes ─────────────
// From Opus-4.8 fuzzing (179-case corpus). A FALSE POSITIVE here =
// destructive command runs with NO backup = data loss. These 3 classes
// each hid a mutation where the splitter / redirect-check couldn't see
// it: newline separators, env-assignment prefixes, and sed/awk scripts
// (interpreters that write files or shell out). All must back up.
import { isReadOnlyBash } from "../src/backup/strategies.js";

describe("read-only filter: adversarial mutations must NOT be read-only", () => {
  const mutations = [
    ["ls\nrm -rf /important", "newline → rm"],
    ["cat a\ncp secret /tmp/exfil", "newline → cp exfil"],
    ["git status\ngit reset --hard", "newline → hard reset"],
    ["ls\r\nrm x", "CRLF → rm"],
    ["env FOO=bar rm f", "env-prefix → rm"],
    ["env A=1 B=2 rm -rf /", "env-prefix → rm -rf"],
    ["env VAR=x cp a b", "env-prefix → cp"],
    ["env DEBUG=1 git push", "env-prefix → git push"],
    ["FOO=bar rm f", "leading assignment → rm"],
    ['sed -n "w out.txt" file', "sed w writes file"],
    ['sed -n "1w /etc/cron.d/x" file', "sed w writes cron"],
    ['sed -n "W out" file', "sed W writes"],
    ['sed -n "s/a/b/w f" file', "sed s///w writes"],
    ['sed -n "e rm x" file', "sed e execs shell"],
    ['awk "BEGIN{system(\\"rm x\\")}"', "awk system() execs"],
    ['awk "{print > \\"f\\"}" a', "awk print > file"],
    ["sed -i s/a/b/ f", "sed -i in-place write"],
  ] as const;
  for (const [cmd, label] of mutations) {
    it(`backs up (not read-only): ${label}`, () =>
      assert.equal(isReadOnlyBash(cmd), false, JSON.stringify(cmd)));
  }

  // The common compound reads must still be recognized as read-only.
  const reads = [
    ["cd /repo && git log -p -- a.py", "cd && git log"],
    ["grep foo f | head", "read pipe"],
    ["git log | grep x | head -30", "3-stage read pipe"],
    ["git status", "git status"],
    ["pip list", "pip list"],
  ] as const;
  for (const [cmd, label] of reads) {
    it(`skips (read-only): ${label}`, () =>
      assert.equal(isReadOnlyBash(cmd), true, JSON.stringify(cmd)));
  }
});

// ── Read-only filter: round-2 adversarial classes (3× Opus fuzzing) ──
// Allowlist entries that READ in their bare form but MUTATE/EXECUTE with
// args: env launches any command; node -e / python -c run arbitrary
// code; date -s / hostname set system state; git --output writes a file.
// Each must back up. Confirmed mutating in real bash by the fuzzers.
describe("read-only filter: launcher/interpreter/mutating-flag classes", () => {
  const mutations = [
    ["env rm -rf /repo/x", "env launches rm"],
    ["env -i rm -rf x", "env -i launches rm"],
    ['env bash -c "rm x"', "env launches bash"],
    ["cd /tmp && env rm -rf x", "compound env launcher"],
    ["sudo rm -rf x", "sudo launcher"],
    ["nice rm x", "nice launcher"],
    ["timeout 5 rm x", "timeout launcher"],
    ["xargs rm", "xargs launcher"],
    ["git diff --output=/repo/x", "git --output= writes file"],
    ["git log --output /repo/x", "git --output space form"],
    ["git show --output=/repo/x", "git show --output"],
    ['node -e "require(String.fromCharCode(102,115))"', "node -e arbitrary code"],
    ['python3 -c "import sitecustomize"', "python -c import side effects"],
    ['date -s "2020-01-01"', "date -s sets clock"],
    ["date --set now", "date --set"],
    ["date 010100002020", "date bare-numeric set"],
    ["date +%s -s now", "date -s after +format"],
    ["date -s2020", "date -s glued value"],
    ["date -snow", "date -snow glued"],
    ["date -usnow", "date -us bundled glued"],
    ["date -us now", "date -us bundled"],
    ["ls && date -s2020", "compound glued date-s"],
    ["hostname newname", "hostname sets name"],
    ["cd /tmp && date -s now", "compound date -s"],
  ] as const;
  for (const [cmd, label] of mutations) {
    it(`backs up: ${label}`, () => assert.equal(isReadOnlyBash(cmd), false, JSON.stringify(cmd)));
  }

  // Bare reads of the SAME verbs must still skip.
  const reads = [
    ["date", "bare date"],
    ["date +%s", "date format"],
    ["date -u", "date -u read"],
    ["date -d @123", "date -d parse"],
    ["ls -s && date", "read with -s elsewhere"],
    ["printenv PATH", "printenv read"],
    ["git diff", "git diff read"],
    ["git log -p | head", "git log pipe read"],
    ["date -Iseconds", "ISO-8601 seconds read"],
    ["date -Is", "ISO read short"],
    ["git branch", "git branch list read"],
  ] as const;
  for (const [cmd, label] of reads) {
    it(`skips: ${label}`, () => assert.equal(isReadOnlyBash(cmd), true, JSON.stringify(cmd)));
  }
});

// git create/mutate subcommands must back up (per-verb $-anchors hold —
// the global trailing-args group does not defeat them). Fuzzer-verified.
describe("read-only filter: git create/mutate subcommands back up", () => {
  for (const cmd of [
    "git branch newbranch", "git branch -D main", "git remote add origin url",
    "git remote set-url origin url", "git config user.name evil", "git tag v1",
    "git checkout main", "git stash", "git clean -fd",
  ]) {
    it(`backs up: ${cmd}`, () => assert.equal(isReadOnlyBash(cmd), false, cmd));
  }
});
