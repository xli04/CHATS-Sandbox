#!/usr/bin/env bash
# Loop over tasks × conditions, appending rows to a CSV.
# Aggressively prune docker between runs to conserve disk on this VM.

set -u
TASKS_FILE="${1:-/mnt/data/CHATS-Sandbox/benchmarks/tasks.txt}"
OUT="${2:-/mnt/data/CHATS-Sandbox/benchmarks/results/sweep.csv}"
mkdir -p "$(dirname "$OUT")"

CONDITIONS=(none plugin git-add cp-all)

echo "task,condition,wall_seconds,backup_bytes,actions,test_pass,notes" > "$OUT"

TASKS=()
while IFS= read -r line; do
  line="${line%%#*}"   # strip comments
  line="${line// /}"   # trim spaces
  [ -n "$line" ] && TASKS+=("$line")
done < "$TASKS_FILE"

TOTAL=$(( ${#TASKS[@]} * ${#CONDITIONS[@]} ))
N=0
START_ALL=$(date +%s)
for task in "${TASKS[@]}"; do
  for cond in "${CONDITIONS[@]}"; do
    N=$((N + 1))
    printf "[%d/%d] %s / %s ... " "$N" "$TOTAL" "$task" "$cond" >&2
    row=$(bash /mnt/data/CHATS-Sandbox/benchmarks/runner.sh "$task" "$cond" 2>>/tmp/sweep-err.log | tail -1)
    echo "$row" >> "$OUT"
    echo "$row" | awk -F, '{printf "wall=%ss bytes=%s acts=%s test=%s\n", $3, $4, $5, $6}' >&2
    docker system prune -f >/dev/null 2>&1
  done
done
ELAPSED=$(( $(date +%s) - START_ALL ))
echo "done in ${ELAPSED}s" >&2
echo "$OUT"
