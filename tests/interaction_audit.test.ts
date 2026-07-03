/**
 * INTERACTION-DESIGN AUDIT tests — exercises the feedback surfaces that
 * carry backup/restore outcomes to (a) the human user and (b) the agent.
 *
 * These tests CONFIRM behaviors found during the audit, including a few
 * that are documented here as design gaps (marked GAP in the test name):
 * they assert the CURRENT behavior so the gap is pinned down and visible,
 * not because the behavior is desirable.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { runSubagentBackup } from "../src/backup/subagent.js";
import { restoreArtifact } from "../src/restore/restore.js";
import { pendingRecoveryNotice } from "../src/hooks/recovery-notice.js";
import { DEFAULT_CONFIG, type BackupArtifact, type HookContext, type SandboxConfig } from "../src/types.js";

// Compiled to dist-test/tests/ → repo root is two levels up.
const REPO = path.resolve(__dirname, "..", "..");
const PRE_TOOL = path.join(REPO, "dist", "hooks", "pre-tool.js");

// ── Mock runner bin dir (subagent.test.ts pattern) ───────────────────
const MOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chats-audit-mock-"));
let originalPath = "";

function installMockCodex(responseJson: string): void {
  const responseFile = path.join(MOCK_DIR, "codex-response.txt");
  fs.writeFileSync(responseFile, responseJson, "utf-8");
  fs.writeFileSync(path.join(MOCK_DIR, "codex"), `#!/bin/sh
cat > /dev/null
cat "${responseFile}"
`);
  fs.chmodSync(path.join(MOCK_DIR, "codex"), 0o755);
}

/** A codex that never answers — for the timeout-attribution test. */
function installHangingMockCodex(): void {
  fs.writeFileSync(path.join(MOCK_DIR, "codex"), `#!/bin/sh
cat > /dev/null
sleep 120
`);
  fs.chmodSync(path.join(MOCK_DIR, "codex"), 0o755);
}

