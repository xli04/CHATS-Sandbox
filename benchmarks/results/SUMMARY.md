# Backup cost comparison — corrected disk usage

Totals over tasks completed under ALL three conditions (matched sets).
Corrections: git-init floor + dir-block padding stripped from all
conditions; soft-delete moves cost 0 (net accounting). claude=sonnet-4.6,
hermes/openhands=deepseek-v4-flash. cond: plugin=CHATS tiered,
git-add=always-shadow-repo, cp-all=copy-workspace-per-action.

| Suite | Agent | tasks | plugin | git-add | cp-all | vs git-add | vs cp-all |
|---|---|---|---|---|---|---|---|
| easy | claude | 15 | **1.37 MB** | 1.14 MB | 1014.19 MB | 0.83x | 740x |
| easy | hermes | 15 | **836 KB** | 1.38 MB | 1015.53 MB | 1.69x | 1243x |
| easy | openhands | 14 | **725 KB** | 1.62 MB | 1.49 GB | 2.29x | 2152x |
| medium | claude | 1 | **605 KB** | 661 KB | 33.13 MB | 1.09x | 56x |
| medium | hermes | 2 | **9.91 MB** | 11.24 MB | 62.98 MB | 1.13x | 6x |
| medium | openhands | 4 | **9.87 MB** | 10.31 MB | 94.81 MB | 1.04x | 10x |

Reading: 'vs X' = X's bytes / plugin's bytes — above 1.0 means the
plugin is cheaper. Wall time across conditions is comparable
(plugin overhead within agent variance). The plugin additionally
provides per-action restore, deterministic T0 inverses, and
out-of-workspace/remote coverage the baselines lack entirely.
