# CHATS-Sandbox: Backup Trigger Logic & the Tier-3 Over-Firing Fix

A detailed walk-through of how the plugin decides what to back up and
how, the bug a SWE-bench stress test exposed in that decision logic, and
the minimal fix that was shipped. All claims are tied to specific files
and lines in the repository.

---

## 1. Context

### 1.1 What the system is

CHATS-Sandbox is a backup/recovery plugin that sits between a coding
agent (Claude Code, Hermes, OpenClaw, OpenHands, Codex, Cursor) and the
tools it calls. Every time the agent is about to run a *mutating* tool
call, the host's **PreToolUse hook** invokes the plugin first. The
plugin makes a reversible backup of whatever the action is about to
change, then lets the action proceed. If the user later wants to undo,
`chats-sandbox restore <N>` replays the inverse.

The design goal is that the cost of this safety net scales with the
*change*, not with the *workspace* — so it stays cheap on large repos
where naive "copy everything" or "snapshot the whole tree every action"
baselines blow up.

### 1.2 The four-tier backup ladder

The plugin chooses the cheapest backup that can cover a given action,
escalating only when a cheaper tier cannot. The tiers, cheapest first:

| Tier | Name | Mechanism | Cost | Code |
|------|------|-----------|------|------|
| **T0** | policy rewrite | rewrite the destructive command into a reversible one (`rm x` → move `x` to a per-action trash dir) before it runs | O(1) — an inode rename; no content copy | `src/backup/policy_rules.ts`, `src/backup/policy_rules_extra.ts` |
| **T1** | manifest | record a recipe of the affected environment (`pip freeze`, `npm list`, env vars, git tag) | a few KB | `tryTargetedManifest` in `src/backup/strategies.ts` |
| **T2** | snapshot | `git add -A` the workspace into a shared shadow git repo before the action | O(changes), deduplicated + compressed | `gitSnapshotBackup` in `src/backup/strategies.ts` |
| **T3** | subagent | spawn an LLM subagent to capture state that lives **outside** the workspace (remote services, system files, databases) and record recovery commands | a full agent session — **tens of seconds** | `runSubagentBackup` in `src/backup/subagent.ts` |

T0–T2 are deterministic and cheap. **T3 is the expensive tier**: it
exists only because T0–T2 can see nothing outside the current workspace
directory, so when an action touches outside state the only option is to
ask a model to figure out how to back it up. Each T3 firing is a
blocking `claude -p` / `hermes` subprocess.

### 1.3 Instrumentation added for this investigation

To measure the *time* cost of safety, every action now records the
latency the hook added between the agent emitting a tool call and the
tool executing — process birth to hook completion — appended to one
ledger, `.chats-sandbox/backup-timings.jsonl`, written in
`src/hooks/pre-tool.ts` (the `addedLatencyMs` field). The ledger lives
at the sandbox root, *outside* `backups/`, so it never counts toward
storage accounting. This is what made the bug below measurable.

### 1.4 How the bug surfaced

A SWE-bench Verified stress harness (`benchmarks/swe-runner.sh`,
`benchmarks/results/swe-validate.csv`) ran real repositories (django,
requests, sphinx, pytest, …) under the plugin, driven by
hermes/deepseek-v4-flash. Five of six instances behaved well. The
`pytest-dev__pytest-6202` instance recorded **774 s of backup latency
and 14.5 MB of backup storage for a single run** — wildly out of line.
Forensics traced the entire cost to **7 tier-3 subagent firings
(40–130 s each)**, plus one subagent that stored an **11.4 MB
`git bundle` of the whole repo**. That investigation is what this report
documents.

---

## 2. Our logic — the trigger pipeline, in detail

Everything below happens inside one function: `runBackup(ctx, config)`
in `src/backup/strategies.ts:766`. It runs synchronously inside the
PreToolUse hook, so the agent's tool call is blocked until it returns.

### 2.0 Pre-flight: the hook itself

`src/hooks/pre-tool.ts` is the entry point. Two gates run before any
backup logic:

1. **Recursion guard** (`pre-tool.ts:36`): if
   `CHATS_SANDBOX_NO_HOOK === "1"`, the hook exits immediately. This is
   set in the subagent's own environment (`subagentEnv()`,
   `src/backup/subagent.ts:63`) so that a T3 subagent's own tool calls
   do **not** recursively re-trigger the hook. (This is why the 11.4 MB
   bundle was *not* recursion — it was the subagent deliberately
   choosing `git bundle` as its backup artifact.)
