# Methodology notes for the backup benchmark

## Conditions
- **plugin** — CHATS-Sandbox tiered backup (`chats-sandbox install <agent>`):
  T0 policy rewrite, T1 manifests, T2 shared shadow repo, T3 subagent.
- **git-add** — baseline "always shadow repo": `git add -A && git commit`
  into a side shadow repo on every PreToolUse. Fixed mid-sweep to exclude
  its own storage dir (a self-snowball inflated early rows; those rows
  were discarded and re-run).
- **cp-all** — baseline "copy everything changed": copy the whole
  workspace top-level into a per-action folder on every PreToolUse.

## Metrics
- `wall_seconds` — full agent run wall time under the condition.
- `backup_bytes` — raw `du -sb` of the condition's backup directory.
- `net=` (notes field; plugin rows from the corrected runner) —
  backup bytes minus bytes *moved* (not copied) into trash by
  rm-to-trash. A move relocates an inode: total disk is unchanged, so
  charging the full file size to "backup cost" overstated plugin cost
  on every deletion. Copy-based trash (sed/truncate/mv-clobber
  snapshots) still counts in full.

## Reading the numbers
- Storage is paid in sums: lead with TOTAL ratios and worst case;
  per-task medians describe only the typical tiny task.
- Adjusted (storage-mechanism) view additionally strips the git
  empty-init floor (64,830 B, both shadow-based conditions) and 4 KB
  directory-block padding for per-action dirs.

## Known limitations / fairness caveats
1. **Coverage is not priced in.** The git-add baseline only sees
   `GIT_WORK_TREE=/app`. Package upgrades (site-packages), env changes,
   system config edits, and remote/MCP mutations are invisible to it —
   costed at 0 bytes because it simply does not protect them. The
   plugin covers these via T1 manifests (e.g. `pip freeze`, a few KB)
   and the T3 subagent. The task suite is workspace-local, so this
   advantage never registers in the byte columns.
2. **Restore capability is not priced in.** The baselines store bytes
   but no action↔snapshot mapping, no recovery commands, and no
   deterministic inverse for destructive commands. "Cheaper" partially
   means "does less."
3. **Trash payloads are uncompressed**, while git blobs are
   zlib-compressed — on compressible data this costs the plugin up to
   ~2x on those artifacts (candidate product fix: gzip trash payloads).
4. **Excluded rows**: flood-monitoring-basic × openhands (image ships
   Python 3.11; openhands-sdk requires >=3.12) and
   multi-source-data-merger × openhands (same class). Tests-pass rates
   reflect agent task ability, roughly uniform across conditions; the
   matched-pair ratios are the bias-resistant statistics.
5. Models: claude = sonnet 4.6 (+ haiku subagent); hermes/openhands =
   deepseek/deepseek-v4-flash for main and subagent.
