# Report: Tier-3 over-firing on interpreter-path commands

## 1. Context

CHATS-Sandbox is a multi-agent backup/recovery plugin. Before a coding
agent runs a mutating tool call, a PreToolUse hook makes a reversible
backup using a four-tier ladder, cheapest first:

- **T0** policy rewrite — destructive command rewritten reversibly
  (`rm` → move-to-trash). O(1), exact.
- **T1** manifest — environment recipe (`pip freeze`, env vars).
- **T2** snapshot — `git add -A` of the workspace into a shared shadow
  git repo (`src/backup/strategies.ts`).
- **T3** subagent — an LLM subagent that backs up state *outside* the
  workspace (remote services, system files), since T0–T2 only see the
  workspace. Each firing is a full agent session (tens of seconds).

We added per-action backup-latency accounting
(`.chats-sandbox/backup-timings.jsonl`, written in
`src/hooks/pre-tool.ts`) and ran a SWE-bench Verified stress test
(`benchmarks/swe-runner.sh`, results in
`benchmarks/results/swe-validate.csv`): real repos (django, requests,
sphinx, pytest, …) driven by hermes/deepseek under the plugin.

## 2. Problem observed

All four tiers fired and every artifact verified on disk — but the
`pytest-dev__pytest-6202` instance recorded **774 s of backup latency
and 14.5 MB of backup storage** for a single agent run.

Forensics on the live container showed the cost was **7 T3 subagent
firings (40–130 s each)**, every one triggered by the agent running the
test suite. One subagent backed itself up by creating an **11.4 MB
`git bundle` of the entire repo** (95% of the disk figure).

Root cause — traced to `touchesOutsideWorkspace()` in
`src/backup/strategies.ts:600`. Its absolute-path scan (≈ line 663)
flags **any** absolute path outside the workspace as an out-of-workspace
effect and escalates to T3. The agent invoked tests via the conda
interpreter's absolute path:

    /opt/miniconda3/envs/testbed/bin/python -m pytest tests/

`/opt/miniconda3/...` is outside the `/testbed` workspace, so the scan
returned true and fired T3 — even though that path is the **program
being run** (a read), not a file being written. Confirmed empirically:

    pytest tests/                                   -> no subagent
    /opt/miniconda3/.../python -m pytest tests/     -> subagent fires

What pytest actually changes (measured by before/after filesystem diff):
only `/testbed/.pytest_cache/` — a few KB of git-ignored, regenerable
cache. All in-workspace (already covered by T2), nothing outside it.
The 7 subagents copied state that was either free (T2 had it) or
worthless (cache); none captured genuine out-of-workspace state.

In short: T2 behaved correctly and cheaply; **T3 false-fired on a read
reference to the interpreter path** and then did expensive, redundant work.

## 3. Proposed solution

**Primary fix — strip argv[0] before the path scan**
(`src/backup/strategies.ts:655`):

The program being run is a read, never a mutation target. Split the
command on `;`, `&&`, `||`, `|` and drop the leading executable token of
each segment before scanning for outside-workspace absolute paths.
**Every other token is still scanned**, so the heuristic keeps its
existing safe bias toward over-firing.

A fuller "classify each path as read vs write" rewrite was considered
and **rejected**: it would flip the failure polarity from over-firing
(slow but safe) to under-firing (silent, unrecoverable state) for any
mutating verb not on a hand-maintained list — `rsync`, `tar -x -C`,
`unzip -d`, `make install`, and especially `python -c
"open('/etc/x','w')"`, where the write target hides inside a string
argument. For a recovery tool a false negative is strictly worse than a
slow backup, so the minimal fix is also the safer one.

Effect: `python -m pytest …` stops escalating to T3; real writes like
`echo x > /etc/foo`, `cp build /opt/lib`, `tar -x -C /opt`, and
`python -c "open('/etc/x','w')"` still fire. `pip install` is handled by
the T1 manifest tier (not T3) as before.

**Create-only state needs no content backup, and is already neutral.**
pytest only *creates* files (measured footprint: `.pytest_cache/`); it
overwrites/deletes nothing. Two facts make this cost-free without any
change:
- `.pytest_cache/.gitignore` contains `*`, so `git add -A` never
  snapshots it — T2 stores zero bytes for it.
- T2 restore uses `git clean -fd` **without `-x`**
  (`src/restore/restore.ts:172`), which respects that gitignore — so
  restore does NOT delete `.pytest_cache` either. It persists as
  harmless regenerable cache.

So the workspace after restore is *semantically* clean (the only
residue is regenerable cache), not byte-identical. This is the correct
outcome and needs no code: once T3 stops false-firing, pytest is
covered by one cheap T2 snapshot at near-zero cost. (Genuine
create-only state that IS tracked — e.g. a new source file — is
snapshotted by `add -A` and removed on restore by `git clean -fd`,
the path that closes deferred task #57; the `add -A` baseline makes
that clean safe, removing only action-created tracked-or-unignored
files.)

**No safety net, and no recursion fix needed.** An earlier draft
proposed suppressing T3 when T2 succeeded — dropped: T2's success is
irrelevant to whether T3 is needed (T3 exists for state T2 cannot see,
e.g. `echo x > /etc/foo`), and a mis-keyed guard would suppress
legitimate firings. Over-firing is the safe failure direction for a
recovery tool, so the heuristic should keep that bias. The subagent
recursion concern (a subagent's own tool calls re-triggering the hook)
is already closed: `src/hooks/pre-tool.ts:36` short-circuits on
`CHATS_SANDBOX_NO_HOOK=1`, set in `subagentEnv()`
(`src/backup/subagent.ts:63`). The 11.4 MB bundle was therefore not
recursion — it was the subagent *choosing* `git bundle` as its backup
strategy (a small-model judgment issue, separate from this fix).

**Expected result:** `pytest-dev__pytest-6202` drops from 774 s /
14.5 MB / 7 subagents to one ~50 ms T2 snapshot of a few KB, fully
restorable. Generalizes to every conda/venv-interpreter command in
SWE-bench, so the planned paid sweep measures the real system rather
than this false-positive.

**Scope / tests (as shipped):** the entire fix is stripping the
leading executable token of each `&&/||/|/;`-separated segment before
the absolute-path scan (`src/backup/strategies.ts:655`) — ~5 lines,
every other token still scanned, so the heuristic keeps its safe
over-firing bias. A full read/write command classifier was rejected:
it would flip the polarity to under-firing (silent unrecoverable state)
for any verb not on a list — `python -c "open('/etc/x','w')"` is the
clinching case, which today's scan and strip-argv[0] both still catch
but a classifier would miss. Validated by a 9-case oracle (bug gone;
redirections, cp/rm/tar, interpreter `-c` writes all still fire; pip
install correctly handled by T1 not T3) and the 172-test suite.
