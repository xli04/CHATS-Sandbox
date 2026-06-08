/**
 * Recovery experiences — per-MCP-server "easy-win" reversal patterns.
 *
 * Pulling remote content to local and recreating it (the default tier-3
 * Category F strategy) is expensive and lossy (new IDs, timestamp
 * drift). Many destructive remote actions have a far cheaper reversible
 * counterpart — e.g. "delete a post" → "set it to private/draft", which
 * preserves the original entity in place. This module stores those
 * model-extracted patterns per server and is read by the backup
 * subagent prompt so it prefers the cheap reversal when one applies.
 *
 * Modeled on NVIDIA ToolShield's per-server "experiences", but for
 * recoverability rather than safety.
 *
 * Stored at: .chats-sandbox/experiences/<server>.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SandboxConfig } from "../types.js";

export interface RecoveryPattern {
  /** The destructive / mutating action this covers. */
  action: string;
  /** The cheap reversible alternative + how to reverse it. */
  easy_win: string;
  /** Which tool(s) it applies to, if specific. */
  applies_to?: string;
  /** Stage 2 outcome: did a live agent actually confirm this works?
   *  true = verified against the real target, false = tried & failed,
   *  undefined = proposed only (no execution stage ran). */
  verified?: boolean;
  /** Stage 2 note — what the verifier observed. */
  verify_note?: string;
}

export interface ServerExperiences {
  server: string;
  generated: string;
  /** Tool names that were observed for this server (the basis of the scan). */
  observed_tools: string[];
  patterns: RecoveryPattern[];
}

export function experiencesDir(config: SandboxConfig): string {
  return path.join(path.dirname(path.resolve(config.backupDir)), "experiences");
}

export function experiencePath(config: SandboxConfig, server: string): string {
  return path.join(experiencesDir(config), `${server}.json`);
}

/**
 * Extract the MCP server name from a tool name.
 *   mcp__playwright__browser_click → "playwright"
 *   mcp__notion__create_page       → "notion"
 *   browser_click (bare, OpenHands) → "playwright" (the common browser MCP)
 * Returns null for non-remote tools.
 */
export function serverFromToolName(toolName: string): string | null {
  if (!toolName) return null;
  const m = toolName.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
  if (m) return m[1];
  if (/^browser_/.test(toolName)) return "playwright";
  return null;
}

export function loadExperiences(config: SandboxConfig, server: string): ServerExperiences | null {
  try {
    const p = experiencePath(config, server);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as ServerExperiences;
    return Array.isArray(data.patterns) ? data : null;
  } catch {
    return null;
  }
}

export function saveExperiences(config: SandboxConfig, data: ServerExperiences): string {
  const dir = experiencesDir(config);
  fs.mkdirSync(dir, { recursive: true });
  const p = experiencePath(config, data.server);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
  return p;
}

/**
 * Render a server's patterns as a prompt fragment to inject into the
 * backup subagent's Category F section. Empty string when none.
 */
export function renderExperiencesForPrompt(exp: ServerExperiences | null): string {
  if (!exp || !exp.patterns.length) return "";
  // Surface verified patterns first; never inject ones that failed
  // verification.
  const usable = exp.patterns.filter((p) => p.verified !== false);
  if (!usable.length) return "";
  usable.sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0));
  const lines = usable.map((p, i) => {
    const tag = p.verified ? " [verified]" : " [proposed]";
    return `  ${i + 1}.${tag} ${p.action}\n     → EASY-WIN: ${p.easy_win}`;
  });
  return `
## KNOWN EASY-WIN REVERSAL PATTERNS for the "${exp.server}" server

These cheap reversible alternatives were learned for this server. When
the upcoming action matches one, PREFER the easy-win reversal over a
full scrape-and-recreate — it is cheaper and avoids identity drift
(new IDs / timestamps). Record the easy-win as your recovery_commands.

${lines.join("\n")}

Only fall back to scrape-content-and-recreate when none of the above
applies to the upcoming action.
`;
}
