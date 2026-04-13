/**
 * Tests for config loading (config/load.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig, saveConfig } from "../src/config/load.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chats-sandbox-cfg-"));
}

describe("config", () => {
  it("returns defaults when no config file exists", () => {
    const dir = tmpDir();
    const config = loadConfig(dir);
    assert.deepEqual(config, DEFAULT_CONFIG);
  });

  it("saves and loads config", () => {
    const dir = tmpDir();
    saveConfig({ backupMode: "always", verbose: true }, dir);
    const config = loadConfig(dir);
    assert.equal(config.backupMode, "always");
    assert.equal(config.verbose, true);
    // Other fields should still be defaults
    assert.equal(config.enabled, true);
    assert.equal(config.maxActions, 50);
  });

  it("merges partial config with defaults", () => {
    const dir = tmpDir();
    saveConfig({ enabled: false }, dir);
    const config = loadConfig(dir);
    assert.equal(config.enabled, false);
    assert.equal(config.backupMode, "smart"); // default preserved
  });

  it("handles corrupt config file", () => {
    const dir = tmpDir();
    const configDir = path.join(dir, ".chats-sandbox");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), "NOT JSON", "utf-8");
    const config = loadConfig(dir);
    assert.deepEqual(config, DEFAULT_CONFIG);
  });
});
