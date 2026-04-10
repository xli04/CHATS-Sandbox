/**
 * Backup manifest — reads interaction folders to list all backup artifacts.
 * No separate manifest.json needed — metadata.json inside each interaction
 * folder is the source of truth.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { BackupArtifact, SandboxConfig } from "../types.js";

/**
 * List all interaction folders (sorted oldest → newest).
 */
export function listInteractions(config: SandboxConfig): string[] {
  const backupRoot = path.resolve(config.backupDir);
  if (!fs.existsSync(backupRoot)) return [];
  return fs
    .readdirSync(backupRoot)
    .filter((d) => d.startsWith("interaction_"))
    .sort();
}

/**
 * Load all backup artifacts across all interaction folders.
 */
export function loadManifest(config: SandboxConfig): BackupArtifact[] {
  const backupRoot = path.resolve(config.backupDir);
  const dirs = listInteractions(config);
  const all: BackupArtifact[] = [];

  for (const dir of dirs) {
    const metaPath = path.join(backupRoot, dir, "metadata.json");
    if (fs.existsSync(metaPath)) {
      try {
        const entries = JSON.parse(
          fs.readFileSync(metaPath, "utf-8")
        ) as BackupArtifact[];
        all.push(...entries);
      } catch {
        // skip corrupt metadata
      }
    }
  }

  return all;
}

/**
 * No-op for compatibility — artifacts are now written directly by strategies.ts
 * into the interaction folder's metadata.json.
 */
export function appendToManifest(
  _artifact: BackupArtifact,
  _config: SandboxConfig
): void {
  // Handled by writeMetadata() in strategies.ts
}
