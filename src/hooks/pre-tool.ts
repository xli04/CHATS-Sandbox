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
import * as path from "node:path";
import { loadConfig } from "../config/load.js";
import { evaluate } from "../engine/rules.js";
import { runBackup } from "../backup/strategies.js";
import type { PreToolHookOutput } from "../types.js";
import {
  type HookContext,
  type HookDialect,
  detectHookDialect,
  normalizeHookContext,
} from "../types.js";

async function main(): Promise<void> {
  // Recursion guard: if we're running inside a subagent that we spawned,
  // exit immediately to avoid infinite recursion (subagent tool calls
  // would otherwise fire this hook again).
  if (process.env.CHATS_SANDBOX_NO_HOOK === "1") {
    process.exit(0);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");

  let ctx: HookContext;
  let dialect: HookDialect = "claude";
  try {
    const parsed = JSON.parse(raw);
    dialect = detectHookDialect(parsed);
    ctx = normalizeHookContext(parsed);
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
    if (dialect === "cursor") {
      // Cursor's hook contract: top-level permission + messages.
      process.stdout.write(JSON.stringify({
        continue: false,
        permission: "deny",
        user_message: `[CHATS-Sandbox] ${result.reason}`,
        agent_message: `[CHATS-Sandbox] ${result.reason}`,
      }));
      process.exit(2);
    }
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

    // Backup latency: the time this hook held up the agent between
    // emitting the tool call and its execution — process birth (node
    // boot included) to now. The user-facing "cost of safety" number.
    // Recorded only when an action was actually created.
    if (backupResult.actionDir) {
      try {
        fs.writeFileSync(
          path.join(backupResult.actionDir, "timing.json"),
          JSON.stringify({
            addedLatencyMs: Math.round(Date.now() - performance.timeOrigin),
            recordedAt: new Date().toISOString(),
          }),
        );
      } catch { /* non-fatal */ }
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

    // Session sidecar for the dashboard. UserPromptSubmit also writes
    // this (with the prompt text), but not every agent wires that hook
    // — updating it here too means session identity works everywhere.
    try {
      const pathMod = require("node:path") as typeof import("node:path");
      const sandboxDir = pathMod.dirname(pathMod.resolve(config.backupDir));
      const sessionFile = pathMod.join(sandboxDir, "session.json");
      let prev: Record<string, unknown> = {};
      try { prev = JSON.parse(fs.readFileSync(sessionFile, "utf-8")); } catch { /* fresh */ }
      fs.writeFileSync(sessionFile, JSON.stringify({
        ...prev,
        session_id: ctx.session_id ?? prev.session_id ?? null,
        dialect,
        ts: new Date().toISOString(),
      }, null, 2) + "\n", "utf-8");
    } catch {
      // non-fatal
    }

    // Allow the tool call, inject backup info as context.
    // If a tier-0 policy rule rewrote the command (e.g. rm → mv to trash),
    // propagate the updatedInput so the agent runs the rewritten form.
    if (dialect === "cursor") {
      // Cursor's preToolUse contract: top-level permission, snake_case
      // updated_input, agent_message for context.
      process.stdout.write(JSON.stringify({
        continue: true,
        permission: "allow",
        agent_message: contextMsg,
        ...(backupResult.updatedInput ? { updated_input: backupResult.updatedInput } : {}),
      }));
      process.exit(0);
    }
    const output: PreToolHookOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: contextMsg,
        ...(backupResult.updatedInput ? { updatedInput: backupResult.updatedInput } : {}),
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
