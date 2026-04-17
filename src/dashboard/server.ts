/**
 * Dashboard HTTP server — serves a local UI at http://localhost:<port>
 * for browsing CHATS-Sandbox actions and editing configuration.
 *
 * Uses Node's built-in http module. No external dependencies.
 * Only listens on 127.0.0.1 (never exposed externally).
 *
 * API:
 *   GET  /                 - serves the dashboard HTML page
 *   GET  /api/actions      - list of actions with metadata + instruction + files
 *   GET  /api/config       - current sandbox config
 *   POST /api/config       - update sandbox config
 *   GET  /api/status       - aggregate status (counts, flags)
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { SandboxConfig } from "../types.js";
import { loadConfig, saveConfig } from "../config/load.js";

interface ActionSummary {
  name: string;
  seq: number;
  timestamp: string;
  timeFormatted: string;
  instruction: string;
  strategies: string[];
  files: string[];
  stats: string;
  toolName: string;
  originalAction: string;
}

const DEFAULT_PORT = 7321;

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pkgRoot: string,
): boolean {
  // Map / → index.html
  let reqPath = req.url ?? "/";
  if (reqPath === "/") reqPath = "/index.html";

  // Security: strip query, reject path traversal
  reqPath = reqPath.split("?")[0];
  if (reqPath.includes("..")) {
    res.writeHead(400);
    res.end("bad request");
    return true;
  }

  const staticDir = path.join(pkgRoot, "dashboard", "static");
  const filePath = path.join(staticDir, reqPath);

  if (!filePath.startsWith(staticDir)) {
    res.writeHead(400);
    res.end("bad request");
    return true;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }

  const ext = path.extname(filePath);
  const ctype = ext === ".html" ? "text/html; charset=utf-8"
    : ext === ".js" ? "application/javascript; charset=utf-8"
      : ext === ".css" ? "text/css; charset=utf-8"
        : "application/octet-stream";

  res.writeHead(200, { "content-type": ctype });
  res.end(fs.readFileSync(filePath));
  return true;
}

// ── API handlers ─────────────────────────────────────────────────────

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function buildActionSummary(
  backupRoot: string,
  dirName: string,
  cwd: string,
): ActionSummary {
  const dir = path.join(backupRoot, dirName);
  const metaPath = path.join(dir, "metadata.json");
  const instructionPath = path.join(dir, "instruction.txt");

  // Parse seq and timestamp from dir name: action_NNN_YYYYMMDDHHMMSS
  const parts = dirName.split("_");
  const seq = parseInt(parts[1] ?? "0", 10);
  const tsRaw = parts.slice(2).join("_");
  const timeFormatted = tsRaw.length >= 14
    ? `${tsRaw.slice(0, 4)}-${tsRaw.slice(4, 6)}-${tsRaw.slice(6, 8)} ${tsRaw.slice(8, 10)}:${tsRaw.slice(10, 12)}`
    : tsRaw;

  let instruction = "";
  try {
    if (fs.existsSync(instructionPath)) {
      instruction = fs.readFileSync(instructionPath, "utf-8").trim();
    }
  } catch { /* */ }

  const artifacts: Array<Record<string, unknown>> = [];
  try {
    if (fs.existsSync(metaPath)) {
      artifacts.push(...JSON.parse(fs.readFileSync(metaPath, "utf-8")));
    }
  } catch { /* */ }

  const strategies = artifacts.map((a) => String(a.strategy ?? "")).filter(Boolean);
  const toolName = artifacts[0] ? String(artifacts[0].toolName ?? "") : "";
  const originalAction = artifacts[0] ? String(artifacts[0].originalAction ?? "") : "";

  // Get files + stats from the shared shadow repo (if we have a commit)
  let files: string[] = [];
  let stat = "";
  const snapshot = artifacts.find((a) => a.strategy === "git_snapshot");
  if (snapshot) {
    const commit = String(snapshot.commitHash ?? snapshot.id ?? "");
    const shadowDir = String(snapshot.artifactPath ?? "");
    if (commit && fs.existsSync(shadowDir)) {
      try {
        const env = { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: cwd };
        const opts = { encoding: "utf-8" as const, timeout: 10_000, env, cwd, stdio: "pipe" as const };
        const fileOut = execSync(`git show --name-only --format= ${commit}`, opts).trim();
        files = fileOut.split("\n").filter((f: string) => f.length > 0);
        stat = execSync(`git diff --shortstat ${commit}~1 ${commit}`, opts).trim();
      } catch {
        try {
          const env = { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: cwd };
          const opts = { encoding: "utf-8" as const, timeout: 10_000, env, cwd, stdio: "pipe" as const };
          const fileOut = execSync(`git ls-tree -r --name-only ${commit}`, opts).trim();
          files = fileOut.split("\n").filter((f: string) => f.length > 0).slice(0, 10);
          stat = `baseline snapshot (${files.length} files)`;
        } catch {
          /* give up */
        }
      }
    }
  }

  // Timestamp for sorting
  const timestamp = (artifacts[0] && typeof artifacts[0].timestamp === "string")
    ? artifacts[0].timestamp as string
    : new Date().toISOString();

  return {
    name: dirName,
    seq,
    timestamp,
    timeFormatted,
    instruction,
    strategies,
    files,
    stats: stat,
    toolName,
    originalAction,
  };
}

