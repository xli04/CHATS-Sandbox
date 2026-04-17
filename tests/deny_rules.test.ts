/**
 * Tests that install/uninstall correctly manage permissions.deny rules
 * in .claude/settings.json. These rules block Claude from reading or
 * searching the .chats-sandbox directory (our internal state).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CLI = path.join(PROJECT_ROOT, "dist/cli.js");

const REQUIRED_DENY = [
  "Read(.chats-sandbox/**)",
  "Edit(.chats-sandbox/**)",
  "Write(.chats-sandbox/**)",
  "Glob(.chats-sandbox/**)",
  "Grep(.chats-sandbox/**)",
];

function setupTempProject(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chats-deny-"));
  return {
    dir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

function readSettings(dir: string): Record<string, unknown> {
  const p = path.join(dir, ".claude", "settings.json");
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function runCli(args: string[], cwd: string): void {
  execSync(`node ${CLI} ${args.join(" ")}`, {
    cwd,
    stdio: "pipe",
  });
}

describe("install: adds permissions.deny rules", () => {
  it("creates permissions.deny with all required rules on fresh install", () => {
    const { dir, cleanup } = setupTempProject();
    try {
      runCli(["install"], dir);
      const settings = readSettings(dir);
      const deny = (settings.permissions as { deny?: string[] })?.deny ?? [];
      for (const rule of REQUIRED_DENY) {
        assert.ok(deny.includes(rule), `Expected deny to include "${rule}"`);
      }
    } finally {
      cleanup();
    }
  });

  it("preserves existing deny rules from the user", () => {
    const { dir, cleanup } = setupTempProject();
    try {
      // Pre-seed settings with a user deny rule
      fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".claude", "settings.json"),
        JSON.stringify({
          permissions: {
            deny: ["Bash(rm -rf /)"],
          },
        }),
      );

      runCli(["install"], dir);
      const settings = readSettings(dir);
      const deny = (settings.permissions as { deny?: string[] })?.deny ?? [];
      // User's rule should still be there
      assert.ok(deny.includes("Bash(rm -rf /)"), "User deny rule should be preserved");
      // Our rules should also be added
      for (const rule of REQUIRED_DENY) {
        assert.ok(deny.includes(rule), `Expected deny to include "${rule}"`);
      }
    } finally {
      cleanup();
    }
  });

  it("doesn't duplicate rules if install runs twice", () => {
    const { dir, cleanup } = setupTempProject();
    try {
      runCli(["install"], dir);
      runCli(["install"], dir);
      const settings = readSettings(dir);
      const deny = (settings.permissions as { deny?: string[] })?.deny ?? [];
      for (const rule of REQUIRED_DENY) {
        const count = deny.filter((r) => r === rule).length;
        assert.equal(count, 1, `Rule "${rule}" should appear exactly once, got ${count}`);
      }
    } finally {
      cleanup();
    }
  });
});

describe("uninstall: removes our deny rules", () => {
  it("removes exactly our rules, leaves user rules alone", () => {
    const { dir, cleanup } = setupTempProject();
    try {
      // Pre-seed with a user rule
      fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".claude", "settings.json"),
        JSON.stringify({ permissions: { deny: ["Bash(rm -rf /)"] } }),
      );

      runCli(["install"], dir);
      runCli(["uninstall"], dir);

      const settings = readSettings(dir);
      const deny = (settings.permissions as { deny?: string[] })?.deny ?? [];
      // User's rule stays
      assert.ok(deny.includes("Bash(rm -rf /)"), "User rule should survive uninstall");
      // Ours are gone
      for (const rule of REQUIRED_DENY) {
        assert.ok(!deny.includes(rule), `Our rule "${rule}" should be removed`);
      }
    } finally {
      cleanup();
    }
  });

  it("removes empty permissions section if all rules were ours", () => {
    const { dir, cleanup } = setupTempProject();
    try {
      runCli(["install"], dir);
      runCli(["uninstall"], dir);
      const settings = readSettings(dir);
      // permissions section should be gone entirely (no empty {deny: []} stubs)
      assert.ok(!settings.permissions, `permissions section should be removed, got: ${JSON.stringify(settings.permissions)}`);
    } finally {
      cleanup();
    }
  });
});