2. **Policy evaluation** (`pre-tool.ts:34`, `evaluate()` in
   `src/engine/rules.ts`): decides `deny` / `backup` / `allow`. On
   `backup`, control passes to `runBackup`.

### 2.1 Short-circuits — actions that need no backup

`runBackup` first rules out actions that cannot mutate anything, so they
never create folders or pay any cost (`strategies.ts:775–815`):

- **Read-only tools** — `Read`, `Glob`, `Grep`, etc. (`READ_ONLY_TOOLS`).
- **Read-only MCP verbs** — `*_get`, `*_list`, `browser_navigate`,
  `browser_snapshot`, etc. (`isReadOnlyMcpTool`).
- **Read-only Bash** — `which`, `ls`, `stat`, `git status`, `pip list`,
  etc. (`isReadOnlyBash`). This guard exists specifically so that a
  harmless `which node` does not trip the outside-workspace heuristic
  and fire a ~25 s subagent for nothing.

### 2.2 Tier 0 — policy rewrite (terminating)

`strategies.ts:822`. `applyPolicyRules(ctx, trashDir)`
(`src/backup/policy_rules.ts:268`) tries each rule in `POLICY_RULES` +
`EXTRA_RULES`. The ruleset covers the common destructive verbs:
`rm-to-trash`, `mv-overwrite`, `chmod`, `chown`, `git-reset-hard`,
`git-push-force`, `git-branch-delete-force`, `git-stash-drop`,
`docker-rm`, `docker-image-rm`, `docker-volume-rm`, `kubectl-delete`,
`outside-workspace-write-new`, plus the `sed -i` / `truncate` family.

If a rule matches, the destructive command is **rewritten** into a
reversible equivalent (e.g. `rm x` becomes a move of `x` into
`.chats-sandbox/backups/action_NNN/trash/`), the rewritten command is
returned as `updatedInput`, and **tier 0 terminates the pipeline**
(`strategies.ts:858`, `return result`). No snapshot, no subagent — the
file is already safe in trash and restore is an exact `mv` back. This is
the O(1) path: renaming an inode is independent of file size.

### 2.3 The escalation decision — `touchesOutsideWorkspace`

If no T0 rule fired, the pipeline computes one boolean that governs
whether the expensive tier will run:

```
const outsideWorkspace = touchesOutsideWorkspace(ctx);   // strategies.ts:847
```

`touchesOutsideWorkspace` (`strategies.ts:600`) returns true when the
action appears to affect state outside the current workspace directory.
It checks, in order:

1. **MCP tools** whose verb isn't recognized read-only → true (remote
   state we can't capture locally).
2. **Explicit path arguments** (`input.path`, `input.file_path`,
   `input.target`, `input.destination`) that resolve outside the
   workspace → true.
3. **Bash commands** matching `outsidePatterns` — a precise list of
   genuinely out-of-workspace verbs: `pip/npm/apt/brew install`,
   `git push/fetch/pull`, `curl -X POST|PUT|DELETE`, `wget`, `ssh`,
   `scp`, `docker run/stop/rm`, `kubectl apply/delete`, `systemctl`,
   `export`/`unset`/`source` → true.
4. **Bash commands containing any absolute path** (≥2 segments, not
   under `/dev`, `/proc`, `/tmp`) that resolves outside the workspace →
   true. This is the broad catch-all for direct writes the verb list
   doesn't enumerate.

### 2.4 Tiers 2 → 1 → 3, in execution order

After the boolean is computed (`strategies.ts:849` onward):

- **T2 first** (`gitSnapshotBackup`, `strategies.ts:851`): runs the
  `git add -A` snapshot. It's the cheap workspace check — if nothing in
  the workspace changed it returns null and no folder is created.
- **T1 next** (`strategies.ts:877`): if the command matches a targeted
  pattern (`pip install`, `npm install`, `export`, `git push|reset|…`),
  record the corresponding manifest. Success sets
  `targetedSucceeded = true`.
- **T3 last** (`strategies.ts:887`): the subagent fires **only if**

  ```
  if (outsideWorkspace && !targetedSucceeded) { … runSubagentBackup … }
  ```

  i.e. the action touches outside state **and** no T1 manifest already
  covered it. This is the gate that decides whether we pay tens of
  seconds. The subagent's prompt classifies the action into Categories
  A–F (`subagent.ts`) — file writes, package state, env vars, MCP/remote
  state, etc. — and records recovery commands.

