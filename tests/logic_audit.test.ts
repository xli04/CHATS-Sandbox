/**
 * ADVERSARIAL LOGIC AUDIT — probes for gate misclassification and
 * restore-path damage. Read-only w.r.t. product source; only asserts
 * observed behavior of the shipped functions.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  touchesOutsideWorkspace,
  isReadOnlyBash,
  isReadOnlyMcpTool,
  tryPatternCreateReverter,
  resetAction,
} from "../src/backup/strategies.js";
import { isDangerousRecoveryCommand } from "../src/restore/restore.js";
import { saveExperiences } from "../src/explore/experiences.js";
import { DEFAULT_CONFIG, type HookContext, type SandboxConfig } from "../src/types.js";

function ctx(toolName: string, toolInput: Record<string, unknown>): HookContext {
  return { hook_event: "PreToolUse", tool_name: toolName, tool_input: toolInput };
}

function setup(): { workspace: string; config: SandboxConfig; originalCwd: string } {
  const originalCwd = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chats-audit-"));
  process.chdir(workspace);
  return {
    workspace,
    config: {
      ...DEFAULT_CONFIG,
      backupDir: path.join(workspace, ".chats-sandbox", "backups"),
      subagentEnabled: false,
    },
    originalCwd,
  };
}
function teardown(workspace: string, cwd: string): void {
  process.chdir(cwd);
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* */ }
}

// ── H5: unknown MCP execute_sql with UPDATE/INSERT on a never-explored
//        server is NOT backed up (only DELETE/DROP/TRUNCATE are floored). ──
describe("REGRESSION (was H5): irreversible SQL mutation via unknown MCP tool IS backed up", () => {
  beforeEach(() => resetAction());
  it("UPDATE via execute_sql (no experience) → touchesOutsideWorkspace=false", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      const c = ctx("mcp__analytics__execute_sql", { sql: "UPDATE accounts SET balance = 0 WHERE user_id = 42" });
      const backedUp = touchesOutsideWorkspace(c, config);
      // Destructive DELETE for contrast — this one IS floored.
      const del = touchesOutsideWorkspace(
        ctx("mcp__analytics__execute_sql", { sql: "DELETE FROM accounts WHERE user_id = 42" }),
        config,
      );
      assert.equal(del, true, "DELETE floored (control)");
      // FIXED: the fallback scans the sql payload, so an irreversible UPDATE
      // on an unexplored server is now backed up too.
      assert.equal(backedUp, true, "UPDATE now backed up");
    } finally { teardown(workspace, originalCwd); }
  });
  it("INSERT via execute_sql (no experience) → touchesOutsideWorkspace=false", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      const backedUp = touchesOutsideWorkspace(
        ctx("mcp__analytics__execute_sql", { sql: "INSERT INTO audit VALUES (1)" }), config);
      assert.equal(backedUp, true, "INSERT now backed up");
    } finally { teardown(workspace, originalCwd); }
  });
});

// ── H1: direct DB-client bash mutations whose verb is missing from the
//        outsidePatterns DB regex escape backup. ──
describe("REGRESSION (was H1): DB-client bash mutations with formerly-unlisted verbs ARE detected", () => {
  beforeEach(() => resetAction());
  const cases: Array<[string, string]> = [
    ["mysql -e \"REPLACE INTO users VALUES (1,'x')\"", "REPLACE (MySQL upsert, overwrites)"],
    ["psql -c \"GRANT ALL ON accounts TO bob\"", "GRANT (privilege change)"],
    ["psql -c \"REVOKE SELECT ON accounts FROM bob\"", "REVOKE"],
    ["psql -c \"\\copy accounts FROM '/tmp/x.csv'\"", "\\copy bulk load"],
    ["mysql -e \"CALL wipe_everything()\"", "CALL stored proc"],
  ];
  for (const [cmd, label] of cases) {
    it(`${label}: not detected as outside-workspace`, () => {
      const { workspace, config, originalCwd } = setup();
      try {
        const out = touchesOutsideWorkspace(ctx("Bash", { command: cmd }), config);
        assert.equal(out, true, `${label} now escalates to tier-3`);
      } finally { teardown(workspace, originalCwd); }
    });
  }
  it("control: psql DELETE IS detected", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      assert.equal(touchesOutsideWorkspace(ctx("Bash", { command: "psql -c \"DELETE FROM t\"" }), config), true);
    } finally { teardown(workspace, originalCwd); }
  });
});

// ── H4: attacker-controlled pin value is substituted verbatim into a
//        create-reverter's recovery_mcp_calls and later replayed UNGUARDED. ──
describe("REGRESSION (was H4): pin injection is refused before deterministic replay", () => {
  beforeEach(() => resetAction());
  it("injection-prone pin refused; clean pin still works", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      // A plausible learned create pattern for a SQL-ish server: the reverter
      // deletes the created row by a captured title, expressed as an MCP call.
      saveExperiences(config, {
        server: "analytics",
        generated: new Date().toISOString(),
        observed_tools: ["insert_row", "execute_sql"],
        patterns: [{
          action: "insert a row",
          applies_to: "insert_row",
          trigger: "insert row",
          verified: true,
          reverter: {
            pin: "title",
            mcp_calls: [{ tool: "execute_sql", args: { sql: "DELETE FROM posts WHERE title = '<title>'" } }],
          },
        }],
      });
      const crafted = "x'; DROP TABLE posts; --";
      const art = tryPatternCreateReverter(
        ctx("mcp__analytics__insert_row", { title: crafted }), config);
      // FIXED: an injection-prone pin value is refused at build time — the
      // deterministic reverter returns null and the action falls through to
      // the capture subagent (which reverses safely through the live MCP).
      assert.equal(art, null, "injection-prone pin refused, no unguarded replay artifact");
      // A clean pin still produces the deterministic reverter.
      const good = tryPatternCreateReverter(
        ctx("mcp__analytics__insert_row", { title: "post-12345" }), config);
      assert.ok(good, "clean pin still produces a reverter");
      const sql = String((good!.recoveryMcpCalls?.[0]?.args as Record<string, unknown>)?.sql ?? "");
      assert.ok(sql.includes("post-12345") && !sql.includes("DROP"), "clean value substituted");
    } finally { teardown(workspace, originalCwd); }
  });
});

// ── H11: isDangerousRecoveryCommand denylist bypasses. ──
describe("REGRESSION (was H11): dangerous-recovery-command guard catches former bypasses", () => {
  const bypasses: Array<[string, string]> = [
    ["rm --recursive --force /", "long-flag rm of /"],
    ["rm -rf --no-preserve-root /", "flag between rm and /"],
    ["bash -c 'rm -rf /'", "wrapped in bash -c"],
    ["find / -delete", "find -delete wipe"],
  ];
  for (const [cmd, label] of bypasses) {
    it(`${label} IS now flagged dangerous`, () => {
      assert.equal(isDangerousRecoveryCommand(cmd), true, `now caught: ${label}`);
    });
  }
  it("control: rm -rf / IS flagged", () => {
    assert.equal(isDangerousRecoveryCommand("rm -rf /"), true);
  });
});

// ── Sanity: isReadOnlyMcpTool classification spot-checks. ──
describe("sanity: mcp read-only classifier", () => {
  it("execute_sql is not treated as read-only", () => {
    assert.equal(isReadOnlyMcpTool("mcp__pg__execute_sql"), false);
  });
});
