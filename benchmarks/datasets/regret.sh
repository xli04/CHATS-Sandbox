#!/usr/bin/env bash
# Dataset adapter: RegretBench (L2 "I should've backed this up first" actions).
# Thin BRIDGE to the existing RegretBench/runner.sh, mapping its damage/coverage
# output into the unified row. RegretBench measures RECOVERY quality (similarity
# after restore), not SWE-style coverage classes — so cov_* stay "-" and the
# coverage-similarity lands in the recovery column; verdict detail -> notes.
# Conditions: plugin (our backup) vs nobackup (baseline, coverage==damage).
RB="$HERE/RegretBench"
ds_tasks() { ls "$RB/tasks" 2>/dev/null; }
cid() { echo "${1//-/}"; }
# regret self-contains its env per task inside runner.sh; primitives are nominal
denv_exec() { bash -c "$1"; }; denv_cp() { cp -a "$1" "$2" 2>/dev/null; }; denv_workdir() { echo /tmp; }

ds_task() {
  local task="$1"; local GC="${2:-$CONDS}"
  for c in $GC; do
    local rc="nobackup"; [ "$c" = plugin ] && rc="plugin"
    # runner.sh emits: task,cond,damage,coverage,...,notes  (or a -1 failure row)
    local line; line=$(DS_MODEL="$MODEL" bash "$RB/runner.sh" "$task" "$rc" 2>/dev/null | grep -E "^$task," | tail -1)
    local dmg cov; dmg=$(echo "$line" | awk -F, '{print $3}'); cov=$(echo "$line" | awk -F, '{print $4}')
    [ -z "$line" ] && { emit_row "$task" "$c" -1 -1 -1 - - - - - "regret_runner_no_output"; continue; }
    emit_row "$task" "$c" - - - - - "${cov:--}" - - "regret;runner_cond=$rc;damage=${dmg:--};coverage=${cov:--}"
  done
}