### 2.5 Restore (the symmetric side)

`src/restore/restore.ts` inverts each tier: `restorePipFreeze`,
`restoreGitSnapshot`, `invokeRestoreSubagent`, etc. The T2 restore
(`restore.ts:160`) is `git read-tree <commit>` + `git checkout-index -f
-a` + `git clean -fd` — restoring tracked content *and* removing files
created after the snapshot. Note `git clean` is used **without `-x`**
(`restore.ts:172`), so gitignored paths (e.g. `.pytest_cache/`, which
ships its own `.gitignore` of `*`) are neither snapshotted by `add -A`
nor removed on restore — they persist as harmless regenerable cache.

### 2.6 Where the logic broke — and the fix

**The bug.** Step 2.3 rule 4 (the absolute-path catch-all) made no
distinction between a path being **written** and a path being **read**.
SWE-bench agents invoke the test suite through the conda interpreter's
absolute path:

```
/opt/miniconda3/envs/testbed/bin/python -m pytest tests/
```

`/opt/miniconda3/...` resolves outside the `/testbed` workspace, so
`touchesOutsideWorkspace` returned true — even though that path is the
**program being executed** (a read), not a file being mutated. Every
test run therefore set `outsideWorkspace = true`, and since no T1
manifest matched, T3 fired. The agent ran tests 7 times → 7 subagents →
774 s. Empirically confirmed:

```
pytest tests/                                 -> no subagent
/opt/miniconda3/.../python -m pytest tests/   -> subagent fires
```

A before/after filesystem diff showed pytest's *actual* footprint is
only `.pytest_cache/` — a few KB of gitignored, regenerable cache, all
in-workspace, nothing outside. So the 7 subagents backed up state that
was either free (T2 already had the workspace) or worthless (cache);
none captured genuine outside state. T2 behaved correctly and cheaply;
**T3 false-fired on a read reference to the interpreter binary.**

**The fix** (`strategies.ts:655`): before the absolute-path scan, strip
the leading executable token of each `&&`/`||`/`|`/`;`-separated
segment — the program being run is a read and must not count. **Every
other token is still scanned**, so the heuristic keeps its existing bias
toward *over*-firing (a slow but safe backup) rather than *under*-firing
(silent, unrecoverable state):

```js
const scanCmd = cmd
  .split(/(?:&&|\|\||[|;])/)
  .map((seg) => seg.replace(/^\s*\S+\s*/, " "))  // drop argv[0] of each segment
  .join(" ");
const absolutePaths = scanCmd.match(/\/[\w./-]+/g) ?? [];
```

A fuller "classify every path as read vs write" rewrite was
**considered and rejected**: it would flip the failure polarity to
*under*-firing for any mutating verb not on a hand-maintained list —
`rsync`, `tar -x -C`, `unzip -d`, `make install`, and especially
`python -c "open('/etc/x','w')"`, where the write target hides inside a
string argument. For a recovery tool a false negative (unrecoverable
state) is strictly worse than a slow backup, so the minimal fix is also
the safer one.

**Verification.** A 9-case oracle confirms: the interpreter-path bug is
gone; genuine outside writes — redirections (`echo x > /etc/foo`),
`cp`/`rm`/`tar -x -C` to `/opt`, and `python -c "open('/etc/x','w')"` —
all still fire T3; `pip install` is still covered by the T1 manifest
(not T3). The full unit suite passes 172/172.

**Expected effect.** `pytest-dev__pytest-6202` drops from 774 s /
14.5 MB / 7 subagents to a single ~50 ms T2 snapshot of a few KB. Since
every conda/venv command in SWE-bench carries an outside interpreter
path, this generalizes across the benchmark — so the planned paid sweep
measures the real system rather than this false positive.

### 2.7 Adjacent observations (not fixed here)

- The 11.4 MB `git bundle` was a *subagent strategy choice*, not a
  trigger bug — the same "small model makes an unconstrained, sometimes
  wasteful choice" theme seen in the postgres-MCP experiment. Bounding
  T3's allowed strategies is separate follow-up work.
- The escalation gate stays biased toward over-firing by design; we did
  **not** add a "skip T3 if T2 succeeded" guard, because T2's success is
  irrelevant to whether outside state (which T2 cannot see) needs
  backing up.
