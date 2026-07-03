#!/usr/bin/env bash
# ── Unified CHATS-Sandbox evaluation entrypoint ───────────────────────
# One driver for every benchmark. Pick a dataset, an agent, and one or more
# backup conditions; the dataset adapter runs the agent ONCE per task and
# measures each requested condition on the identical action sequence.
#
#   ./eval.sh --dataset swe --agent hermes --condition plugin,git-add \
#             --model deepseek/deepseek-v4-pro --subagent-model deepseek/deepseek-v4-flash \
#             --n 30 --concurrency 4
#
# --dataset accepts a known name (swe|regret|webarena|mcp) OR a path to a
# dataset adapter .sh. Convenience wrappers (swe.sh, regret.sh, …) just preset
# --dataset and forward the rest here.
#
# Output: results/<dataset>/<run>/ALL.csv  (+ RESULTS.md via --report).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── defaults ──────────────────────────────────────────────────────────
DATASET=""; AGENT="hermes"; CONDS_RAW="plugin"
MODEL="deepseek/deepseek-v4-pro"; SUBAGENT_MODEL="deepseek/deepseek-v4-flash"
N=0; MAXJOBS=4; FILTER=""; TIMEOUT=600; RUN=""; TASKS=""; REPORT=0

usage() { sed -n '2,18p' "$0"; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dataset)         DATASET="$2"; shift 2 ;;
    --agent)           AGENT="$2"; shift 2 ;;
    --condition|--conditions) CONDS_RAW="$2"; shift 2 ;;
    --model)           MODEL="$2"; shift 2 ;;
    --subagent-model)  SUBAGENT_MODEL="$2"; shift 2 ;;
    --n)               N="$2"; shift 2 ;;
    --concurrency)     MAXJOBS="$2"; shift 2 ;;
    --filter)          FILTER="$2"; shift 2 ;;
    --timeout)         TIMEOUT="$2"; shift 2 ;;
    --tasks)           TASKS="$2"; shift 2 ;;     # explicit comma/space task list
    --run)             RUN="$2"; shift 2 ;;       # run-id (results subdir); default ts-less name
    --report)          REPORT=1; shift ;;
    -h|--help)         usage 0 ;;
    *) echo "unknown arg: $1" >&2; usage 1 ;;
  esac
done

[ -n "$DATASET" ] || { echo "ERROR: --dataset required (swe|regret|webarena|mcp|<path>)" >&2; exit 1; }

# resolve adapters
ds_file="$DATASET"; [ -f "$ds_file" ] || ds_file="$HERE/datasets/$DATASET.sh"
[ -f "$ds_file" ] || { echo "ERROR: no dataset adapter for '$DATASET' ($ds_file)" >&2; exit 1; }
agent_file="$HERE/agents/$AGENT.sh"
[ -f "$agent_file" ] || { echo "ERROR: no agent adapter for '$AGENT'" >&2; exit 1; }

# normalize conditions -> space list
CONDS="${CONDS_RAW//,/ }"
for c in $CONDS; do
  [ -f "$HERE/conditions/$c.sh" ] || { echo "ERROR: no condition adapter '$c'" >&2; exit 1; }
done

# ── wire everything together ──────────────────────────────────────────
source "$HERE/lib/common.sh"
require_env_key
source "$agent_file"
for c in $CONDS; do source "$HERE/conditions/$c.sh"; done
source "$ds_file"

DATASET_NAME="$(basename "$DATASET" .sh)"
DATASET="$DATASET_NAME"
RUN="${RUN:-$AGENT-${CONDS// /_}}"
OUT="$HERE/results/$DATASET/$RUN/ALL.csv"
export DATASET AGENT CONDS MODEL SUBAGENT_MODEL TIMEOUT OUT MAXJOBS HERE
init_out

log "dataset=$DATASET agent=$AGENT conds=[$CONDS] model=$MODEL sub=$SUBAGENT_MODEL n=$N jobs=$MAXJOBS"
log "out=$OUT"

# ── task list (explicit --tasks wins; else adapter's ds_tasks) ────────
if [ -n "$TASKS" ]; then LIST="${TASKS//,/ }"; else LIST="$(ds_tasks)"; fi
[ "$N" -gt 0 ] 2>/dev/null && LIST="$(echo "$LIST" | tr ' ' '\n' | grep -v '^$' | head -n "$N")"
[ -n "$FILTER" ] && LIST="$(echo "$LIST" | tr ' ' '\n' | grep -E "$FILTER")"

# ── split conditions: observational (co-measured on one run) vs behavioral
#    (each changes the agent invocation -> its own run). cid + the _behavioral
#    marker come from the sourced dataset/condition adapters.
OBS=""; BEH=""
for c in $CONDS; do
  if declare -f "cond_$(cid "$c")_behavioral" >/dev/null; then BEH="$BEH $c"; else OBS="$OBS $c"; fi
done
OBS="$(echo "$OBS" | xargs)"; BEH="$(echo "$BEH" | xargs)"
log "observational=[$OBS] behavioral=[$BEH]"

# ── concurrency pool with resume-skip ─────────────────────────────────
for task in $LIST; do
  task_done "$task" && { log "SKIP $task (done)"; continue; }
  pool_wait
  log "LAUNCH $task"
  (
    [ -n "$OBS" ] && ds_task "$task" "$OBS"
    for b in $BEH; do ds_task "$task" "$b"; done
  ) &
  sleep 2
done
wait
log "SWEEP DONE: $(grep -c . "$OUT") rows in $OUT"

if [ "$REPORT" = 1 ]; then
  python3 "$HERE/analyze/aggregate.py" "$OUT" > "$(dirname "$OUT")/RESULTS.md" 2>/dev/null \
    && log "report -> $(dirname "$OUT")/RESULTS.md"
fi
