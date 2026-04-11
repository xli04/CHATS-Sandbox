/**
 * Tests for the rule engine (engine/rules.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/engine/rules.js";
import { DEFAULT_CONFIG, type HookContext, type SandboxConfig } from "../src/types.js";

function makeCtx(toolName: string, toolInput: Record<string, unknown>): HookContext {
  return { hook_event: "PreToolUse", tool_name: toolName, tool_input: toolInput };
}

function cfg(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// ── Deny rules ───────────────────────────────────────────────────────

describe("deny rules", () => {
  it("default config has no deny rules (policy is opt-in)", () => {
    // Claude Code and the model already refuse obviously destructive
    // commands, so the sandbox ships with an empty denyPatterns list.
    // rm -rf / should pass through the deny check (it'll still get
    // backed up by tier 2).
    const r = evaluate(makeCtx("Bash", { command: "rm -rf /" }), cfg());
    assert.notEqual(r.decision, "deny");
  });

  it("mechanism still works when user configures deny patterns", () => {
    const r = evaluate(
      makeCtx("Bash", { command: "rm -rf /" }),
      cfg({ denyPatterns: ["rm\\s+-rf\\s+/(?!tmp)"] })
    );
    assert.equal(r.decision, "deny");
    assert.equal(r.trigger, "deny_rule");
  });

  it("user-configured deny pattern for fork bombs", () => {
    const r = evaluate(
      makeCtx("Bash", { command: ":(){ :|:& };:" }),
      cfg({ denyPatterns: [":(\\)\\{\\s*:|\\(\\)\\s*\\{)"] })
    );
    assert.equal(r.decision, "deny");
  });

  it("user-configured pattern allows /tmp exception", () => {
    const r = evaluate(
      makeCtx("Bash", { command: "rm -rf /tmp/junk" }),
      cfg({ denyPatterns: ["rm\\s+-rf\\s+/(?!tmp)"] })
    );
    assert.notEqual(r.decision, "deny");
  });
});

// ── Precaution field ─────────────────────────────────────────────────

describe("precaution field", () => {
  it("triggers backup when precaution=true", () => {
    const r = evaluate(makeCtx("Bash", { command: "make deploy", precaution: true }), cfg());
    assert.equal(r.decision, "backup");
    assert.equal(r.trigger, "precaution_field");
  });

  it("triggers backup when precaution='true' (string)", () => {
    const r = evaluate(makeCtx("Bash", { command: "make deploy", precaution: "true" }), cfg());
    assert.equal(r.decision, "backup");
    assert.equal(r.trigger, "precaution_field");
  });

  it("does not trigger on precaution=false", () => {
    const r = evaluate(makeCtx("Bash", { command: "ls" }), cfg());
    assert.notEqual(r.trigger, "precaution_field");
  });
});

// ── Read-only tools ──────────────────────────────────────────────────

describe("read-only tools", () => {
  for (const tool of ["Read", "read_file", "Glob", "Grep", "WebSearch", "WebFetch"]) {
    it(`passes through ${tool}`, () => {
      const r = evaluate(makeCtx(tool, {}), cfg());
      assert.equal(r.decision, "pass");
    });
  }
});

// ── chats-sandbox CLI commands ────────────────────────────────────────

describe("chats-sandbox CLI commands", () => {
  for (const cmd of [
    "chats-sandbox status",
    "chats-sandbox restore 1",
    "chats-sandbox restore_direct 2",
    "chats-sandbox history",
    "chats-sandbox clear",
    "chats-sandbox diff 1",
    "chats-sandbox config",
  ]) {
    it(`passes through "${cmd}"`, () => {
      const r = evaluate(makeCtx("Bash", { command: cmd }), cfg());
      assert.equal(r.decision, "pass", `Expected pass for "${cmd}", got ${r.decision}: ${r.reason}`);
    });
  }
});

// ── File-mutating tools ──────────────────────────────────────────────

describe("file-mutating tools", () => {
  for (const tool of ["FileEdit", "Write", "write_file", "patch", "NotebookEdit"]) {
    it(`backs up ${tool}`, () => {
      const r = evaluate(makeCtx(tool, { path: "/some/file.py" }), cfg());
      assert.equal(r.decision, "backup");
      assert.equal(r.trigger, "backup_rule");
    });
  }
});

// ── Rule-based patterns ──────────────────────────────────────────────

describe("backup patterns", () => {
  const cases: Array<[string, string]> = [
    ["rm file.txt", "rm\\s"],
    ["git push origin main", "git\\s+push"],
    ["git rebase main", "git\\s+rebase"],
    ["pip install flask", "pip\\s+install"],
    ["npm uninstall lodash", "npm\\s+uninstall"],
    ["apt install curl", "apt\\s+install"],
    ["DROP TABLE users", "DROP\\s+TABLE"],
  ];

  for (const [cmd, pattern] of cases) {
    it(`backs up "${cmd}" (matched ${pattern})`, () => {
      const r = evaluate(makeCtx("Bash", { command: cmd }), cfg());
      assert.equal(r.decision, "backup");
      assert.equal(r.trigger, "backup_rule");
    });
  }
});

// ── Default backup ───────────────────────────────────────────────────

describe("default backup", () => {
  it("backs up unknown commands in smart mode", () => {
    const r = evaluate(makeCtx("Bash", { command: "some-unknown-tool --do-stuff" }), cfg());
    assert.equal(r.decision, "backup");
    assert.equal(r.trigger, "default_backup");
  });

  it("backs up unknown tools", () => {
    const r = evaluate(makeCtx("SomeNewTool", { data: "foo" }), cfg());
    assert.equal(r.decision, "backup");
    assert.equal(r.trigger, "default_backup");
  });
});

// ── Backup mode off ──────────────────────────────────────────────────

describe("backupMode=off", () => {
  it("passes everything when off", () => {
    const r = evaluate(makeCtx("Bash", { command: "rm important.txt" }), cfg({ backupMode: "off" }));
    assert.equal(r.decision, "pass");
  });

  it("backupMode=off short-circuits before deny rules", () => {
    // Even if the user configures deny patterns, backupMode=off passes
    // everything through. Off means off.
    const r = evaluate(
      makeCtx("Bash", { command: "rm -rf /" }),
      cfg({ backupMode: "off", denyPatterns: ["rm\\s+-rf\\s+/"] })
    );
    assert.equal(r.decision, "pass");
  });
});
