#!/usr/bin/env bash
set -u
cd /mnt/data/CHATS-Sandbox/benchmarks
OUT=results/pip-bench.csv
[ -f "$OUT" ] || echo "task,cond,wall,backup_bytes,hook_ms,actions,changed,restore_pct,extras,done,notes" > "$OUT"
for t in $(grep -v '^#' pip-tasks.txt | cut -d'|' -f1); do
  for c in none plugin git-add cp-all; do
    grep -q "^$t,$c," "$OUT" && { echo "skip $t/$c" >&2; continue; }
    echo -n "$t/$c ... " >&2
    row=$(bash pip-runner.sh "$t" "$c" 2>>/tmp/pip-sweep-err.log | tail -1)
    echo "$row" >> "$OUT"; echo "$row" | cut -d, -f3-10 >&2
  done
done
echo "PIP SWEEP DONE" >> /tmp/supervise.log
