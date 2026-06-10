/**
 * Policy rules vs. the naive baseline.
 *
 * "Round-trips correctly" is necessary but not sufficient — these tests
 * drive the REAL pipeline (runBackup → restoreActionDirect) and show the
 * tier-0 fs/git rules are concretely *better* than what the agent would
 * otherwise fall back to, on three measurable axes:
 *
 *   1. COVERAGE + DETERMINISM — for a mutation OUTSIDE the workspace the
 *      naive path can't snapshot it (the tier-2 shadow repo's work-tree is
 *      the workspace) and must escalate to a tier-3 LLM subagent; with the
 *      subagent off the data is simply lost. A policy rule recovers it
 *      deterministically with an exact shell inverse — no model call.
 *
 *   2. COST — moving a large file with the rule captures ~0 bytes (inode
 *      rename), whereas the naive tier-2 strategy that would protect the
 *      same file stores the entire blob in the shadow repo.
 *
 *   3. FIDELITY — the recovered bytes are identical to the originals.
 *
 * Everything below uses the shipping functions (runBackup, dirSize,
 * restoreActionDirect, listRestorableActions); nothing is reimplemented.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runBackup, resetAction, dirSize } from "../src/backup/strategies.js";
import { restoreActionDirect, listRestorableActions } from "../src/restore/restore.js";
import { DEFAULT_CONFIG, type HookContext, type SandboxConfig } from "../src/types.js";

function bash(command: string): HookContext {
  return { hook_event: "PreToolUse", tool_name: "Bash", tool_input: { command } };
}
function write(p: string, content: string): HookContext {
  return { hook_event: "PreToolUse", tool_name: "Write", tool_input: { file_path: p, content } };
}

let workspace: string;
let outside: string; // a directory OUTSIDE the workspace
let originalCwd: string;
let config: SandboxConfig;

beforeEach(() => {
  resetAction();
  originalCwd = process.cwd();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chats-ws-"));
  // NOT under /tmp: the pipeline treats /tmp as disposable scratch and
  // won't escalate for it, which would mask the tier-3 behavior we're
  // contrasting against. A real non-scratch location exercises the true
  // naive path (snapshot can't see it → escalate to subagent).
  outside = fs.mkdtempSync("/mnt/data/chats-outside-");
  process.chdir(workspace);
  config = {
    ...DEFAULT_CONFIG,
    backupDir: path.join(workspace, ".chats-sandbox", "backups"),
    maxActions: 20,
    // Tier-3 OFF so the naive arm's "escalate to an LLM" becomes a visible,
    // deterministic failure to recover rather than a live model call.
    subagentEnabled: false,
  };
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const d of [workspace, outside]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function restoreLatest(): void {
  const actions = listRestorableActions(config);
  assert.ok(actions.length > 0, "expected at least one restorable action");
  restoreActionDirect(actions[0].name, config);
}

// ── Axis 1: coverage + determinism on an OUT-OF-WORKSPACE mutation ────
//
// Both arms destroy the contents of the same out-of-workspace file. The
// policy rule (truncate) gives a deterministic exact recovery with no
// model. The naive baseline — an unhandled `>` redirect, which is what
// every such command did before these rules existed — cannot snapshot an
// out-of-workspace file and must escalate to the tier-3 subagent; with it
// off, the bytes are gone.

describe("policy vs naive: out-of-workspace coverage", () => {
  it("RULE arm: truncate outside the workspace recovers deterministically, no subagent", () => {
    const f = path.join(outside, "important.dat");
    const original = "IMPORTANT DATA — must survive\n";
    fs.writeFileSync(f, original);

    // The rule executes the truncate itself and records the inverse.
    const res = runBackup(bash(`truncate -s 0 ${f}`), config);

    assert.equal(res.artifacts.length, 1);
    assert.equal(res.artifacts[0].strategy, "policy_rewrite");
    assert.equal(res.needsSubagent, false, "must NOT need an LLM subagent");
    assert.ok(
      (res.artifacts[0].recoveryCommands ?? []).length > 0,
      "recovery is concrete shell commands, not a model prompt",
    );
    // The destructive op really happened (rule ran it).
    assert.equal(fs.statSync(f).size, 0);

    restoreLatest();
    assert.equal(fs.readFileSync(f, "utf8"), original, "byte-identical recovery");
  });

  it("NAIVE arm: unhandled out-of-workspace clobber needs an LLM; with it off, data is lost", () => {
    const f = path.join(outside, "important.dat");
    const original = "IMPORTANT DATA — must survive\n";
    fs.writeFileSync(f, original);

    // A `>` redirect matches no tier-0 rule — the pre-rules behavior.
    const res = runBackup(bash(`printf clobbered > ${f}`), config);

    // No deterministic artifact was captured for the outside file...
    assert.equal(res.artifacts.length, 0, "naive path captured nothing for it");
    // ...and the only recourse the pipeline has is the tier-3 subagent.
    assert.equal(res.needsSubagent, true, "naive path must escalate to an LLM");

    // Perform the op the pipeline left to the agent, then try to recover.
    fs.writeFileSync(f, "clobbered\n");
    const actions = listRestorableActions(config);
    for (const a of actions) restoreActionDirect(a.name, config);

    assert.notEqual(
      fs.readFileSync(f, "utf8"),
      original,
      "naive baseline cannot restore the out-of-workspace file",
    );
  });
});

// ── Axis 2: cost — O(1) capture vs full-blob snapshot ────────────────
//
// Move a large file. The mv rule renames the inode and captures ~0 bytes
// (no clobber → no copy). The naive strategy that would protect that same
// file is the tier-2 shadow-repo snapshot, which must store the whole blob.

describe("policy vs naive: capture cost on a large file", () => {
  const BIG = 4 * 1024 * 1024; // 4 MiB of incompressible random bytes

  it("RULE arm: mv captures ~0 bytes for a 4 MiB file", () => {
    const big = path.join(workspace, "big.bin");
    fs.writeFileSync(big, crypto.randomBytes(BIG));

    const res = runBackup(bash("mv big.bin moved.bin"), config);
    assert.equal(res.artifacts[0].strategy, "policy_rewrite");

    // The rule's artifact is the action's trash dir; no clobber → empty.
    const captured = dirSize(res.artifacts[0].artifactPath);
    assert.ok(
      captured < 64 * 1024,
      `mv should capture ~0 bytes, captured ${captured}`,
    );

    // ...and it still fully reverses.
    assert.ok(fs.existsSync("moved.bin") && !fs.existsSync("big.bin"));
    restoreLatest();
    assert.ok(fs.existsSync("big.bin") && !fs.existsSync("moved.bin"));
  });

  it("NAIVE arm: the tier-2 snapshot stores the whole 4 MiB blob", () => {
    const big = path.join(workspace, "big.bin");
    fs.writeFileSync(big, crypto.randomBytes(BIG));

    // Any in-workspace write triggers the tier-2 git_snapshot, which does
    // `git add -A` over the workspace — capturing big.bin's full blob.
    const res = runBackup(write(path.join(workspace, "trigger.txt"), "x"), config);
    const snap = res.artifacts.find((a) => a.strategy === "git_snapshot");
    assert.ok(snap, "expected a git_snapshot artifact");

    const stored = dirSize(snap!.artifactPath);
    assert.ok(
      stored > 3 * 1024 * 1024,
      `naive snapshot should store ~4 MiB, stored ${stored}`,
    );
  });
});

// ── Axis 3: fidelity on a clobbering move (both files survive) ───────

describe("policy vs naive: clobbering move fidelity", () => {
  it("RULE arm: mv over an existing file restores BOTH the source and the clobbered dest", () => {
    const src = path.join(workspace, "src.txt");
    const dst = path.join(workspace, "dst.txt");
    fs.writeFileSync(src, "SRC-payload\n");
    fs.writeFileSync(dst, "DST-original-must-survive\n");

    const res = runBackup(bash("mv src.txt dst.txt"), config);
    assert.equal(res.artifacts[0].strategy, "policy_rewrite");
    assert.equal(fs.readFileSync(dst, "utf8"), "SRC-payload\n");

    restoreLatest();
    assert.equal(fs.readFileSync(src, "utf8"), "SRC-payload\n");
    assert.equal(
      fs.readFileSync(dst, "utf8"),
      "DST-original-must-survive\n",
      "the clobbered destination is restored too",
    );
  });
});
