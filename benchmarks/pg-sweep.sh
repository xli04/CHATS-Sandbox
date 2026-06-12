#!/usr/bin/env bash
# Postgres-MCP experience sweep: 10 tasks × {noexp, exp}, serial (one DB).
set -u
cd /mnt/data/CHATS-Sandbox/benchmarks
OUT=results/pg-experience.csv
if [ ! -f "$OUT" ]; then
  echo "task,cond,wall,local_bytes,db_delta,actions,subagent_rows,easywin,op_ok,notes" > "$OUT"
fi
TASKS=$(grep -v '^#' pg-tasks.txt | cut -d'|' -f1)
N=0
for t in $TASKS; do
  for c in noexp exp; do
    N=$((N+1))
    if grep -q "^$t,$c," "$OUT"; then echo "[$N/20] $t/$c cached" >&2; continue; fi
    echo -n "[$N/20] $t/$c ... " >&2
    row=$(bash pg-runner.sh "$t" "$c" 2>>/tmp/pg-sweep-err.log | tail -1)
    echo "$row" >> "$OUT"
    echo "$row" | awk -F, '{printf "wall=%ss local=%s easywin=%s op=%s\n",$3,$4,$8,$9}' >&2
  done
done
echo "PG SWEEP DONE $(date -u +%H:%M)" >> /tmp/supervise.log
