/**
 * List the tools an MCP server exposes, by talking to it directly over stdio
 * (JSON-RPC: initialize → tools/list). No SDK — the MCP stdio protocol is a
 * few line-delimited messages. Used to build the {server → tools} registry
 * AND, in self-exploration, to read the LIVE tool surface (name + description
 * + inputSchema) straight off the running server.
 *
 * As a CLI:
 *   node list_mcp_tools.js <command> [args...]   → prints tool NAMES (one/line)
 *   node list_mcp_tools.js --json <command> [args...]
 *                                                → prints JSON array of
 *                                                  {name, description, inputSchema}
 * As a module:
 *   listMcpTools(command, args, timeoutMs)      → Promise<string[]>   (names)
 *   listMcpToolsFull(command, args, timeoutMs)  → Promise<McpTool[]>  (full)
 */
import { spawn } from "node:child_process";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Talk to a stdio MCP server (initialize → tools/list) and return the FULL
 *  tool objects (name + description + inputSchema). */
export function listMcpToolsFull(
  command: string,
  args: string[],
  timeoutMs = 20000,
): Promise<McpTool[]> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (tools: McpTool[]) => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve(tools);
    };
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.id === 2 && m.result && Array.isArray(m.result.tools)) {
            finish(m.result.tools.map((t: McpTool) => ({
              name: t.name,
              description: typeof t.description === "string" ? t.description : undefined,
              inputSchema: (t as { inputSchema?: unknown }).inputSchema,
            })));
          }
        } catch { /* incomplete / non-JSON line */ }
      }
    });
    child.on("error", () => finish([]));
    const send = (o: unknown) => { try { child.stdin.write(JSON.stringify(o) + "\n"); } catch { /* ignore */ } };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "chats-sandbox", version: "1" } } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    }, 1000);
    setTimeout(() => finish([]), timeoutMs);
  });
}

export function listMcpTools(
  command: string,
  args: string[],
  timeoutMs = 20000,
): Promise<string[]> {
  return listMcpToolsFull(command, args, timeoutMs).then((tools) => tools.map((t) => t.name));
}

/** Call ONE tool on a stdio MCP server (initialize → tools/call) and resolve
 *  with the result object (or {error} on failure). Used by self-exploration's
 *  per-server RESET hook to seed a known sandbox state before each verify. */
export function callMcpTool(
  command: string,
  args: string[],
  toolName: string,
  toolArgs: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (out: { ok: boolean; result?: unknown; error?: string }) => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve(out);
    };
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.id === 3) {
            if (m.error) finish({ ok: false, error: JSON.stringify(m.error) });
            else finish({ ok: !(m.result && m.result.isError), result: m.result });
          }
        } catch { /* incomplete / non-JSON line */ }
      }
    });
    child.on("error", (e: Error) => finish({ ok: false, error: e.message }));
    const send = (o: unknown) => { try { child.stdin.write(JSON.stringify(o) + "\n"); } catch { /* ignore */ } };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "chats-sandbox", version: "1" } } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: toolName, arguments: toolArgs } });
    }, 1000);
    setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
  });
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  if (mode === "--json") {
    const [command, ...args] = argv.slice(1);
    listMcpToolsFull(command, args).then((tools) => {
      process.stdout.write(JSON.stringify(tools));
      process.exit(0);
    });
  } else if (mode === "--call") {
    // --call <tool> <jsonArgs> <command> [args...]
    const toolName = argv[1];
    let toolArgs: Record<string, unknown> = {};
    try { toolArgs = JSON.parse(argv[2] || "{}"); } catch { /* {} */ }
    const [command, ...args] = argv.slice(3);
    callMcpTool(command, args, toolName, toolArgs).then((out) => {
      process.stdout.write(JSON.stringify(out));
      process.exit(out.ok ? 0 : 1);
    });
  } else {
    const [command, ...args] = argv;
    listMcpTools(command, args).then((tools) => {
      process.stdout.write(tools.join("\n") + "\n");
      process.exit(0);
    });
  }
}
