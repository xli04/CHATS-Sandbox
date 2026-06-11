#!/usr/bin/env bash
# Multi-agent sweep: tasks × agents × conditions → CSV.
# Serial with docker pruning between runs (disk-constrained VM).
#
# Usage: sweep-multi.sh [tasks-file] [out-csv] [agents...]
#   AGENTS defaults to: claude hermes openclaw openhands

set -u
TASKS_FILE="${1:-/mnt/data/CHATS-Sandbox/benchmarks/tasks20.txt}"
OUT="${2:-/mnt/data/CHATS-Sandbox/benchmarks/results/multi.csv}"
shift 2 2>/dev/null || true
AGENTS=("${@:-}")
[ -z "${AGENTS[0]:-}" ] && AGENTS=(claude hermes openclaw openhands)

CONDITIONS=(plugin git-add cp-all)
mkdir -p "$(dirname "$OUT")"

# Append mode: resume-friendly — skip rows already present.
if [ ! -f "$OUT" ]; then
  echo "task,agent,condition,wall_seconds,backup_bytes,actions,test_pass,notes" > "$OUT"
fi

TASKS=()
while IFS= read -r line; do
  line="${line%%#*}"; line="${line// /}"
  [ -n "$line" ] && TASKS+=("$line")
done < "$TASKS_FILE"

TOTAL=$(( ${#TASKS[@]} * ${#CONDITIONS[@]} * ${#AGENTS[@]} ))
N=0
START_ALL=$(date +%s)
for agent in "${AGENTS[@]}"; do
  for task in "${TASKS[@]}"; do
    for cond in "${CONDITIONS[@]}"; do
      N=$((N + 1))
      if grep -q "^$task,$agent,$cond," "$OUT" 2>/dev/null; then
        printf "[%d/%d] %s / %s / %s ... cached\n" "$N" "$TOTAL" "$task" "$agent" "$cond" >&2
        continue
      fi
      printf "[%d/%d] %s / %s / %s ... " "$N" "$TOTAL" "$task" "$agent" "$cond" >&2
      row=$(bash /mnt/data/CHATS-Sandbox/benchmarks/runner-multi.sh "$task" "$agent" "$cond" 2>>/tmp/sweep-multi-err.log | tail -1)
      echo "$row" >> "$OUT"
      echo "$row" | awk -F, '{printf "wall=%ss bytes=%s acts=%s test=%s %s\n", $4, $5, $6, $7, $8}' >&2
      docker system prune -f >/dev/null 2>&1
    done
  done
done
ELAPSED=$(( $(date +%s) - START_ALL ))
echo "done in ${ELAPSED}s" >&2
echo "$OUT"
