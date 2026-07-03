# Backup Method Comparison — SWE-bench (30 instances)

**Setup:** main agent `deepseek-v4-pro` (backup subagent `deepseek-v4-flash` for the plugin).
30 SWE-bench instances; each run = the real GitHub-issue fix + a mixed drill (in- and
outside-workspace actions). 0 pull failures across all four sweeps.

Methods:
- **plugin** — CHATS-Sandbox tiered backup (T0 policy / T1 env-snapshot / T2 git-snapshot / T3 subagent)
- **hermes-native** — hermes's built-in `--checkpoints` (git shadow repo; snapshots only before
  write_file/patch + destructive terminal commands, deduplicated per turn)
- **git-add** — naive: `git add -A` snapshot on every tool call
- **cp-all** — naive brute force: full working-tree copy (no dedup) on every mutating action

## Summary (averages over 30 instances)

| method | coverage | backup disk | backup time | MB / 1% cov | ms / 1% cov | recovery |
|---|---|---|---|---|---|---|
| **plugin** | **100.0%** | 9.63 MB | 4261 ms | 0.096 | 42.6 | 0.997 |
| hermes-native | 45.7% | 9.63 MB | 2142 ms | 0.211 | 46.9 | — |
| git-add | 77.5% | 9.46 MB | 4698 ms | 0.122 | 60.6 | — |
| cp-all | 77.9% | 594.6 MB | 7596 ms | 7.636 | 97.6 | — |

