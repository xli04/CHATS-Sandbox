/**
 * List the tools an MCP server exposes, by talking to it directly over stdio
 * (JSON-RPC: initialize → tools/list). No SDK — the MCP stdio protocol is a
 * few line-delimited messages. Used to build the {server → tools} registry.
 *
 * As a CLI: `node list_mcp_tools.js <command> [args...]` → prints tool names.
 * As a module: `listMcpTools(command, args, timeoutMs)` → Promise<string[]>.
 */
import { spawn } from "node:child_process";

export function listMcpTools(
  command: string,
  args: string[],
  timeoutMs = 20000,
): Promise<string[]> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (tools: string[]) => {
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
            finish(m.result.tools.map((t: { name: string }) => t.name));
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

if (require.main === module) {
  const [, , command, ...args] = process.argv;
  listMcpTools(command, args).then((tools) => {
    process.stdout.write(tools.join("\n") + "\n");
    process.exit(0);
  });
}