before(() => {
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${MOCK_DIR}:${originalPath}`;
});
after(() => {
  process.env.PATH = originalPath;
  try { fs.rmSync(MOCK_DIR, { recursive: true, force: true }); } catch { /* */ }
});

function makeWorkspace(configOverrides: Record<string, unknown> = {}): { ws: string; config: SandboxConfig } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "chats-audit-ws-"));
  fs.mkdirSync(path.join(ws, ".chats-sandbox"), { recursive: true });
  const cfg = {
    enabled: true,
    backupMode: "smart",
    backupDir: path.join(ws, ".chats-sandbox", "backups"),
    subagentEnabled: false,
    ...configOverrides,
  };
  fs.writeFileSync(path.join(ws, ".chats-sandbox", "config.json"), JSON.stringify(cfg));
  const config: SandboxConfig = { ...DEFAULT_CONFIG, ...(cfg as Partial<SandboxConfig>) };
  return { ws, config };
}

function runPreTool(ws: string, payload: unknown, env: Record<string, string> = {}): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [PRE_TOOL], {
    cwd: ws,
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

function makeCtx(toolName: string, toolInput: Record<string, unknown>): HookContext {
  return { hook_event: "PreToolUse", tool_name: toolName, tool_input: toolInput };
}

// ── 1. Hook output shape per dialect ─────────────────────────────────

describe("hook output shapes: which agents can even receive backup feedback", () => {
  it("claude dialect: tier-0 rm rewrite returns additionalContext + updatedInput with an honest comment", () => {
    const { ws } = makeWorkspace();
    execFileSync("git", ["init", "-q"], { cwd: ws });
    fs.writeFileSync(path.join(ws, "f.txt"), "x");
    const r = runPreTool(ws, {
      hook_event: "PreToolUse", session_id: "s",
      tool_name: "Bash", tool_input: { command: "rm f.txt" },
    });
    const out = JSON.parse(r.stdout);
    assert.match(String(out.hookSpecificOutput.additionalContext), /soft-delete f\.txt to trash/);
    assert.match(String(out.hookSpecificOutput.updatedInput.command), /chats-sandbox: rm rewritten to trash/);
  });

  it("cursor dialect: same event uses top-level agent_message + updated_input", () => {
    const { ws } = makeWorkspace();
    execFileSync("git", ["init", "-q"], { cwd: ws });
    fs.writeFileSync(path.join(ws, "g.txt"), "x");
    const r = runPreTool(ws, {
      hook_event: "PreToolUse", conversation_id: "c1",
      tool_name: "Shell", tool_input: { command: "rm g.txt" },
    });
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, "allow");
    assert.match(String(out.agent_message), /soft-delete g\.txt to trash/);
    assert.ok(out.updated_input, "cursor gets snake_case updated_input");
  });

  it("openhands dialect: emits claude-shaped hookSpecificOutput (which the allow/deny-only SDK cannot inject as agent context)", () => {
    const { ws } = makeWorkspace();
    execFileSync("git", ["init", "-q"], { cwd: ws });
    execFileSync("git", ["-C", ws, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", ws, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(ws, "h.txt"), "x");
    const r = runPreTool(ws, {
      event_type: "PreToolUse",
      tool_name: "terminal", tool_input: { command: "rm h.txt" },
    }, { CHATS_SANDBOX_NO_REWRITE: "1" });
    const out = JSON.parse(r.stdout);
    // The payload IS produced — but the OpenHands SDK's hook contract is
    // allow/deny only, so additionalContext never reaches the agent there.
    assert.ok(out.hookSpecificOutput.additionalContext, "context emitted (agent-side delivery depends on host)");
    assert.equal(out.hookSpecificOutput.updatedInput, undefined, "no rewrite under NO_REWRITE");
  });
});

// ── 2. UNVERIFIED honesty chain on the no-MCP (codex/openclaw) path ──

describe("no-MCP runner honesty chain (runner_caps)", () => {
  it("prose recovery from an MCP-less runner is downgraded: UNVERIFIED prefix + forced liveRestore", () => {
    const { ws, config } = makeWorkspace({ subagentEnabled: true, subagentRunner: "codex" });
    installMockCodex(JSON.stringify({
      description: "Recorded reversal for the DELETE",
      backup_commands: [], recovery_commands: ["INSERT INTO t VALUES (1)"],
      artifact_paths: [], live_restore: false,
    }));
    const dir = path.join(config.backupDir, "action_audit_prose");
    fs.mkdirSync(dir, { recursive: true });
    const prev = process.cwd(); process.chdir(ws);
    try {
      const out = runSubagentBackup(
        makeCtx("mcp__postgres__execute_sql", { sql: "DELETE FROM t WHERE id=1" }),
        dir, { ...config, subagentRunner: "codex" });
      assert.ok(out && out !== "read_only");
      const a = out as BackupArtifact;
      assert.match(a.description, /^Subagent backup: UNVERIFIED: no MCP access/);
      assert.equal(a.liveRestore, true, "restore must re-derive, not replay");
    } finally { process.chdir(prev); }
  });

  it("REGRESSION: recovery_mcp_calls from an MCP-less runner on a DESTRUCTIVE trigger are distrusted (UNVERIFIED + forced liveRestore)", () => {
    const { ws, config } = makeWorkspace({ subagentEnabled: true, subagentRunner: "codex" });
    // The mock "reverses" a DELETE by issuing the same DELETE. FIXED: the
    // exemption for recovery_mcp_calls now applies ONLY to a CONSTRUCTIVE
    // trigger; a DELETE trigger on an MCP-less runner cannot have derived a
    // real inverse, so it is distrusted like prose — forced liveRestore so
    // restore routes to a subagent instead of replaying the fabricated call.
    installMockCodex(JSON.stringify({
      description: "delete the row by pinned id",
      backup_commands: [], recovery_commands: [],
      recovery_mcp_calls: [{ tool: "execute_sql", args: { sql: "DELETE FROM t WHERE id=1" } }],
      artifact_paths: [], live_restore: false,
    }));
    const dir = path.join(config.backupDir, "action_audit_mcpcalls");
    fs.mkdirSync(dir, { recursive: true });
    const prev = process.cwd(); process.chdir(ws);
    try {
      const out = runSubagentBackup(
        makeCtx("mcp__postgres__execute_sql", { sql: "DELETE FROM t WHERE id=1" }),
        dir, { ...config, subagentRunner: "codex" });
      assert.ok(out && out !== "read_only");
      const a = out as BackupArtifact;
      assert.match(a.description, /UNVERIFIED/, "destructive-trigger fabrication marked UNVERIFIED");
      assert.equal(a.liveRestore, true, "forced live_restore → restore re-derives, no blind replay");
      // Schema-name bypass guard: a destructive statement whose table/column/
      // literal contains a constructive word (new/add/send) must STILL be
      // distrusted — the detector keys on the action verb, not free-text args.
      for (const sql of ["DELETE FROM new_orders WHERE id=1",
                         "UPDATE t SET note='please add later' WHERE id=1",
                         "DELETE FROM t WHERE msg='send report'"]) {
        const d2 = path.join(config.backupDir, "a_" + Math.random().toString(36).slice(2));
        fs.mkdirSync(d2, { recursive: true });
        const o2 = runSubagentBackup(makeCtx("mcp__postgres__execute_sql", { sql }),
          d2, { ...config, subagentRunner: "codex" }) as BackupArtifact;
        assert.match(o2.description, /UNVERIFIED/, `bypass must be distrusted: ${sql}`);
        assert.equal(o2.liveRestore, true, sql);
      }
    } finally { process.chdir(prev); }
  });

  it("REGRESSION: recovery_mcp_calls on a CONSTRUCTIVE trigger stay trusted (deterministic create-inverse replay preserved)", () => {
    const { ws, config } = makeWorkspace({ subagentEnabled: true, subagentRunner: "codex" });
    installMockCodex(JSON.stringify({
      description: "delete the created row by pinned id",
      backup_commands: [], recovery_commands: [],
      recovery_mcp_calls: [{ tool: "execute_sql", args: { sql: "DELETE FROM t WHERE id=99" } }],
      artifact_paths: [], live_restore: false,
    }));
    const dir = path.join(config.backupDir, "action_audit_mcpcalls_create");
    fs.mkdirSync(dir, { recursive: true });
    const prev = process.cwd(); process.chdir(ws);
    try {
      const out = runSubagentBackup(
        makeCtx("mcp__postgres__insert_row", { table: "t", id: 99 }),
        dir, { ...config, subagentRunner: "codex" });
      assert.ok(out && out !== "read_only");
      const a = out as BackupArtifact;
      assert.doesNotMatch(a.description, /UNVERIFIED/, "constructive inverse stays trusted");
      assert.equal(a.liveRestore, false, "deterministic replay preserved");
      assert.equal(a.recoveryMcpCalls?.length, 1);
    } finally { process.chdir(prev); }
  });

  it("GAP: a hung subagent overruns the configured timeout by the +10s margin and surfaces as a raw spawnSync error, not a clear 'backup timed out'", () => {
    // A runner whose process tree survives the watcher's SIGTERM (here:
    // sh → sleep, mirroring real runners that spawn helpers) keeps the
    // inherited stdio pipes open, so execFileSync blocks past the
    // watcher deadline until its own timeoutMs+10s margin, then throws
    // ETIMEDOUT. The user's only signals are tellUser "Subagent failed
    // after 20.0s: spawnSync /usr/bin/node ETIMEDOUT" (internal jargon,
    // and 2x the configured 10s) — never "the backup subagent hit its
    // configured timeout". When the tree DOES die on SIGTERM, the
    // watcher exits 0 and the failure is instead reported as
    // "unparseable output — backup skipped", equally timeout-blind.
    const { ws, config } = makeWorkspace({
      subagentEnabled: true, subagentRunner: "codex", subagentTimeoutSeconds: 10,
    });
    installHangingMockCodex();
    const dir = path.join(config.backupDir, "action_audit_timeout");
    fs.mkdirSync(dir, { recursive: true });
    const prev = process.cwd(); process.chdir(ws);
    const started = Date.now();
    try {
      const out = runSubagentBackup(
        makeCtx("mcp__postgres__execute_sql", { sql: "DELETE FROM t WHERE id=1" }),
        dir, { ...config, subagentRunner: "codex", subagentTimeoutSeconds: 10 });
      assert.equal(out, null, "timed-out backup yields no artifact");
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 19_000, `blocked ${elapsed}ms — configured 10s + 10s margin`);
      const log = fs.readFileSync(
        path.join(path.dirname(path.resolve(config.backupDir)), "subagent.log"), "utf-8");
      assert.match(log, /FAILED: spawnSync .*ETIMEDOUT/);
      assert.doesNotMatch(log, /backup.*timed out|subagent.*timed out/i);
    } finally { process.chdir(prev); }
  });
});

// ── 3. Restore feedback ──────────────────────────────────────────────

describe("restore result honesty", () => {
  it("GAP: env_snapshot restore reports success:true while restoring nothing (prints instructions instead)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chats-audit-env-"));
    const envFile = path.join(tmp, "env.txt");
    fs.writeFileSync(envFile, "FOO=bar\n");
    const artifact: BackupArtifact = {
      id: "x", timestamp: new Date().toISOString(), trigger: "rule",
      toolName: "Bash", description: "env snapshot", strategy: "env_snapshot",
      artifactPath: envFile,
    };
    const r = await restoreArtifact(artifact);
    assert.equal(r.success, true, "current behavior: success without action");
    assert.match(r.description, /To restore:/);
  });

  it("GAP: recovery notice mislabels result-line count as 'file(s) restored' (headers and prune lines counted)", () => {
    const { ws, config } = makeWorkspace();
    void ws;
    // Simulate what logRestoreOp writes for a loop restore that touched 2
    // files: 5 result entries (2 headers + 2 restores + 1 prune) → ok:5.
    const ledger = path.join(path.dirname(path.resolve(config.backupDir)), "restore-history.jsonl");
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, JSON.stringify({
      ts: new Date().toISOString(), mode: "loop", action: "action_002_x",
      seq: 2, steps: 5, ok: 5, failed: 0,
    }) + "\n");
    const notice = pendingRecoveryNotice(config);
    assert.ok(notice);
    assert.match(notice!, /5 file\(s\) restored/, "reports 5 'files' though ok counts result LINES");
  });
});
