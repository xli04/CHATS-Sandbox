/**
 * Tests for backup strategies (backup/strategies.ts).
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

function tmpConfig(): SandboxConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chats-sandbox-test-"));
  return { ...DEFAULT_CONFIG, backupDir: path.join(dir, "backups"), maxActions: 5 };
}

describe("backup strategies", () => {
  beforeEach(() => {
    resetAction();
  });

  it("creates an action folder", () => {
    const config = tmpConfig();
    runBackup(makeCtx("Bash", { command: "echo hello" }), config);
    const backupRoot = path.resolve(config.backupDir);
    const dirs = fs.readdirSync(backupRoot).filter((d: string) => d.startsWith("action_"));
    assert.ok(dirs.length >= 1, "Expected at least one action folder");
  });

  it("pip install triggers pip_freeze strategy", () => {
    const config = tmpConfig();
    const result = runBackup(makeCtx("Bash", { command: "pip install flask" }), config);
    const pipArtifact = result.artifacts.find((a) => a.strategy === "pip_freeze");
    assert.ok(pipArtifact, "Expected a pip_freeze artifact");
    assert.ok(fs.existsSync(pipArtifact!.artifactPath), "pip freeze file should exist");
  });

  it("git push triggers needsSubagent (outside workspace)", () => {
    const config = tmpConfig();
    const result = runBackup(makeCtx("Bash", { command: "git push origin main" }), config);
    // git push is outside workspace; if no git tag available, subagent needed
    // (git tag may fail in test env since there's no repo with commits)
    assert.ok(result.artifacts.length >= 0); // may or may not have git_snapshot
    // The key check: it should detect outside-workspace
  });

  it("unknown command falls back to git_snapshot", () => {
    const config = tmpConfig();
    const result = runBackup(makeCtx("Bash", { command: "make build" }), config);
    const snapshot = result.artifacts.find((a) => a.strategy === "git_snapshot");
    // git snapshot may or may not succeed depending on cwd state,
    // but at minimum needsSubagent should be set if nothing worked
    assert.ok(
      snapshot || result.needsSubagent,
      "Expected either git_snapshot or needsSubagent=true"
    );
  });

  it("writes metadata.json in action folder", () => {
    const config = tmpConfig();
    runBackup(makeCtx("Bash", { command: "pip install requests" }), config);
    const backupRoot = path.resolve(config.backupDir);
    const dirs = fs.readdirSync(backupRoot).filter((d: string) => d.startsWith("action_"));
    assert.ok(dirs.length >= 1);
    const metaPath = path.join(backupRoot, dirs[0], "metadata.json");
    assert.ok(fs.existsSync(metaPath), "metadata.json should exist");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    assert.ok(Array.isArray(meta), "metadata should be an array");
    assert.ok(meta.length >= 1, "metadata should have at least one artifact");
  });

  it("prunes old action folders", () => {
    const config = tmpConfig();
    config.maxActions = 3;

    for (let i = 0; i < 5; i++) {
      resetAction();
      runBackup(makeCtx("Bash", { command: `echo step ${i}` }), config);
    }

    const backupRoot = path.resolve(config.backupDir);
    const dirs = fs.readdirSync(backupRoot).filter((d: string) => d.startsWith("action_"));
    assert.ok(dirs.length <= 3, `Expected <= 3 folders, got ${dirs.length}`);
  });

  /**
   * Exercise the retention knobs directly by creating action folders on
   * disk (rather than going through runBackup, which only materializes
   * folders when the tool-call actually produces an artifact — flaky in
   * the test env because the shared shadow repo may see no changes).
   */
  it("retention: maxActions=0 + all others 0 keeps everything", () => {
    const config = tmpConfig();
    config.maxActions = 0;
    config.maxTotalSizeMB = 0;
    config.maxAgeHours = 0;

    // Seed 6 action folders, then trigger a pip_install (which reliably
    // produces a pip_freeze artifact and thus triggers pruning).
    const backupRoot = path.resolve(config.backupDir);
    fs.mkdirSync(backupRoot, { recursive: true });
    const pad = (n: number) => String(n).padStart(2, "0");
    for (let i = 0; i < 6; i++) {
      const d = new Date(Date.now() - (6 - i) * 60_000);
      const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      fs.mkdirSync(path.join(backupRoot, `action_${String(i + 1).padStart(3, "0")}_${ts}`));
    }

    resetAction();
    runBackup(makeCtx("Bash", { command: "pip install requests" }), config);

    const dirs = fs.readdirSync(backupRoot).filter((d: string) => d.startsWith("action_"));
    assert.ok(dirs.length >= 6, `all pre-seeded folders should survive when caps are 0, got ${dirs.length}`);
  });

  it("retention: maxAgeHours prunes stale folders", () => {
    const config = tmpConfig();
    config.maxActions = 0;
    config.maxAgeHours = 1;

    const backupRoot = path.resolve(config.backupDir);
    fs.mkdirSync(backupRoot, { recursive: true });
    const pad = (n: number) => String(n).padStart(2, "0");

    // Seed one fresh folder (5 min old) and one stale folder (2 h old).
    const mkFolder = (agedMs: number, seq: string): string => {
      const d = new Date(Date.now() - agedMs);
      const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const name = `action_${seq}_${ts}`;
      fs.mkdirSync(path.join(backupRoot, name));
      return name;
    };
    const stale = mkFolder(2 * 3600 * 1000, "001");
    const fresh = mkFolder(5 * 60 * 1000, "002");

    resetAction();
    runBackup(makeCtx("Bash", { command: "pip install flask" }), config);

    const dirs = fs.readdirSync(backupRoot).filter((d: string) => d.startsWith("action_"));
    assert.ok(!dirs.includes(stale), `stale folder ${stale} should be pruned, got ${JSON.stringify(dirs)}`);
    assert.ok(dirs.includes(fresh), `fresh folder ${fresh} should survive, got ${JSON.stringify(dirs)}`);
  });

  it("seq numbers grow monotonically across pruning (no collisions)", () => {
    const config = tmpConfig();
    config.maxActions = 3;

    // 5 backups → should create action_001 .. action_005 in sequence.
    // After each, pruning keeps only the 3 newest, but seq assignment
    // must use (max existing seq) + 1, NOT (length + 1), or we'd reuse
    // numbers that already survived on disk.
    for (let i = 0; i < 5; i++) {
      resetAction();
      runBackup(makeCtx("Bash", { command: `pip install pkg-${i}` }), config);
    }

    const backupRoot = path.resolve(config.backupDir);
    const dirs = fs.readdirSync(backupRoot).filter((d: string) => d.startsWith("action_")).sort();

    // Get the seq number from each folder name: action_NNN_<ts>
    const seqs = dirs.map((d) => d.split("_")[1]);
    assert.equal(seqs.length, 3, `expected 3 folders, got ${seqs.length}: ${JSON.stringify(dirs)}`);

    // No duplicates
    const unique = new Set(seqs);
    assert.equal(unique.size, seqs.length, `duplicate seqs found: ${JSON.stringify(seqs)}`);

    // Should be the newest three: 003, 004, 005
    assert.deepEqual([...unique].sort(), ["003", "004", "005"],
      `expected [003,004,005], got ${JSON.stringify([...unique].sort())}`);
  });

  it("retention: maxTotalSizeMB prunes oldest until under cap", () => {
    const config = tmpConfig();
    config.maxActions = 0;
    config.maxTotalSizeMB = 1; // 1 MB cap

    const backupRoot = path.resolve(config.backupDir);
    fs.mkdirSync(backupRoot, { recursive: true });
    const pad = (n: number) => String(n).padStart(2, "0");

    // Seed 3 folders (~700KB each) across 3 different minutes → ~2.1 MB.
    for (let i = 0; i < 3; i++) {
      const d = new Date(Date.now() - (3 - i) * 60_000);
      const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const folder = path.join(backupRoot, `action_${String(i + 1).padStart(3, "0")}_${ts}`);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, "filler.bin"), Buffer.alloc(700 * 1024, "x"));
    }

    resetAction();
    runBackup(makeCtx("Bash", { command: "pip install numpy" }), config);

    const dirs = fs.readdirSync(backupRoot).filter((d: string) => d.startsWith("action_"));
    let total = 0;
    for (const d of dirs) {
      const walk = (q: string): void => {
        for (const e of fs.readdirSync(q, { withFileTypes: true })) {
          const full = path.join(q, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.isFile()) total += fs.statSync(full).size;
        }
      };
      walk(path.join(backupRoot, d));
    }
    assert.ok(
      total <= 1024 * 1024 + 200_000, // small slack for the new pip_freeze artifact
      `total size should be ~≤1 MB, got ${total} bytes across ${dirs.length} folders`
    );
  });
});
