/**
 * Tests for the post-refactor backup path:
 *   - the pattern-driven MCP create reverter (tryPatternCreateReverter) that
 *     replays a create's native MCP inverse (e.g. delete_directory), and
 *   - minimalToolAllow reading the explorer's learned `capture_tools`.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  tryPatternCreateReverter,
  minimalToolAllow,
  runBackup,
  resetAction,
} from "../src/backup/strategies.js";
import { DEFAULT_CONFIG, type HookContext, type SandboxConfig } from "../src/types.js";

function makeCtx(toolName: string, toolInput: Record<string, unknown>): HookContext {
  return { hook_event: "PreToolUse", tool_name: toolName, tool_input: toolInput };
}

/** A temp workspace with a real parent dir so create-shortcut existence checks
 *  operate on a genuine local fs. Returns { config, work }. */
function setup(opts?: { experience?: unknown; subagentEnabled?: boolean }): {
  config: SandboxConfig;
  work: string;
} {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "chats-cs-test-"));
  const config: SandboxConfig = {
    ...DEFAULT_CONFIG,
    backupDir: path.join(work, ".chats-sandbox", "backups"),
    maxActions: 50,
    subagentEnabled: opts?.subagentEnabled ?? false,
  };
  if (opts?.experience) {
    // experiencesDir = dirname(backupDir)/experiences
    const expDir = path.join(work, ".chats-sandbox", "experiences");
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(path.join(expDir, "filesystem.json"), JSON.stringify(opts.experience));
  }
  return { config, work };
}

const FS_EXPERIENCE = {
  server: "filesystem",
  generated: "2026-06-30T00:00:00.000Z",
  observed_tools: [
    "read_text_file", "write_file", "edit_file", "create_directory",
    "move_file", "get_file_info", "list_directory", "delete_file", "delete_directory",
  ],
  patterns: [
    { action: "write a file", skill: "restore prior content", applies_to: "write_file",
      trigger: "write", verified: true, capture_tools: ["read_text_file", "write_file"] },
    { action: "edit a file", skill: "restore original", applies_to: "edit_file",
      trigger: "edit", verified: true, capture_tools: ["read_text_file", "write_file"] },
    { action: "create a directory", skill: "delete the created directory", applies_to: "create_directory",
      trigger: "create", verified: true,
      reverter: { pin: "path", mcp_calls: [{ tool: "delete_directory", args: { path: "<path>" } }] } },
    { action: "move a file", skill: "move back", applies_to: "move_file",
      trigger: "move", verified: true, capture_tools: ["get_file_info", "move_file"] },
  ],
  readOnlyTools: ["read_text_file", "get_file_info", "list_directory"],
};

describe("minimalToolAllow reads the explorer's capture_tools", () => {
  it("returns the learned capture_tools VERBATIM for a matched pattern", () => {
    const { config } = setup({ experience: FS_EXPERIENCE });
    const write = minimalToolAllow(makeCtx("mcp__filesystem__write_file", { path: "/x" }), config);
    assert.deepEqual(write, ["read_text_file", "write_file"]);
    const move = minimalToolAllow(makeCtx("mcp__filesystem__move_file", { source: "/a", destination: "/b" }), config);
    assert.deepEqual(move, ["get_file_info", "move_file"]);
  });

  it("returns undefined when there is no experience for the server (→ unfiltered)", () => {
    const { config } = setup(); // no experience written
    const out = minimalToolAllow(makeCtx("mcp__filesystem__write_file", { path: "/x" }), config);
    assert.equal(out, undefined);
  });
});

