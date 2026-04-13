#!/usr/bin/env node
/**
 * UserPromptSubmit hook — fires once per user message in Claude Code.
 *
 * Captures the user's prompt text and writes it to a sidecar file
 * (.chats-sandbox/current-instruction.txt). The pre-tool hook reads
 * this file when materializing an action folder and copies the
 * instruction into the folder's metadata, so `chats-sandbox history`
 * can show the user what they were asking for.
 *
 * Truncated to ~200 chars to keep the file small. The full prompt is
 * never stored (we don't want a transcript log).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../config/load.js";

interface PromptContext {
  hook_event?: string;
  prompt?: string;
  user_prompt?: string;
  message?: string;
}

const MAX_LEN = 200;

async function main(): Promise<void> {
  // Recursion guard: if we're inside a sandbox-spawned subagent, exit.
  if (process.env.CHATS_SANDBOX_NO_HOOK === "1") {
    process.exit(0);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");

  let ctx: PromptContext;
  try {
    ctx = JSON.parse(raw) as PromptContext;
  } catch {
    process.exit(0);
  }

  const config = loadConfig();
  if (!config.enabled) {
    process.exit(0);
  }

  // Try multiple field names — Claude Code's UserPromptSubmit context
  // shape may vary across versions.
  const promptText =
    String(ctx.prompt ?? ctx.user_prompt ?? ctx.message ?? "").trim();

  if (!promptText) {
    process.exit(0);
  }

  // Truncate to MAX_LEN chars, single line, with ellipsis if shortened
  const singleLine = promptText.replace(/\s+/g, " ");
  const truncated =
    singleLine.length > MAX_LEN
      ? singleLine.slice(0, MAX_LEN) + "..."
      : singleLine;

  // Write to .chats-sandbox/current-instruction.txt — overwrites the
  // previous prompt (one current instruction at a time).
  try {
    const sandboxDir = path.dirname(path.resolve(config.backupDir));
    if (!fs.existsSync(sandboxDir)) {
      fs.mkdirSync(sandboxDir, { recursive: true });
    }
    const instructionFile = path.join(sandboxDir, "current-instruction.txt");
    fs.writeFileSync(instructionFile, truncated, "utf-8");
  } catch {
    // best-effort; never block on this
  }

  process.exit(0);
}

main().catch(() => {
  process.exit(0); // never block on internal errors
});
