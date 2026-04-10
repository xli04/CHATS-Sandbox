#!/usr/bin/env node
/**
 * PreToolUse hook — fires before every Claude Code tool call.
 *
 * Flow:
 *   1. Read hook context from stdin
 *   2. Evaluate rules → deny / backup / pass
 *   3. If backup needed, run tiered strategy:
 *      1st: Targeted manifest (pip freeze, git tag, etc.)
 *      2nd: git add -A
 *      3rd: Signal that a subagent is needed (hook layer handles it)
 *   4. Output hook response
 *
 * Exit codes:
 *   0 = allow (with optional modifications/context)
 *   2 = deny (block the tool call)
 */

import * as fs from "node:fs";
import { loadConfig } from "../config/load.js";
import { evaluate } from "../engine/rules.js";
import { runBackup } from "../backup/strategies.js";
import type { HookContext, PreToolHookOutput } from "../types.js";

async function main(): Promise<void> {
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

  if (!config.enabled) {
    process.exit(0);
  }

  // Evaluate rules
  const result = evaluate(ctx, config);

  if (config.verbose) {
    process.stderr.write(
      `[CHATS-Sandbox] ${ctx.tool_name}: ${result.decision} (${result.reason})\n`
    );
  }

  // ── DENY ─────────────────────────────────────────────────────────
  if (result.decision === "deny") {
    const output: PreToolHookOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[CHATS-Sandbox] ${result.reason}`,
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(2);
  }

  // ── BACKUP ───────────────────────────────────────────────────────
  if (result.decision === "backup") {
    const backupResult = runBackup(ctx, config);

    const contextParts: string[] = [];

    // Report what deterministic backup produced
    for (const artifact of backupResult.artifacts) {
      contextParts.push(
        `Backup: ${artifact.description} (${artifact.strategy})`
      );
    }

    // If subagent is needed, add instructions for Claude to see
    if (backupResult.needsSubagent) {
      contextParts.push(
        `[CHATS-Sandbox] SUBAGENT BACKUP NEEDED: ${backupResult.subagentReason}`
      );
    }

    const contextMsg = contextParts.length > 0
      ? `[CHATS-Sandbox] ${contextParts.join("; ")}`
      : `[CHATS-Sandbox] Backup attempted for ${ctx.tool_name}, no artifact created.`;

    if (config.verbose) {
      process.stderr.write(contextMsg + "\n");
    }

    // Write timing info for post-tool hook
    try {
      const tmpFile = `/tmp/chats-sandbox-timing-${ctx.session_id ?? "default"}.json`;
      fs.writeFileSync(tmpFile, JSON.stringify({
        startTime: Date.now(),
        backupIds: backupResult.artifacts.map((a) => a.id),
        needsSubagent: backupResult.needsSubagent,
      }));
    } catch {
      // non-fatal
    }

    // Allow the tool call, inject backup info as context
    const output: PreToolHookOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: contextMsg,
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  }

  // ── PASS ─────────────────────────────────────────────────────────
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[CHATS-Sandbox] PreToolUse error: ${err}\n`);
  process.exit(0); // Never block on internal errors
});
