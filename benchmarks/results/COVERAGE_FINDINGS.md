# SWE-bench: git-add vs plugin — cost AND coverage

6 instances, hermes/deepseek-v4-flash, identical issue+drill workload.
Coverage = handled / total mutating actions, from a method-independent
observer that classifies every tool call as read / in-workspace mutation
/ outside-workspace mutation. git-add can only capture in-workspace
mutations; the plugin handles all classes (T0/T1/T2/T3). `backup_ms` is
the real per-run hook overhead (a slice *inside* wall, not added on top).

| Instance | cond | wall | backup_ms | disk | coverage | tiers |
|---|---|---|---|---|---|---|
| requests-1766 | git-add | 65s | 0.5s | 1.29MB | 8/10 = 80% | — |
| requests-1766 | plugin | 76s | 1.1s | 1.28MB | **10/10 = 100%** | T0+T1+T2 |
| requests-1921 | git-add | 114s | 0.6s | 1.33MB | 10/14 = 71% | — |
| requests-1921 | plugin | 221s | 1.7s | 1.40MB | **13/13 = 100%** | T1+T2 |
| flask-5014 | git-add | 124s | 0.6s | 1.62MB | 8/10 = 80% | — |
| flask-5014 | plugin | 36s | 1.1s | 1.65MB | **10/10 = 100%** | T0+T1+T2 |
| pytest-6202 | git-add | 302s | 1.0s | 2.27MB | 8/17 = 47% | — |
| pytest-6202 | plugin | 417s | 120.7s | 2.36MB | **30/30 = 100%** | T0+T1+T2+T3 |
| xarray-4094 | git-add | 370s | 0.9s | 3.11MB | 17/23 = 74% | — |
| xarray-4094 | plugin | 298s | 87.5s | 3.12MB | **28/28 = 100%** | T0+T1+T2+T3 |
| sphinx-8459 | git-add | 228s | 3.0s | 6.53MB | 14/15 = 93% | — |
| sphinx-8459 | plugin | 245s | 52.1s | 6.61MB | **20/20 = 100%** | T0+T1+T2 |

**git-add coverage: median 77%, range 47–93%. plugin: 100% everywhere.**

## Reading it

- **Disk: near-identical** (git-add and plugin within a few % on every
  instance) — both are O(changes) shadow snapshots for the workspace.
- **git-add's low backup_ms (0.5–3s) is bought by NOT covering
  outside-workspace state.** Its 47–93% coverage means 7–53% of mutating
  actions (pip installs, outside writes, env changes) are silently
  uncaptured and unrecoverable. The cost looks competitive only because
  it does less.
- **Wall is agent variance, not backup cost** — plugin is faster than
  git-add on 3 of 6 instances (flask 36 vs 124s, xarray 298 vs 370s).
  The real overhead is backup_ms.

## The plugin's real cost, and where it comes from

On env-heavy instances (pytest, xarray) plugin backup_ms is 50–120s —
NOT free. Per-action forensics (results/swe-logs/pytest-…-plugin/)
show it is dominated by the **tier-3 subagent**: a cold LLM session per
outside-workspace action, 27–54s each, ~5 firings. Some firings ran
~28s then were *refused* by the artifact-verification gate (recorded as
git_snapshot-only with anomalous ~28s latency) — wasted time worth
failing fast on.

Crucially, the SAME forensics show the cheap path already working:
- pip install → T1 `pip_freeze` manifest: **0.4s**
- outside file write → T0 policy_rewrite: **0.0s**

i.e. when a **deterministic recipe** exists for an outside-action class,
it costs ~0.1–0.5s instead of a 27–54s subagent — a 70–130× speedup.
The expensive firings are the classes with no precomputed recipe.

## Implication: experience-exploration-first

The subagent re-derives the same kinds of backups from scratch every
occurrence. Exploring experiences offline (pay the LLM cost ONCE per
action-class to learn the recipe) and applying them **deterministically
as a T0/T1-style tier** (not via a subagent prompt — that's the 60%-
adoption trap from the postgres study) would convert most T3 firings
into sub-second deterministic recipes, collapsing the 50–120s tail to
near-zero while keeping 100% coverage. T3 then shrinks to only
genuinely novel actions.
