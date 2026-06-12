# CHATS-Sandbox Benchmark Findings

Two studies, June 2026:

- **Study A — local backup cost** (terminal-bench): 3 agents (Claude Code =
  sonnet 4.6 + haiku 4.5; Hermes & OpenHands = deepseek-v4-flash) × 15 easy
  + 5 medium tasks × 3 conditions: **plugin** (CHATS tiered), **git-add**
  (always-shadow-repo baseline), **cp-all** (copy-workspace-per-action
  baseline). ~150 containerized runs.
- **Study B — remote backup via learned experiences** (postgres MCP):
  10 self-defined destructive DB tasks (mass DELETE/UPDATE, DROP TABLE,
  DROP COLUMN) on a 27 MB / 98k-row database, Claude Code lane, with vs
  without the verified experience file injected into the tier-3 subagent.

## Headline numbers

| Comparison | Result |
|---|---|
| plugin vs cp-all (easy, totals) | **740–2,152× less disk** |
| plugin vs cp-all (medium, totals) | 6–42× less disk (worst single task: 6,068×) |
| plugin vs git-add (easy, corrected totals) | 1.7–2.3× less on chatty agents; **0.83× (17% behind) on Claude** |
| plugin vs git-add (medium) | parity (0.9–1.1×) |
| wall-time overhead | +3–12 s on 60–100 s tasks, all conditions comparable |
| experiences: local disk (10 tasks, excl. 1 outlier) | **2.2× less; best cases 13× and 57×** |
| experiences: when advice followed | local cost flat ≈ 180 KB regardless of data size |
| experiences: adoption by haiku subagent | **6/10 tasks** |
| experiences: token cost | ≈ neutral (~$0.02–0.05/call either way) |

---

## 1. What works well

**Tier-0 policy rewrite is the clearest win in the system.** Deterministic,
O(1) for rm/mv (inode rename), byte-exact restores proven on every agent.
The 16-rule engine intercepted rm / sed -i / mv / chmod across all live
runs with zero double-executions after the per-agent rewrite plumbing was
fixed. Where a destructive command hits T0, no baseline even competes:
cp-all pays the whole workspace, git-add pays a snapshot, we pay ~0 and
keep an exact inverse.

**Copy-based backup is not viable, and the gap grows with task size.**
cp-all looks acceptable on toy tasks (its per-task median even beat ours)
and then catastrophically explodes — 1.06 GB for one task containing a git
repo (16 copies of the workspace), 78 MB for a 5 MB pytorch workspace,
timeouts caused by copy overhead slowing the agent itself. Storage is paid
in totals, and in totals cp-all loses by three orders of magnitude.

**Learned experiences transform remote backup when they are followed.**
The mechanism works exactly as designed: 4–5 small SQL statements snapshot
thousands of rows server-side (`_chats_trash` / `_chats_audit` schemas,
checkpoint-tagged, verified reversible), local disk stays at the ~180 KB
metadata floor, and the data never transits the model. Best observed:
**57× less local disk** (drop-notes-column: 9.85 MB scraped vs 176 KB) and
13× (delete-cancelled-orders). Token cost is neutral — the experience
trades nothing for its benefit.

**The architecture ports.** One hook core now drives seven agents
(Claude Code, Hermes, OpenClaw, OpenHands, Codex, Cursor; +explore
pipeline); per-agent adapters are thin (a name map, an input mirror, a
rewrite-application mechanism). Live e2e verified byte-exact restores on
all of them. The benchmark itself ran unmodified across three agents.

**Read-skipping keeps the action stream lean.** The always-shadow baseline
commits on every tool call including reads (median 8–16 actions/task);
the plugin's read short-circuit kept it at 3–6. On chatty agents that
difference is why the corrected easy-suite totals favor us 1.7–2.3×.

## 2. What does not work as well — and why

**(a) vs git-add on small local tasks, we are not strongly better — and on
Claude we are slightly worse (0.83×).** The honest reason: *our tier-2 IS
a git shadow snapshot.* For plain in-workspace file edits the two systems
store byte-identical objects, so there is no mechanism left to win bytes
with. What remains is our additive overhead: per-action metadata
(recovery commands, action↔commit map, instruction), T0 trash payloads
stored raw while git compresses, and (pre-fix) git's 65 KB empty-init
scaffolding. On Sonnet specifically the gap is widest because Sonnet
solves easy tasks in 2–4 terse actions — there is almost no read-churn
for the baseline to waste, so its only-snapshots column is lean and our
fixed extras show. Where agents are chattier (deepseek lanes) or tasks
are bigger, the read-skipping and O(changes) scaling tip totals our way.
Summary: on tiny, calm, purely-local workloads, a bare shadow repo is a
genuinely good baseline, and our advantage there is *capability*
(per-action restore, exact T0 inverses, out-of-tree coverage), not bytes.