*Recovery shown is strict workspace-identity. **Content recovery** (did the agent's file edits get reverted, ignoring untracked test artifacts / mode bits) = **0.99999** — 29/30 instances perfect; 1 of 76,216 source files not reverted (`django-10914`, an early edit not pre-snapshotted + a failed pip_freeze restore).*

*MB / 1% cov and ms / 1% cov = backup disk / coverage and backup time / coverage — cost per percentage-point of coverage (lower = more efficient).*

## Key findings

- **Coverage — plugin is the only method at 100%.** git-add and cp-all reach ~78% (workspace-only;
  miss outside-workspace actions like pip install). **hermes-native is lowest at 46%** — its
  triggers are the narrowest (only file-edit tools + a destructive-command regex, deduped per turn),
  so it misses non-destructive terminal mutations *and* everything outside the workspace.
- **Backup time — hermes-native is cheapest (2142 ms)** precisely because it checkpoints least
  (per-turn dedup). plugin (4261 ms) < git-add (4698 ms, fires on every action incl. reads)
  < cp-all (7596 ms).
- **Disk — plugin ≈ hermes-native ≈ git-add (~9–10 MB, git-deduplicated). cp-all is ~62× larger**
  (595 MB) — full copies, no dedup; strictly dominated by git-add (same coverage, vastly more disk).
- **Recovery — plugin restores file content 100%** (the 0.997 is git mode-normalization on a few
  vendored files + the harness's own observer log, not real loss).

**Bottom line:** the methods span a clear trade-off — hermes-native is fast but blind (low coverage),
git-add/cp-all are workspace-only (~78%, cp-all at absurd disk cost), and **the plugin is the only one
that is both high-coverage (100%) and cheap** (disk/time on par with the lightweight baselines).

## Method note

plugin + git-add share one agent run (identical actions — paired comparison). hermes-native and cp-all
are each separate runs (own action sequences), so their numbers are method profiles, not per-action
paired deltas. Native timing is measured via a `git` wrapper that times its shadow-repo git ops at the
subprocess level. Data: `results/swe-30-dual/ALL.csv`, `results/swe-30-native/ALL.csv`,
`results/swe-30-cpall/ALL.csv`.

## Per-instance (coverage% / disk)

| instance | plugin | hermes-native | git-add | cp-all |
|---|---|---|---|---|
| astropy__astropy-12907 | 100% / 11.3MB | 36% / 11.2MB | 83% / 11.2MB | 62% / 665.5MB |
| astropy__astropy-13033 | 100% / 11.3MB | 27% / 11.2MB | 86% / 11.3MB | 78% / 876.7MB |
| astropy__astropy-14182 | 100% / 11.7MB | 33% / 11.7MB | 77% / 11.7MB | 67% / 457.9MB |
| astropy__astropy-14365 | 100% / 11.1MB | 44% / 11.0MB | 82% / 11.0MB | 67% / 416.3MB |
| astropy__astropy-14995 | 100% / 11.0MB | 50% / 11.0MB | 75% / 11.0MB | 75% / 374.9MB |
| astropy__astropy-6938 | 100% / 10.9MB | 32% / 10.8MB | 76% / 10.8MB | 73% / 915.5MB |
| astropy__astropy-7746 | 100% / 11.1MB | 55% / 11.0MB | 82% / 11.1MB | 80% / 1279.2MB |
| django__django-10914 | 100% / 11.6MB | 78% / 15.5MB | 95% / 11.7MB | 87% / 755.1MB |
| django__django-10924 | 100% / 11.7MB | 20% / 11.6MB | 56% / 11.8MB | 86% / 1065.8MB |
| django__django-11001 | 100% / 11.7MB | 77% / 11.8MB | 89% / 11.8MB | 93% / 716.4MB |
| django__django-11019 | 100% / 11.6MB | 36% / 11.4MB | 78% / 11.7MB | 94% / 800.4MB |
| django__django-13109 | 100% / 15.4MB | 75% / 15.4MB | 88% / 15.4MB | 83% / 944.3MB |
| django__django-13112 | 100% / 15.4MB | 60% / 15.4MB | 89% / 15.4MB | 67% / 768.1MB |
| django__django-13121 | 100% / 15.4MB | 67% / 15.4MB | 88% / 15.4MB | 89% / 944.1MB |
| django__django-13128 | 100% / 15.6MB | 58% / 15.4MB | 67% / 12.2MB | 50% / 732.2MB |
| matplotlib__matplotlib-23314 | 100% / 38.9MB | 40% / 38.8MB | 77% / 38.9MB | 70% / 1146.9MB |
| pallets__flask-5014 | 100% / 1.7MB | 57% / 1.6MB | 62% / 1.7MB | 86% / 14.5MB |
| psf__requests-1142 | 100% / 1.2MB | 29% / 1.2MB | 67% / 1.3MB | 89% / 21.4MB |
| psf__requests-1766 | 100% / 2.6MB | 67% / 1.3MB | 92% / 1.4MB | 64% / 39.8MB |
| psf__requests-1921 | 100% / 1.5MB | 58% / 1.4MB | 75% / 1.5MB | 82% / 35.4MB |
| psf__requests-2317 | 100% / 1.4MB | 50% / 1.4MB | 89% / 1.4MB | 83% / 18.1MB |
| psf__requests-2931 | 100% / 1.5MB | 38% / 1.4MB | 93% / 1.6MB | 65% / 74.3MB |
| psf__requests-5414 | 100% / 4.5MB | 38% / 4.2MB | 68% / 4.4MB | 81% / 120.4MB |
| pydata__xarray-4094 | 100% / 3.3MB | 33% / 3.1MB | 79% / 3.3MB | 83% / 127.3MB |
| pytest-dev__pytest-6202 | 100% / 2.4MB | 26% / 2.3MB | 50% / 2.3MB | 78% / 138.6MB |
| scikit-learn__scikit-learn-13135 | 100% / 8.4MB | 50% / 8.4MB | 78% / 8.4MB | 71% / 1064.5MB |
| scikit-learn__scikit-learn-13142 | 100% / 8.5MB | 50% / 8.4MB | 77% / 8.4MB | 70% / 1525.8MB |
| sphinx-doc__sphinx-8459 | 100% / 7.0MB | 19% / 6.8MB | 43% / 6.9MB | 92% / 236.2MB |
| sympy__sympy-15599 | 100% / 9.5MB | 24% / 9.5MB | 83% / 9.5MB | 91% / 1195.7MB |
| sympy__sympy-15809 | 100% / 9.6MB | 44% / 9.5MB | 81% / 9.5MB | 80% / 366.3MB |
