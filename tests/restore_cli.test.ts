/**
 * CLI-level tests for `chats-sandbox restore` and `chats-sandbox restore_direct`.
 * Invokes the compiled CLI binary to test no-arg defaults and argument handling.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { runBackup, resetInteraction } from "../src/backup/strategies.js";
import { DEFAULT_CONFIG, type HookContext, type SandboxConfig } from "../src/types.js";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CLI = path.join(PROJECT_ROOT, "dist/cli.js");

function makeCtx(toolName: string, toolInput: Record<string, unknown>): HookContext {
  return { hook_event: "PreToolUse", tool_name: toolName, tool_input: toolInput };
}

function runCli(args: string[], cwd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args.join(" ")} 2>&1`, {
      encoding: "utf-8",
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: "/bin/sh",
    });
    return { stdout, exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: (err.stdout ?? "") + (err.stderr ?? ""),
      exitCode: err.status ?? 1,
    };
  }
}

function setupWorkspace(): {
  workspace: string;
  config: SandboxConfig;
  originalCwd: string;
} {
  const originalCwd = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chats-restore-cli-"));
  process.chdir(workspace);

  const configDir = path.join(workspace, ".chats-sandbox");
  fs.mkdirSync(configDir, { recursive: true });
  const config: SandboxConfig = {
    ...DEFAULT_CONFIG,
    backupDir: path.join(configDir, "backups"),
  };
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config));

  return { workspace, config, originalCwd };
}

function teardown(workspace: string, originalCwd: string): void {
  process.chdir(originalCwd);
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* */ }
}

describe("restore CLI: no-arg default (undo last step)", () => {
  it("restore with no arg undoes the last interaction", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      resetInteraction();
      const filePath = path.join(workspace, "data.txt");

      // Step 1: create file
      fs.writeFileSync(filePath, "original\n");
      runBackup(makeCtx("Write", { path: filePath, content: "original" }), config);

      // Step 2: modify file
      resetInteraction();
      fs.writeFileSync(filePath, "modified\n");
      runBackup(makeCtx("Write", { path: filePath, content: "modified" }), config);

      // Verify current state
      assert.equal(fs.readFileSync(filePath, "utf-8"), "modified\n");

      // restore (no arg) should undo the last step → back to "original"
      const result = runCli(["restore"], workspace);
      assert.equal(result.exitCode, 0, `restore failed: ${result.stdout}`);
      assert.ok(
        result.stdout.includes("Reverse-loop restore") || result.stdout.includes("defaulting"),
        `Expected restore output, got: ${result.stdout.slice(0, 300)}`
      );

      assert.equal(fs.readFileSync(filePath, "utf-8"), "original\n",
        "File should be restored to pre-step-2 state");
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("restore with no arg and only 1 interaction shows helpful message", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      resetInteraction();
      fs.writeFileSync(path.join(workspace, "x.txt"), "x\n");
      runBackup(makeCtx("Write", { path: "x.txt", content: "x" }), config);

      const result = runCli(["restore"], workspace);
      assert.ok(
        result.stdout.toLowerCase().includes("only one") ||
          result.stdout.toLowerCase().includes("nothing"),
        `Expected 'only one' message, got: ${result.stdout.slice(0, 300)}`
      );
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});

describe("restore_direct CLI: no-arg default", () => {
  it("restore_direct with no arg undoes the last interaction", () => {
    const { workspace, config, originalCwd } = setupWorkspace();
    try {
      resetInteraction();
      const filePath = path.join(workspace, "data.txt");

      fs.writeFileSync(filePath, "v1\n");
      runBackup(makeCtx("Write", { path: filePath, content: "v1" }), config);

      resetInteraction();
      fs.writeFileSync(filePath, "v2\n");
      runBackup(makeCtx("Write", { path: filePath, content: "v2" }), config);

      const result = runCli(["restore_direct"], workspace);
      assert.equal(result.exitCode, 0, `restore_direct failed: ${result.stdout}`);

      assert.equal(fs.readFileSync(filePath, "utf-8"), "v1\n",
        "File should be restored to pre-step-2 state");
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});
