/**
 * Tests for the restore engine (restore/restore.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { restoreArtifact } from "../src/restore/restore.js";
import { DEFAULT_CONFIG } from "../src/types.js";
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
  it("fails when backup file is missing", async () => {
    const r = await restoreArtifact(makeArtifact({
      strategy: "pip_freeze",
      artifactPath: "/tmp/nonexistent_pip_freeze.txt",
    }));
    assert.equal(r.success, false);
    assert.ok(r.description.includes("not found"));
  });
});

describe("restore - env_snapshot", () => {
  it("returns a restore command for env snapshots", async () => {
    const tmpFile = path.join(os.tmpdir(), `env_test_${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "FOO=bar\nBAZ=qux\n", "utf-8");

    const r = await restoreArtifact(makeArtifact({
      strategy: "env_snapshot",
      artifactPath: tmpFile,
    }));
    assert.equal(r.success, true);
    assert.ok(r.description.includes("source"), "Should provide a source command");

    fs.unlinkSync(tmpFile);
  });

  it("fails when env file is missing", async () => {
    const r = await restoreArtifact(makeArtifact({
      strategy: "env_snapshot",
      artifactPath: "/tmp/nonexistent_env.txt",
    }));
    assert.equal(r.success, false);
  });
});

describe("restore - git_tag", () => {
  it("fails when tag does not exist", async () => {
    const r = await restoreArtifact(makeArtifact({
      strategy: "git_tag",
      artifactPath: "chats-sandbox/nonexistent-tag-999",
    }));
    assert.equal(r.success, false);
    assert.ok(r.description.includes("not found"));
  });
});

describe("restore - git_snapshot", () => {
  it("fails when shadow repo is missing", async () => {
    const r = await restoreArtifact(makeArtifact({
      strategy: "git_snapshot",
      artifactPath: "/tmp/nonexistent_shadow_repo",
    }));
    assert.equal(r.success, false);
    assert.ok(r.description.includes("not found"));
  });

  it("verifies commit exists by querying with GIT_DIR (not cwd)", async () => {
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
      const r = await restoreArtifact(makeArtifact({
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
  it("returns a subagent prompt", async () => {
    // subagent restore now EXECUTES the recovery commands deterministically.
    // Use a safe, always-succeeding command so the test is hermetic.
    const r = await restoreArtifact(makeArtifact({
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

  it("returns failure when a recovery command fails", async () => {
    const r = await restoreArtifact(makeArtifact({
      strategy: "subagent",
      description: "backup",
      subagentCommands: ["false"],  // POSIX 'false' always exits non-zero
      originalAction: "test action",
    }));
    assert.equal(r.success, false);
    assert.ok(r.description.toLowerCase().includes("fail"),
      `Expected failure description, got: ${r.description}`);
  });

  it("handles missing subagentCommands gracefully", async () => {
    const r = await restoreArtifact(makeArtifact({
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
  it("fails for unknown strategy", async () => {
    const r = await restoreArtifact(makeArtifact({
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
  it("reverts all edits when one action holds multiple snapshots", async () => {
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

      await restoreActionLoop(acts[0], cfg);
      assert.equal(fs.readFileSync("tests.py", "utf-8").trim(), "TESTS-orig", "tests.py must revert");
      assert.equal(fs.readFileSync("a.py", "utf-8").trim(), "A-orig", "a.py must revert");
    } finally {
      process.chdir(cwd0);
      fs.rmSync(W, { recursive: true, force: true });
    }
  });
});

// Restore must reach a remote system ONLY through the MCP — a deterministic
// (liveRestore=false) artifact carrying recoveryMcpCalls is REPLAYED via
// tools/call against the action's STDIO server. No psql/curl/binary, and no
// connection-string scraping. (See restoreSubagent's recoveryMcpCalls branch.)
describe("restore - deterministic MCP replay (recoveryMcpCalls)", () => {
  // A minimal STDIO MCP server: speaks just enough JSON-RPC for callMcpTool
  // (initialize id:1 → tools/call id:3) and records the arguments it was
  // called with to a marker file, proving the replay went through the MCP.
  function writeMockMcpServer(scriptPath: string, markerPath: string): void {
    const src = `
const fs = require("fs");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mock", version: "1" } } }) + "\\n");
    } else if (m.id === 3) {
      fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(m.params));
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "ok" }] } }) + "\\n");
    }
  }
});
`;
    fs.writeFileSync(scriptPath, src, "utf-8");
  }

  function mcpConfig(workspace: string, server: string, scriptPath: string): string {
    const cfgPath = path.join(workspace, "mcp-config.json");
    fs.writeFileSync(cfgPath, JSON.stringify({
      mcpServers: { [server]: { command: process.execPath, args: [scriptPath] } },
    }), "utf-8");
    return cfgPath;
  }

  it("replays a deterministic artifact via the MCP (no binary, no SQL shell-out)", async () => {
    const W = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-replay-"));
    try {
      const script = path.join(W, "mock_mcp.js");
      const marker = path.join(W, "called.json");
      writeMockMcpServer(script, marker);
      const cfg = { ...DEFAULT_CONFIG, subagentMcpConfig: mcpConfig(W, "mydb", script) } as SandboxConfig;

      const r = await restoreArtifact(makeArtifact({
        strategy: "subagent",
        toolName: "mcp__mydb__execute_sql",
        description: "delete reversal",
        liveRestore: false,
        recoveryMcpCalls: [{ tool: "execute_sql", args: { sql: "INSERT INTO t VALUES (1)" } }],
      }), cfg);

      assert.equal(r.success, true, `expected MCP replay success, got: ${r.description}`);
      assert.ok(r.description.includes("MCP call"), `expected MCP-replay description, got: ${r.description}`);
      // The tool call actually reached the MCP server with our args.
      assert.ok(fs.existsSync(marker), "MCP server should have been invoked via tools/call");
      const called = JSON.parse(fs.readFileSync(marker, "utf-8"));
      assert.equal(called.name, "execute_sql");
      assert.equal(called.arguments.sql, "INSERT INTO t VALUES (1)");
    } finally {
      fs.rmSync(W, { recursive: true, force: true });
    }
  });

  it("reports failure (keeps backup) when the MCP tool call errors", async () => {
    const W = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-replay-err-"));
    try {
      // A server script that returns isError:true for the tool call.
      const script = path.join(W, "mock_err.js");
      fs.writeFileSync(script, `
let buf="";process.stdin.on("data",d=>{buf+=d;let i;while((i=buf.indexOf("\\n"))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);let m;try{m=JSON.parse(l)}catch{continue}
if(m.id===1)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{protocolVersion:"2024-11-05",capabilities:{}}})+"\\n");
else if(m.id===3)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:3,result:{isError:true,content:[{type:"text",text:"boom"}]}})+"\\n");}});
`, "utf-8");
      const cfg = { ...DEFAULT_CONFIG, subagentMcpConfig: mcpConfig(W, "mydb", script) } as SandboxConfig;

      const r = await restoreArtifact(makeArtifact({
        strategy: "subagent",
        toolName: "mcp__mydb__execute_sql",
        liveRestore: false,
        recoveryMcpCalls: [{ tool: "execute_sql", args: { sql: "BAD" } }],
      }), cfg);

      assert.equal(r.success, false);
      assert.ok(/MCP replay|failed/i.test(r.description), `got: ${r.description}`);
    } finally {
      fs.rmSync(W, { recursive: true, force: true });
    }
  });

  it("routes to the restore subagent (never a binary) when the server is unresolved", async () => {
    // No config / no mcp-config: resolveServerDef returns null, so the
    // deterministic replay must NOT shell out — it routes to the subagent.
    // With config undefined, that path returns success:false + a prompt.
    const r = await restoreArtifact(makeArtifact({
      strategy: "subagent",
      toolName: "mcp__mydb__execute_sql",
      liveRestore: false,
      recoveryMcpCalls: [{ tool: "execute_sql", args: { sql: "INSERT INTO t VALUES (1)" } }],
    }));
    assert.equal(r.success, false);
    assert.ok(r.subagentPrompt, "unresolved server must defer to the restore subagent");
  });

  it("dispatches an HTTP server in-process via callMcpToolHttp (not the subagent)", async () => {
    const W = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-http-"));
    try {
      const cfgPath = path.join(W, "mcp-config.json");
      fs.writeFileSync(cfgPath, JSON.stringify({
        mcpServers: { web: { url: "http://127.0.0.1:9/never" } },
      }), "utf-8");
      // resolveServerDef returns an HTTP def for "web". We now DO dispatch
      // HTTP tools/call ourselves via callMcpToolHttp — no subagent. The
      // endpoint is dead, so the in-process replay fails with a network error.
      // Assert it took the replay path (NOT routed to a subagent prompt).
      const cfg = {
        ...DEFAULT_CONFIG, subagentMcpConfig: cfgPath,
        subagentRunner: "codex", subagentTimeoutSeconds: 5,
      } as SandboxConfig;
      const r = await restoreArtifact(makeArtifact({
        strategy: "subagent",
        toolName: "mcp__web__do_thing",
        liveRestore: false,
        recoveryMcpCalls: [{ server: "web", tool: "do_thing", args: { x: 1 } }],
      }), cfg);
      // Dispatched in-process: failed because the endpoint is dead, NOT
      // deferred to a subagent prompt.
      assert.equal(r.success, false);
      assert.equal(r.subagentPrompt, undefined, `HTTP must be dispatched in-process, not routed to subagent: ${r.description}`);
      assert.ok(/MCP replay|failed/i.test(r.description), `expected an in-process replay failure, got: ${r.description}`);
    } finally {
      fs.rmSync(W, { recursive: true, force: true });
    }
  });
});

// A legacy artifact (no recoveryMcpCalls) whose action is REMOTE (its
// toolName resolves to an MCP server) must route to the restore subagent —
// its raw recovery_commands are prose for an agent, never fed to /bin/sh or
// a DB binary.
describe("restore - legacy remote raw-string recovery routes to subagent", () => {
  it("does not run a binary for a remote legacy recovery", async () => {
    const r = await restoreArtifact(makeArtifact({
      strategy: "subagent",
      toolName: "mcp__mydb__execute_sql",
      liveRestore: false,
      subagentCommands: ["INSERT INTO t VALUES (1)"], // prose-ish, NOT shell
    }));
    // config undefined → subagent path returns success:false with a prompt,
    // proving we routed to the agent rather than executing the string.
    assert.equal(r.success, false);
    assert.ok(r.subagentPrompt, "remote legacy recovery must defer to the restore subagent");
  });
});
