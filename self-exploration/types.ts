/** Local types for the self-exploration pipeline. */

import type { RecoveryPattern } from "../dist/explore/experiences.js";

/** A stdio MCP server (command + args) or an HTTP MCP server (url). */
export interface McpServerDef {
  command?: string;
  args?: string[];
  url?: string;
  enabled?: boolean;
}

/** A proposed/verified read-only affordance for the read-only list. */
export interface ReadOnlyTemplate {
  /** The keyword/phrase the gate substring-matches in an action's label. */
  match: string;
  /** Why it commits nothing (human-eyeball + verify note). */
  why?: string;
  /** Did the live verify pass confirm it changed nothing? */
  verified?: boolean;
}

/** A pattern carrying the transient stage-2 verdict (keep/adjust/delete). The
 *  verdict is consumed by the accumulate loop and not persisted to disk. */
export type VerdictPattern = RecoveryPattern & { verdict?: string };

export interface ExploreOutcome {
  server: string;
  tools: string[];
  target: string | null;
  saved: boolean;
  path?: string;
  proposed: number;
  verified: number;
  error?: string;
}
