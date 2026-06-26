/**
 * Watcher wrapper for the backup subagent.
 *
 * The subagent's deliverable is a result file (`subagent_result.json`), and
 * it performs the actual backup BEFORE writing that file. So once a VALID
 * result file exists, the backup is done and every further LLM turn is pure
 * latency (the "post-backup tail" — ~40-80s of the model verifying / re-
 * reading / finalising). This wrapper runs the subagent and TERMINATES it
 * the instant the result file appears and parses — a discrete, validated
 * filesystem event, far more reliable than watching the runner's buffered,
 * TUI-decorated stdout.
 *
 * Usage:  node subagent_watch.js <resultFile> <timeoutMs> <bin> [args...]
 *
 * The child inherits this process's stdout/stderr, so the parent's
 * execFileSync still captures the runner output for fallback parsing.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";

const [resultFile, timeoutStr, bin, ...args] = process.argv.slice(2);
const timeoutMs = Math.max(5000, parseInt(timeoutStr || "120000", 10) || 120000);

// Remove a stale result file so we only react to THIS run's write.
try { fs.rmSync(resultFile, { force: true }); } catch { /* */ }

const child = spawn(bin, args, { stdio: ["pipe", "inherit", "inherit"] });
try { child.stdin?.end(); } catch { /* */ }

let finished = false;
function finish(code: number): void {
  if (finished) return;
  finished = true;
  clearInterval(poll);
  clearTimeout(deadline);
  process.exit(code);
}
function killChild(): void {
  try { child.kill("SIGTERM"); } catch { /* */ }
  setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } }, 800);
}

/** A complete, shaped result — not a half-written draft. */
function resultValid(): boolean {
  try {
    const o = JSON.parse(fs.readFileSync(resultFile, "utf-8")) as Record<string, unknown>;
    return !!o && typeof o === "object" &&
      (Array.isArray(o.recovery_commands) || o.no_backup_needed === true);
  } catch { return false; }
}

// Require TWO consecutive valid reads (~0.6s) so we never catch a file the
// model is still mid-writing (a partial write won't parse anyway).
let stableHits = 0;
const poll = setInterval(() => {
  if (resultValid()) {
    if (++stableHits >= 2) { killChild(); setTimeout(() => finish(0), 1200); }
  } else {
    stableHits = 0;
  }
}, 300);

const deadline = setTimeout(() => { killChild(); setTimeout(() => finish(0), 1200); }, timeoutMs);

child.on("exit", (code) => finish(code ?? 0));
child.on("error", () => finish(1));
// If the parent terminates us, take the child down too (no orphans).
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => { killChild(); finish(0); });
}