**(b) Experience adoption is ~60%, and that drives most of the variance.**
Same model, same injected file, same task shape — sometimes haiku executes
the recipe, sometimes it free-styles a local scrape, once it did both
(in-DB snapshot *plus* a 1.9 MB local dump). Prompt-injected guidance is
advisory, and a small fast model treats it that way. Every disappointing
row in Study B traces to non-adoption, not to the pattern failing.

**(c) Without experiences, the subagent sometimes fakes the backup.** The
original Category F prompt let haiku "back up" a 7,500-row DELETE as a
2 KB schema+row-count note — unrestorable. A prompt hardening ("capture
the actual rows; a count is NOT a backup") fixed the observed cases, but
prompt-level fixes inherit problem (b): nothing *verifies* the artifact.
These fake backups also silently flattered the no-exp baseline's disk
numbers in Study B (looking cheap by saving nothing).

**(d) The benchmark suite under-exercises our differentiators.** Terminal-
bench easy/medium tasks are mostly small in-workspace file writes — they
rarely trigger T0-heavy destruction, large binaries, pip/site-packages
mutations, or remote tools, which is precisely where the tiered design
pays. Study B exists because Study A structurally couldn't show the
remote story.

**(e) Small, real, fixable inefficiencies.** Raw (uncompressed) T0 trash
vs git's zlib (up to ~2× on compressible payloads — the 0.38× outlier
pair in the medium git-add comparison); 65 KB git-init scaffolding per
shadow repo (27 KB of it git sample hooks); +3–12 s hook overhead from
spawning a node process per tool call.

## 3. How to make the pipeline more robust

**(1) Promote followed-experiences from advice to mechanism — the typed
contract.** This is the highest-leverage fix and addresses (b) and (c)
at the root. Verified experiences already contain machine-shaped recipes
(parameterized SQL with `<table>`/`<predicate>`/`<ckpt_id>` slots). For a
recognized destructive remote action, the hook should *execute the recipe
deterministically* — exactly like a T0 rule, with the LLM only filling
clearly-typed slots (or skipped entirely when the SQL is parseable) —
rather than pasting prose into a subagent prompt and hoping. Expected
effect: adoption 60% → ~100%, every Study B row converges to the 13–57×
regime, and the subagent is reserved for genuinely novel actions.

**(2) Verify artifacts, don't trust reports.** Add a cheap post-backup
audit: for DB backups, row-count the snapshot vs the WHERE predicate; for
scrapes, sanity-check payload size against the destroyed data's scale;
for T0, stat the trash. On failure: retry once with a stronger model,
then surface a loud warning ("backup may be unrestorable") instead of a
quiet success. Fake backups become impossible to miss.

**(3) Close the byte gap vs git-add on small tasks.** Three small,
compounding fixes: gzip T0 trash payloads on write (parity with git's
compression); `git init --template=` for the shadow repo (−65 KB floor,
~40% of an easy-task footprint); optionally batch tiny per-action
metadata into a single ledger file. Combined with net accounting for
moves (already implemented), the easy-suite Claude cell likely flips
≥1.0× — removing the one cell where a baseline beats us.

**(4) Record what the backup cost.** Capture `total_cost_usd` / token
usage from the subagent's JSON wrapper into artifact metadata, and emit
backup-time vs agent-time split in the bench rows. Eliminates estimate
sections in future reports.

**(5) Benchmark where the design lives.** Add a destructive/remote suite:
delete-heavy and large-binary tasks, a pip-upgrade task (shadow repo
provably cannot cover site-packages — coverage gap made measurable), and
MCP-driven tasks on more servers (the explore pipeline already generalizes:
postgres + filesystem are verified).

**(6) Keep the agent matrix honestly characterized.** OpenHands runs
T1–T3 only (its hook API can't rewrite inputs — documented, by design);
Codex hooks await an interactive-session trust review on current CLI;
parallel multi-session workspaces share one action counter (file-lock if
that becomes a real deployment pattern).

## One-paragraph verdict

The tiered design delivers what it promises against realistic baselines:
copy-based backup is unusable at scale (up to three orders of magnitude
more disk), and an always-shadow repo — while byte-competitive on small
local edits, where it equals us by construction — cannot restore
per-action, cannot reverse destructive commands exactly, and covers
nothing outside the worktree. The learned-experience pipeline converts
remote backup from "download everything" to "constant-cost in-place
reversal" with neutral token cost — its only weakness is that a small
subagent follows instructions probabilistically, which is an enforcement
problem, not a design problem: execute the verified recipes
deterministically and verify artifacts, and both observed failure modes
disappear.
