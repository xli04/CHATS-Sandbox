/**
 * MCP scanning for self-exploration.
 *
 * Tool acquisition is LIVE: read the runner's MCP config (~/.hermes/config.yaml)
 * and ask each server's real connection (initialize → tools/list) for its full
 * tool surface (name + description + schema). No backup-history / cached-registry
 * path — exploration reflects the ACTUAL tools, not what prior runs called.
 *
 * Also scans backup history for the remote target (origin URL) a server was used
 * against, so the verify stage probes the real system.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import type { SandboxConfig } from "../dist/types.js";
import type { McpTool } from "../dist/explore/list_mcp_tools.js";
import { experiences } from "./infra.js";
import type { McpServerDef } from "./types.js";

const { serverFromToolName } = experiences;

/** Lazy-load js-yaml (external dep; may be absent). */
function loadYaml(): { load: (s: string) => unknown } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("js-yaml");
  } catch { return null; }
}

/** Read the MCP config the runner uses. For the hermes runner that's
 *  `~/.hermes/config.yaml` under `mcp_servers.<name>`. Returns the raw
 *  {name → def} map, or {} if unreadable. */
export function readMcpServers(): Record<string, McpServerDef> {
  const cfgPath = path.join(
    process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"),
    "config.yaml",
  );
  const yaml = loadYaml();
  if (!yaml) return {};
  try {
    const cfg = (yaml.load(fs.readFileSync(cfgPath, "utf-8")) ?? {}) as { mcp_servers?: Record<string, McpServerDef> };
    return cfg.mcp_servers ?? {};
  } catch { return {}; }
}

/** Resolve the path to the compiled list_mcp_tools CLI (lives in the MAIN build
 *  at dist/explore/list_mcp_tools.js; this module is at dist/self-exploration). */
export function listToolsCliPath(): string {
  return path.join(__dirname, "..", "explore", "list_mcp_tools.js");
}

/** Live tools/list for a STDIO MCP server — runs the CLI synchronously
 *  (execFileSync) so it slots into the sync runExplore. Returns full tool
 *  objects (name + description + inputSchema). Throws on failure. */
function liveToolsStdio(def: McpServerDef): McpTool[] {
  const out = execFileSync(
    process.execPath,
    [listToolsCliPath(), "--json", def.command!, ...(def.args ?? [])],
    { encoding: "utf-8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out) as McpTool[];
  if (!Array.isArray(parsed)) throw new Error("non-array tools/list");
  return parsed;
}

/** Live tools/list for an HTTP MCP server — POST initialize then tools/list to
 *  the url via curl (synchronous). Carries the mcp-session-id from initialize.
 *  Accept: application/json, text/event-stream. Throws on failure. */
function liveToolsHttp(def: McpServerDef): McpTool[] {
  const url = def.url!;
  const accept = "application/json, text/event-stream";
  const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "chats-sandbox", version: "1" } } });
  // -i to capture response headers (for mcp-session-id).
  const initRaw = execFileSync("curl", [
    "-sS", "-i", "-X", "POST", url,
    "-H", "Content-Type: application/json",
    "-H", `Accept: ${accept}`,
    "-d", initBody,
  ], { encoding: "utf-8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const sid = (initRaw.match(/^mcp-session-id:\s*(.+)$/im)?.[1] ?? "").trim();
  const listBody = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const headers = [
    "-H", "Content-Type: application/json",
    "-H", `Accept: ${accept}`,
  ];
  if (sid) { headers.push("-H", `mcp-session-id: ${sid}`); }
  const listRaw = execFileSync("curl", [
    "-sS", "-X", "POST", url, ...headers, "-d", listBody,
  ], { encoding: "utf-8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  // Response may be plain JSON or an SSE stream (`data: {...}` lines).
  const msg = parseJsonOrSse(listRaw);
  const tools = (msg?.result as { tools?: McpTool[] } | undefined)?.tools;
  if (!Array.isArray(tools)) throw new Error("HTTP tools/list returned no tools");
  return tools.map((t) => ({ name: t.name, description: typeof t.description === "string" ? t.description : undefined, inputSchema: (t as { inputSchema?: unknown }).inputSchema }));
}

/** Parse a JSON-RPC response that may be either bare JSON or an SSE stream. */
function parseJsonOrSse(raw: string): { result?: unknown } | null {
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed) as { result?: unknown }; } catch { /* try SSE */ }
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.+)$/);
    if (m) { try { return JSON.parse(m[1]) as { result?: unknown }; } catch { /* next */ } }
  }
  return null;
}

/** Get the LIVE tool surface for a server from the real MCP connection
 *  (initialize → tools/list). stdio → spawn command/args; http → curl url.
 *  Returns full tool objects. Throws on failure (caller skips the server). */
export function liveToolsForServer(def: McpServerDef): McpTool[] {
  if (def.url) return liveToolsHttp(def);
  if (def.command) return liveToolsStdio(def);
  throw new Error("server def has neither command nor url");
}

/** Scan backup history → map of server → observed tool names. */
export function discoverServers(config: SandboxConfig): Map<string, Set<string>> {
  const servers = new Map<string, Set<string>>();
  const backupRoot = path.resolve(config.backupDir);
  if (!fs.existsSync(backupRoot)) return servers;
  for (const d of fs.readdirSync(backupRoot).filter((x) => x.startsWith("action_"))) {
    const meta = path.join(backupRoot, d, "metadata.json");
    if (!fs.existsSync(meta)) continue;
    try {
      const arr = JSON.parse(fs.readFileSync(meta, "utf-8")) as Array<Record<string, unknown>>;
      for (const a of arr) {
        const tn = typeof a.toolName === "string" ? a.toolName : "";
        const server = serverFromToolName(tn);
        if (!server) continue;
        if (!servers.has(server)) servers.set(server, new Set());
        servers.get(server)!.add(tn);
      }
    } catch { /* skip */ }
  }
  return servers;
}

/** Scan backup history for the remote target (origin URL) this server
 *  was used against — so the explorer probes the real system. */
export function discoverTarget(config: SandboxConfig, server: string): string | null {
  const backupRoot = path.resolve(config.backupDir);
  if (!fs.existsSync(backupRoot)) return null;
  const origins = new Map<string, number>();
  const scan = (text: string): void => {
    const re = /https?:\/\/[^\s"'<>)]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      try {
        const u = new URL(m[0]);
        const origin = u.origin;
        origins.set(origin, (origins.get(origin) ?? 0) + 1);
      } catch { /* skip */ }
    }
  };
  for (const d of fs.readdirSync(backupRoot).filter((x) => x.startsWith("action_"))) {
    for (const f of ["remote-state.json", "instruction.txt"]) {
      const p = path.join(backupRoot, d, f);
      if (fs.existsSync(p)) {
        try { scan(fs.readFileSync(p, "utf-8")); } catch { /* */ }
      }
    }
  }
  let best: string | null = null;
  let max = 0;
  for (const [o, n] of origins) {
    // Skip obvious non-targets (the LLM/provider endpoints).
    if (/openrouter|anthropic|githubusercontent|openai\.com/.test(o)) continue;
    if (n > max) { max = n; best = o; }
  }
  return best;
}
