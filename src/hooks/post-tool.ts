#!/usr/bin/env node
/**
 * PostToolUse / PostToolUseFailure hook — fires after every Claude Code tool call.
 *
 * Captures effect manifest: what did this tool call actually change?
 */

import * as fs from "node:fs";
import { loadConfig } from "../config/load.js";
import { captureEffect, logEffect } from "../engine/effects.js";
import type { HookContext } from "../types.js";

async function main(): Promise<void> {
  // Recursion guard: exit early if running inside a sandbox-spawned subagent
  if (process.env.CHATS_SANDBOX_NO_HOOK === "1") {
    process.exit(0);
  }

  // Read context from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");

  let ctx: HookContext;
  try {
    ctx = JSON.parse(raw) as HookContext;
  } catch {
    process.exit(0);
  }

  const config = loadConfig();

  if (!config.enabled || !config.effectManifest) {
    process.exit(0);
  }

  // Recover timing + backup ID from env (set by pre-tool hook in same session)
  // Note: in Claude Code, pre/post hooks are separate processes, so env vars
  // don't persist. We use a temp file instead.
  const startTime = readTiming(ctx) ?? Date.now();
  const backupId = readBackupId(ctx);

  // Capture and log the effect
  const effect = captureEffect(ctx, backupId, startTime);
  logEffect(effect, config);

  if (config.verbose) {
    process.stderr.write(
      `[CHATS-Sandbox] Effect logged: ${ctx.tool_name} ` +
      `(${effect.success ? "ok" : "fail"}, ${effect.durationMs}ms)\n`
    );
  }

  if (config.verbose) {
    const summary = buildEffectSummary(effect);
    if (summary) {
      process.stderr.write(summary + "\n");
    }
  }

  // Don't write to stdout — Claude Code's PostToolUse hook validation
  // is strict and rejects output that doesn't match its expected schema.
  // Effect logging is internal; no need to inject into the conversation.
  process.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildEffectSummary(effect: {
  toolName: string;
  filesCreated?: string[];
  filesModified?: string[];
  filesDeleted?: string[];
  backupId?: string;
  success: boolean;
}): string | undefined {
  const parts: string[] = [];

  if (effect.filesCreated?.length) {
    parts.push(`created: ${effect.filesCreated.join(", ")}`);
  }
  if (effect.filesModified?.length) {
    parts.push(`modified: ${effect.filesModified.join(", ")}`);
  }
  if (effect.filesDeleted?.length) {
    parts.push(`deleted: ${effect.filesDeleted.join(", ")}`);
  }
  if (effect.backupId) {
    parts.push(`backup: ${effect.backupId}`);
  }

  if (parts.length === 0) return undefined;
  return `[CHATS-Sandbox] Effects: ${parts.join("; ")}`;
}

/**
 * Read timing info from a temp file (written by pre-tool hook).
 * Pre-tool and post-tool are separate processes, so we use the filesystem.
 */
interface TimingData {
  startTime: number;
  backupId: string | null;
}

let _cachedTiming: TimingData | null = null;

function loadTimingFile(ctx: HookContext): TimingData | null {
  if (_cachedTiming !== null) return _cachedTiming;
  try {
    const tmpFile = `/tmp/chats-sandbox-timing-${ctx.session_id ?? "default"}.json`;
    if (fs.existsSync(tmpFile)) {
      const data = JSON.parse(fs.readFileSync(tmpFile, "utf-8")) as TimingData;
      fs.unlinkSync(tmpFile); // consume it
      _cachedTiming = data;
      return data;
    }
  } catch {
    // ignore
  }
  return null;
}

function readTiming(ctx: HookContext): number | undefined {
  return loadTimingFile(ctx)?.startTime;
}

function readBackupId(ctx: HookContext): string | undefined {
  return loadTimingFile(ctx)?.backupId ?? undefined;
}

main().catch((err) => {
  process.stderr.write(`[CHATS-Sandbox] PostToolUse error: ${err}\n`);
  process.exit(0);
});
