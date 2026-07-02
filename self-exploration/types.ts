/** Local types for the self-exploration pipeline. */

import type { RecoveryPattern } from "../dist/explore/experiences.js";

/** A stdio MCP server (command + args) or an HTTP MCP server (url). */
export interface McpServerDef {
  command?: string;
  args?: string[];
  url?: string;
  enabled?: boolean;
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