describe("pattern-driven remote create reverter (tryPatternCreateReverter)", () => {
  beforeEach(() => resetAction());

  // A notion-like server whose CREATE pattern carries a deterministic reverter:
  // delete the created page by the id the agent passed. (edit/delete patterns
  // deliberately carry NO reverter.)
  function setupNotion(reverter: unknown): SandboxConfig {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "chats-rev-test-"));
    const config: SandboxConfig = {
      ...DEFAULT_CONFIG,
      backupDir: path.join(work, ".chats-sandbox", "backups"),
      maxActions: 50,
      subagentEnabled: false,
    };
    const expDir = path.join(work, ".chats-sandbox", "experiences");
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(path.join(expDir, "notion.json"), JSON.stringify({
      server: "notion",
      generated: "2026-06-30T00:00:00.000Z",
      observed_tools: ["create_page", "update_page", "delete_page", "get_page"],
      patterns: [
        { action: "create a page", skill: "delete the created page", applies_to: "create_page",
          trigger: "create", verified: true, reverter },
        { action: "edit a page", skill: "restore prior content", applies_to: "update_page",
          trigger: "update", verified: true, capture_tools: ["get_page", "update_page"] },
      ],
    }));
    return config;
  }

  it("create with an MCP-call reverter → deterministic recoveryMcpCalls, no subagent", () => {
    const config = setupNotion({ pin: "title", mcp_calls: [{ tool: "delete_page", args: { title: "<title>" } }] });
    const art = tryPatternCreateReverter(
      makeCtx("mcp__notion__create_page", { title: "My New Page", body: "hi" }), config);
    assert.ok(art, "reverter should fire for a create with a reverter recipe");
    assert.equal(art!.liveRestore, false);
    assert.ok(Array.isArray(art!.recoveryMcpCalls) && art!.recoveryMcpCalls!.length === 1);
    const call = art!.recoveryMcpCalls![0];
    assert.equal(call.tool, "delete_page");
    assert.equal(call.server, "notion");
    assert.equal(call.args.title, "My New Page", "the <title> placeholder is filled from typed input");
  });

  it("create with a prose-command reverter → deterministic recoveryCommands", () => {
    const config = setupNotion({ pin: "title", commands: ["delete the page whose title == '<title>'"] });
    const art = tryPatternCreateReverter(
      makeCtx("mcp__notion__create_page", { title: "Quarterly Report" }), config);
    assert.ok(art, "should fire");
    assert.ok(Array.isArray(art!.recoveryCommands) && art!.recoveryCommands!.length === 1);
    assert.match(art!.recoveryCommands![0], /Quarterly Report/, "the pinned value is substituted");
  });

  it("returns null (→ subagent) when the pinned identifier can't be resolved", () => {
    const config = setupNotion({ pin: "id", mcp_calls: [{ tool: "delete_page", args: { id: "<id>" } }] });
    // The agent did NOT pass an id (a fresh create returns it later) and there
    // is no single typed value → we must not guess.
    const art = tryPatternCreateReverter(makeCtx("mcp__notion__create_page", { title: "X", body: "Y" }), config);
    assert.equal(art, null, "unresolved pin must fall through to the capture subagent");
  });

  it("returns null for an edit pattern (no reverter on update/delete)", () => {
    const config = setupNotion({ pin: "title", mcp_calls: [{ tool: "delete_page", args: { title: "<title>" } }] });
    const art = tryPatternCreateReverter(
      makeCtx("mcp__notion__update_page", { id: "p1", body: "changed" }), config);
    assert.equal(art, null, "an edit has no reverter → capture subagent");
  });
});

describe("integration: runBackup routes an MCP create through the pattern reverter", () => {
  beforeEach(() => resetAction());

  it("create_directory (learned reverter) → recoveryMcpCalls delete_directory, no subagent", () => {
    const { config, work } = setup({ experience: FS_EXPERIENCE, subagentEnabled: false });
    const target = path.join(work, "made_by_agent");
    const res = runBackup(makeCtx("mcp__filesystem__create_directory", { path: target }), config);
    assert.equal(res.artifacts.length, 1, "exactly one deterministic artifact");
    assert.equal(res.artifacts[0].liveRestore, false);
    const call = res.artifacts[0].recoveryMcpCalls?.[0];
    assert.ok(call, "records a native MCP inverse call");
    assert.equal(call!.tool, "delete_directory");
    assert.equal(call!.args.path, target, "delete targets the created path");
    // Handled deterministically over MCP without the capture subagent.
    assert.notEqual(res.needsSubagent, true);
  });
});
