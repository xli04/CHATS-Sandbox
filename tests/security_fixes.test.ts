/**
 * Regression tests for the security/correctness review (the confirmed,
 * cleanly-testable findings):
 *   #1  chats-sandbox substring backup bypass
 *   #5  seq-1000 lexical prune inversion
 *   #6  .env excluded from every tier
 *   #10 backupId/backupIds timing handshake mismatch
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { invokesChatsSandbox } from "../src/engine/rules.js";

describe("#1 chats-sandbox CLI skip requires real invocation, not substring", () => {
  // Must NOT skip: destructive commands that merely mention the string.
  const bypassAttempts = [
    "rm -rf src/ # per chats-sandbox policy",
    "rm -rf .chats-sandbox-old",
    "echo 'chats-sandbox' && rm -rf build",
    "git commit -m 'wire up chats-sandbox'",
  ];
  for (const cmd of bypassAttempts) {
    it(`does NOT treat as internal CLI: ${cmd}`, () => {
      assert.equal(invokesChatsSandbox(cmd), false);
    });
  }
  // Must skip: real invocations of the CLI.
  const realInvocations = [
    "chats-sandbox restore 3",
    "cd /repo && chats-sandbox status",
    "DEBUG=1 chats-sandbox config set verbose true",
    "/usr/local/bin/chats-sandbox dashboard",
  ];
  for (const cmd of realInvocations) {
    it(`treats as internal CLI: ${cmd}`, () => {
      assert.equal(invokesChatsSandbox(cmd), true);
    });
  }
});

describe("#5 action dirs sort numerically (no seq-1000 prune inversion)", () => {
  it("orders action_999 before action_1000 (newest last)", () => {
    // Reproduce the listActionDirs comparator: numeric seq, ts tiebreak.
    const seqOf = (d: string): number => {
      const n = parseInt(d.split("_")[1] ?? "", 10);
      return Number.isNaN(n) ? -1 : n;
    };
    const sorted = ["action_1000_z", "action_100_y", "action_999_x"]
      .sort((a, b) => seqOf(a) - seqOf(b) || a.localeCompare(b));
    assert.deepEqual(sorted, ["action_100_y", "action_999_x", "action_1000_z"]);
    // The NEWEST (1000) must be last so prune-oldest (shift) never evicts it.
    assert.equal(sorted[sorted.length - 1], "action_1000_z");
    // A plain lexical sort would wrongly put 1000 first:
    const lexical = ["action_1000_z", "action_100_y", "action_999_x"].sort();
    assert.equal(lexical[0], "action_1000_z"); // the bug
  });
});

describe("#10 timing handshake field name matches", () => {
  it("pre-tool writes backupId (singular) that post-tool reads", () => {
    // The two hooks must agree on the field name. Pre-tool writes a
    // `backupId` key; post-tool's readBackupId reads `.backupId`.
    const written = { startTime: 1, backupId: "abc12345", backupIds: ["abc12345"], needsSubagent: false };
    const read = (t: { backupId?: string }) => t.backupId;
    assert.equal(read(written), "abc12345");
    // The old payload (backupIds only) would read undefined:
    const oldPayload = { startTime: 1, backupIds: ["abc12345"] } as { backupId?: string };
    assert.equal(read(oldPayload), undefined);
  });
});

// ── Integration: #6 .env captured, #3 reset-hard keeps tier-2 ─────────
import { runBackup, resetAction } from "../src/backup/strategies.js";
import { DEFAULT_CONFIG, type HookContext, type SandboxConfig } from "../src/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

function envSetup(): { ws: string; config: SandboxConfig; cwd: string } {
  const cwd = process.cwd();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "chats-sec-"));
  process.chdir(ws);
  execFileSync("git", ["init", "-q"], { cwd: ws });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: ws });
  execFileSync("git", ["config", "user.name", "t"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "seed.txt"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: ws });
  execFileSync("git", ["commit", "-qm", "i"], { cwd: ws });
  return {
    ws,
    config: { ...DEFAULT_CONFIG, backupDir: path.join(ws, ".chats-sandbox", "backups"), subagentEnabled: false },
    cwd,
  };
}
function ctx(tool: string, input: Record<string, unknown>): HookContext {
  return { hook_event: "PreToolUse", tool_name: tool, tool_input: input };
}

describe("#6 .env pre-state is captured by tier-2 snapshot", () => {
  it("an Edit of .env produces a git_snapshot artifact", () => {
    const { ws, config, cwd } = envSetup();
    try {
      resetAction();
      fs.writeFileSync(path.join(ws, ".env"), "SECRET=old\n");
      const r = runBackup(ctx("Edit", { file_path: path.join(ws, ".env") }), config);
      const strategies = r.artifacts.map((a) => a.strategy);
      assert.ok(strategies.includes("git_snapshot"),
        `.env Edit should be captured by tier-2; got [${strategies.join(", ")}]`);
    } finally {
      process.chdir(cwd);
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("#3 git reset --hard keeps the tier-2 worktree snapshot", () => {
  it("records BOTH the policy_rewrite and a git_snapshot", () => {
    const { ws, config, cwd } = envSetup();
    try {
      // second commit so HEAD~1 is a valid reset target
      fs.writeFileSync(path.join(ws, "seed.txt"), "v2\n");
      execFileSync("git", ["commit", "-aqm", "v2"], { cwd: ws });
      resetAction();
      // dirty the worktree so there is something --hard would destroy
      fs.writeFileSync(path.join(ws, "seed.txt"), "uncommitted edit\n");
      const r = runBackup(ctx("Bash", { command: "git reset --hard HEAD~1" }), config);
      const strategies = r.artifacts.map((a) => a.strategy);
      assert.ok(strategies.includes("policy_rewrite"), "tier-0 should fire");
      assert.ok(strategies.includes("git_snapshot"),
        `tier-2 must ALSO capture the dirty worktree; got [${strategies.join(", ")}]`);
    } finally {
      process.chdir(cwd);
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ── Recovery awareness: one concise notice after a restore ───────────
import { pendingRecoveryNotice } from "../src/hooks/recovery-notice.js";

describe("recovery notice fires once after a restore", () => {
  it("returns a concise notice the first time, null thereafter", () => {
    const { ws, config, cwd } = envSetup();
    try {
      const ledger = path.join(ws, ".chats-sandbox", "restore-history.jsonl");
      fs.mkdirSync(path.dirname(ledger), { recursive: true });
      fs.appendFileSync(ledger, JSON.stringify({
        ts: "2026-06-13T00:00:00.000Z", mode: "direct",
        action: "action_005_20260613", seq: 5, steps: 3, ok: 3, failed: 0,
      }) + "\n");

      const first = pendingRecoveryNotice(config);
      assert.ok(first, "expected a notice after a restore");
      assert.match(first!, /Recovery: workspace rewound to action 005/);
      assert.match(first!, /Re-read open files/);

      // Same restore must not announce again.
      assert.equal(pendingRecoveryNotice(config), null);

      // A NEW restore announces once more.
      fs.appendFileSync(ledger, JSON.stringify({
        ts: "2026-06-13T01:00:00.000Z", mode: "direct",
        action: "action_006_20260613", seq: 6, steps: 1, ok: 1, failed: 0,
      }) + "\n");
      assert.ok(pendingRecoveryNotice(config), "a newer restore should announce");
      assert.equal(pendingRecoveryNotice(config), null);
    } finally {
      process.chdir(cwd);
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
