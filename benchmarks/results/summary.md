# Benchmark summary — 10 terminal-bench tasks

Each task run with 4 conditions (none, plugin, git-add, cp-all) using
Claude Sonnet 4.6 as the executor. Averages across 10 tasks.

| Condition | Avg time (s) | Avg space (MB) | Time overhead vs no-backup |
|-----------|-------------:|---------------:|---------------------------:|
| plugin    |        86.1 |            1.8 |                               +8%|
| git-add   |         91.4 |           18.2 |                        +5% |
| cp-all    |         95.5 |           52.2 |                       +10% |

Baseline (no-backup, `none` condition): 87.0 s / task average.

**Space savings**: plugin is ~10× smaller than git-add, ~29× smaller
than cp-all. Total disk across the 10-task sweep: plugin 18.0 MB,
git-add 181.5 MB, cp-all 521.6 MB.

Raw per-task data: `sweep.csv` in the same directory.
