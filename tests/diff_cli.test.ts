/**
 * End-to-end tests for `chats-sandbox diff <N>`.
 *
 * Invokes the compiled CLI binary against a real temp workspace with
 * real backups, then verifies the diff output targets the correct
 * interaction (not HEAD of the shared shadow repo).
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

function runCli(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  // Redirect stderr to stdout so execSync captures both streams.
  // We can't use separate pipes reliably on exit code 0, so merge them.
  try {
    const stdout = execSync(`node ${CLI} ${args.join(" ")} 2>&1`, {
      encoding: "utf-8",
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: "/bin/sh",
    });
    return { stdout, stderr: stdout, exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    const combined = (err.stdout ?? "") + (err.stderr ?? "");
    return {
      stdout: combined,
      stderr: combined,
      exitCode: err.status ?? 1,
    };
  }
}

function setupWorkspaceWithConfig(): {
  workspace: string;
  config: SandboxConfig;
  originalCwd: string;
} {
  const originalCwd = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chats-diff-e2e-"));
  process.chdir(workspace);

  // Write a config file so the CLI picks it up
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
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

describe("diff CLI end-to-end", () => {
  it("targets the specific interaction's commit, not HEAD", () => {
    const { workspace, config, originalCwd } = setupWorkspaceWithConfig();
    try {
      resetInteraction();
      const filePath = path.join(workspace, "app.py");

      // Interaction 1: create file with "version_A"
      fs.writeFileSync(filePath, "version_A\n");
      runBackup(makeCtx("Write", { path: filePath, content: "A" }), config);

      // Interaction 2: change to "version_B"
      resetInteraction();
      fs.writeFileSync(filePath, "version_B\n");
      runBackup(makeCtx("Write", { path: filePath, content: "B" }), config);

      // Current state is "version_B"
      // diff against interaction 1 should show the A → B change
      const diff1 = runCli(["diff", "1"], workspace);
      assert.equal(diff1.exitCode, 0, `diff failed: ${diff1.stderr}`);

      // The diff should mention both version_A (removed) and version_B (added)
      assert.ok(diff1.stdout.includes("version_A") || diff1.stdout.includes("-version_A"),
        `Expected 'version_A' in diff output, got: ${diff1.stdout.slice(0, 500)}`);
      assert.ok(diff1.stdout.includes("version_B") || diff1.stdout.includes("+version_B"),
        `Expected 'version_B' in diff output, got: ${diff1.stdout.slice(0, 500)}`);

      // diff against interaction 2 should show NO changes (current state IS interaction 2)
      const diff2 = runCli(["diff", "2"], workspace);
      assert.equal(diff2.exitCode, 0);
      assert.ok(
        diff2.stdout.toLowerCase().includes("no changes"),
        `Expected 'no changes' message, got: ${diff2.stdout.slice(0, 500)}`,
      );
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("rejects out-of-range interaction number", () => {
    const { workspace, config, originalCwd } = setupWorkspaceWithConfig();
    try {
      resetInteraction();
      fs.writeFileSync(path.join(workspace, "x.txt"), "hello\n");
      runBackup(makeCtx("Write", { path: "x.txt", content: "h" }), config);

      const result = runCli(["diff", "999"], workspace);
      // CLI should print an error but not crash
      assert.ok(
        result.stderr.includes("Invalid interaction number") ||
          result.stdout.includes("Invalid interaction number"),
        `Expected error message, got stdout=${result.stdout} stderr=${result.stderr}`,
      );
    } finally {
      teardown(workspace, originalCwd);
    }
  });

  it("shows usage when no argument is provided", () => {
    const { workspace, config, originalCwd } = setupWorkspaceWithConfig();
    try {
      resetInteraction();
      fs.writeFileSync(path.join(workspace, "y.txt"), "test\n");
      runBackup(makeCtx("Write", { path: "y.txt", content: "t" }), config);

      const result = runCli(["diff"], workspace);
      const combined = result.stdout + result.stderr;
      assert.ok(
        combined.toLowerCase().includes("usage"),
        `Expected usage message, got: ${combined.slice(0, 300)}`,
      );
    } finally {
      teardown(workspace, originalCwd);
    }
  });
});