function handleGetActions(
  res: http.ServerResponse,
  config: SandboxConfig,
  cwd: string,
): void {
  const backupRoot = path.resolve(config.backupDir);
  if (!fs.existsSync(backupRoot)) {
    jsonResponse(res, 200, { actions: [] });
    return;
  }

  const dirs = fs.readdirSync(backupRoot)
    .filter((d: string) => d.startsWith("action_"))
    .sort();

  const actions = dirs.map((d) => buildActionSummary(backupRoot, d, cwd));
  jsonResponse(res, 200, { actions });
}

function handleGetConfig(res: http.ServerResponse, config: SandboxConfig): void {
  jsonResponse(res, 200, config);
}

function handlePostConfig(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  projectRoot: string,
): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf-8");
    let updates: Partial<SandboxConfig>;
    try {
      updates = JSON.parse(raw);
    } catch {
      jsonResponse(res, 400, { error: "invalid JSON" });
      return;
    }

    // Validate individual fields
    if (updates.backupMode && !["always", "smart", "off"].includes(updates.backupMode)) {
      jsonResponse(res, 400, { error: "invalid backupMode" });
      return;
    }
    if (updates.subagentModel && !["haiku", "sonnet", "opus", "inherit"].includes(updates.subagentModel)) {
      jsonResponse(res, 400, { error: "invalid subagentModel" });
      return;
    }
    if (updates.subagentPermissionMode && !["bypassPermissions", "acceptEdits"].includes(updates.subagentPermissionMode)) {
      jsonResponse(res, 400, { error: "invalid subagentPermissionMode" });
      return;
    }

    try {
      saveConfig(updates, projectRoot);
      jsonResponse(res, 200, { saved: true, config: loadConfig(projectRoot) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      jsonResponse(res, 500, { error: `save failed: ${msg}` });
    }
  });
}

function handleGetStatus(
  res: http.ServerResponse,
  config: SandboxConfig,
): void {
  const backupRoot = path.resolve(config.backupDir);
  let actionCount = 0;
  if (fs.existsSync(backupRoot)) {
    actionCount = fs.readdirSync(backupRoot)
      .filter((d: string) => d.startsWith("action_"))
      .length;
  }
  jsonResponse(res, 200, {
    enabled: config.enabled,
    backupMode: config.backupMode,
    actionCount,
    maxActions: config.maxActions,
    subagentEnabled: config.subagentEnabled,
    subagentModel: config.subagentModel,
    subagentPermissionMode: config.subagentPermissionMode,
  });
}

// ── Server ───────────────────────────────────────────────────────────

export function startDashboard(options: {
  projectRoot: string;
  port?: number;
  pkgRoot: string;
  /** If true, try subsequent ports when the preferred one is busy. Default: true when no explicit port. */
  autoPort?: boolean;
  /** Max number of port candidates to try when autoPort is on. Default: 10. */
  maxPortAttempts?: number;
}): Promise<{ port: number; close: () => void }> {
  const requestedPort = options.port ?? DEFAULT_PORT;
  const autoPort = options.autoPort ?? options.port === undefined;
  const maxAttempts = options.maxPortAttempts ?? 10;
  const projectRoot = options.projectRoot;

  const server = http.createServer((req, res) => {
    // Only allow local connections for safety
    const remote = req.socket.remoteAddress ?? "";
    if (!remote.includes("127.0.0.1") && !remote.includes("::1") && remote !== "::ffff:127.0.0.1") {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const config = loadConfig(projectRoot);

    // API routes
    if (url === "/api/actions" && method === "GET") {
      handleGetActions(res, config, projectRoot);
      return;
    }
    if (url === "/api/config" && method === "GET") {
      handleGetConfig(res, config);
      return;
    }
    if (url === "/api/config" && method === "POST") {
      handlePostConfig(req, res, projectRoot);
      return;
    }
    if (url === "/api/status" && method === "GET") {
      handleGetStatus(res, config);
      return;
    }

    // Static files
    if (method === "GET") {
      if (serveStatic(req, res, options.pkgRoot)) return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (port: number): void => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE" && autoPort && attempt < maxAttempts - 1) {
          attempt++;
          tryListen(port + 1);
          return;
        }
        if (err.code === "EADDRINUSE") {
          const hint = autoPort
            ? `tried ${requestedPort}–${requestedPort + attempt}, all busy`
            : `port ${port} is already in use (another dashboard, or a different process)`;
          reject(new Error(`Could not start dashboard: ${hint}. ` +
            `Pass --port <N> to pick a different port, or stop the other process.`));
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve({
          port,
          close: () => server.close(),
        });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    };
    tryListen(requestedPort);
  });
}
