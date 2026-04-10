/**
 * Config loader — reads .chats-sandbox/config.json, merges with defaults.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, type SandboxConfig } from "../types.js";

const CONFIG_DIR = ".chats-sandbox";
const CONFIG_FILE = "config.json";

export function getConfigDir(projectRoot: string = process.cwd()): string {
  return path.join(projectRoot, CONFIG_DIR);
}

export function getConfigPath(projectRoot: string = process.cwd()): string {
  return path.join(getConfigDir(projectRoot), CONFIG_FILE);
}

export function loadConfig(projectRoot: string = process.cwd()): SandboxConfig {
  const configPath = getConfigPath(projectRoot);
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const userConfig = JSON.parse(raw) as Partial<SandboxConfig>;
    return { ...DEFAULT_CONFIG, ...userConfig };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(
  config: Partial<SandboxConfig>,
  projectRoot: string = process.cwd()
): void {
  const dir = getConfigDir(projectRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const current = loadConfig(projectRoot);
  const merged = { ...current, ...config };
  fs.writeFileSync(
    getConfigPath(projectRoot),
    JSON.stringify(merged, null, 2) + "\n",
    "utf-8"
  );
}
