#!/usr/bin/env bash
# Dataset adapter: SWE-bench. One task = one swebench instance container.
# Per task: fix the GitHub issue, then run a fixed "drill" of out-of-workspace
# actions, with the requested conditions' hooks all firing on the identical
# action sequence. Faithful port of swe-bench-dual.sh, generalized to N conds.
SWE_DIR="$HERE/datasets/swe"
INSTANCES="${INSTANCES:-/mnt/data/swe-stress/subset30.jsonl}"

ds_tasks() { python3 -c "import json;print('\n'.join(json.loads(l)['instance_id'] for l in open('$INSTANCES')))"; }

# cond name -> function-safe id (git-add -> gitadd, cp-all -> cpall)
cid() { echo "${1//-/}"; }

# ── env primitives (container) used by agent + condition helpers ──────
denv_exec()    { docker exec -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" "$CTX" bash -c "$1"; }
denv_cp()      { docker cp "$1" "$CTX:$2" >/dev/null 2>&1; }
denv_workdir() { echo /testbed; }

_snap() { denv_exec "python3 /opt/manifest.py /tmp/$1.json" >/dev/null 2>&1; docker cp "$CTX:/tmp/$1.json" "$LOGDIR/$1.json" >/dev/null 2>&1; }

ds_task() {
  local task="$1"; local GC="${2:-$CONDS}"   # GC = conditions for THIS run-group
  local IMG="swebench/sweb.eval.x86_64.${task//__/_1776_}:latest"
  # behavioral single-cond groups get a suffixed run dir/container so they don't
  # collide with the observational group's logs.
  local grpid="$task"
  if [ "$(echo "$GC" | wc -w)" = 1 ] && declare -f "cond_$(cid "$GC")_behavioral" >/dev/null; then grpid="$task-$GC"; fi
  LOGDIR="$HERE/results/$DATASET/$RUN/runs/$grpid"; mkdir -p "$LOGDIR"
  CTX="sweval-${grpid//[^a-zA-Z0-9]/_}-$$"
  fail() { for c in $GC; do emit_row "$task" "$c" -1 -1 -1 0 0 - - - "$1"; done; }

  local cached=0; docker images --format '{{.Repository}}:{{.Tag}}' | grep -q "$IMG" && cached=1
  if [ "$cached" = 0 ]; then docker pull -q "$IMG" >/dev/null 2>>"$LOGDIR/err.log" || { fail pull_failed; return; }; fi
  docker run -d --name "$CTX" "$IMG" sleep infinity >/dev/null 2>&1 || { fail container_failed; [ "$cached" = 0 ] && docker rmi -f "$IMG" >/dev/null 2>&1; return; }
  trap "docker rm -f '$CTX' >/dev/null 2>&1; [ '$cached' = 0 ] && docker rmi -f '$IMG' >/dev/null 2>&1" RETURN

  agent_install || { fail agent_failed; return; }
  # observational conds install passive hooks; behavioral conds have no _install
  for c in $GC; do
    declare -f "cond_$(cid "$c")_install" >/dev/null && { "cond_$(cid "$c")_install" || { fail "${c}_install_failed"; return; }; }
  done
  denv_exec "mkdir -p /testbed/.hermes/plugins"
  denv_cp "$SWE_DIR/observer.py" /testbed/.hermes/plugins/observer.py
  denv_cp "$SWE_DIR/manifest.py" /opt/manifest.py

  # ── behavioral modifiers (≤1 behavioral cond per group): extra agent args,
  #    a pre-run env hook, and/or a prompt prefix prepended to every prompt ──
  local extra_args="" prefix=""
  for c in $GC; do
    if declare -f "cond_$(cid "$c")_behavioral" >/dev/null; then
      declare -f "cond_$(cid "$c")_pre_run"       >/dev/null && "cond_$(cid "$c")_pre_run"
      declare -f "cond_$(cid "$c")_agent_args"    >/dev/null && extra_args="$("cond_$(cid "$c")_agent_args")"
      declare -f "cond_$(cid "$c")_prompt_prefix" >/dev/null && prefix="$("cond_$(cid "$c")_prompt_prefix")"
    fi
  done
  _snap s0

  # ── build the issue prompt on the host, copy in ──────────────────────
  python3 - "$INSTANCES" "$task" > "$LOGDIR/instr.txt" <<'PY'
import json, sys
inst, task = sys.argv[1], sys.argv[2]
r = next(json.loads(l) for l in open(inst) if json.loads(l)["instance_id"] == task)
h = ("You are working in the git repo at /testbed (a real Python project). Below is a GitHub\n"
     "issue. Fix it by modifying the source. Python env is conda env 'testbed'\n"
     "(/opt/miniconda3/envs/testbed/bin/python). Do not commit; leave changes in the tree.\n\nISSUE:\n")
print(h + r["problem_statement"])
PY
  cp "$SWE_DIR/drill.txt" "$LOGDIR/drill.txt"
  if [ -n "$prefix" ]; then     # prepend the behavioral preamble (inline)
    printf '%s\n%s' "$prefix" "$(cat "$LOGDIR/instr.txt")" > "$LOGDIR/instr.txt"
    printf '%s\n%s' "$prefix" "$(cat "$LOGDIR/drill.txt")" > "$LOGDIR/drill.txt"
  fi
  denv_cp "$LOGDIR/instr.txt" /tmp/instr.txt
  denv_cp "$LOGDIR/drill.txt" /tmp/drill.txt

  # ── run the issue (timed) + the drill ────────────────────────────────
  local START; START=$(date +%s)
  agent_invoke /tmp/instr.txt /tmp/agent-out.log $extra_args
  WALL=$(( $(date +%s) - START ))
  TIMEOUT=600 agent_invoke /tmp/drill.txt /tmp/drill-out.log $extra_args

  # ── shared coverage from the observer log ────────────────────────────
  local INWS OUT_C
  read INWS OUT_C < <(denv_exec "python3 -c \"
import json,collections
c=collections.Counter()
try:
    for l in open('/testbed/.observer.jsonl'):
        if l.strip(): c[json.loads(l)['class']]+=1
except Exception: pass
print(c['inws'], c['outside'])\"")
  INWS=${INWS:-0}; OUT_C=${OUT_C:-0}; local COV_T=$((INWS + OUT_C))

  # ── plugin tiers + recovery (only if plugin in this group) ───────────
  local TIERS="none" RECOVERY="-"
  if echo "$GC" | grep -qw plugin; then
    TIERS=$(cond_plugin_tiers)
    cond_plugin_restore; _snap s2
    RECOVERY=$(python3 -c "
import json
def sim(a,b):
    p=set(a)|set(b); return 1.0 if not p else sum(1 for k in p if a.get(k)==b.get(k))/len(p)
try:
    s0=json.load(open('$LOGDIR/s0.json')); s2=json.load(open('$LOGDIR/s2.json')); print(round(sim(s0,s2),4))
except Exception: print('-')")
  fi

  # ── forensics ────────────────────────────────────────────────────────
  for f in agent-out drill-out; do docker cp "$CTX:/tmp/$f.log" "$LOGDIR/$f.log" >/dev/null 2>&1 || true; done
  docker cp "$CTX:/testbed/.observer.jsonl" "$LOGDIR/observer.jsonl" >/dev/null 2>&1 || true
  local tags; tags=$(grep -ac '\[BACKUP\]' "$LOGDIR/agent-out.log" 2>/dev/null); tags=${tags:-0}

  # ── one row per condition in this group (identical actions) ──────────
  for c in $GC; do
    local disk bms covh
    read disk bms < <("cond_$(cid "$c")_disk_ms")
    covh=$("cond_$(cid "$c")_coverage" "$INWS" "$OUT_C" "$TIERS")
    local rec="-"; [ "$c" = plugin ] && rec="$RECOVERY"
    emit_row "$task" "$c" "$WALL" "$disk" "$bms" "$covh" "$COV_T" "$rec" - - "tiers=$TIERS;inws=$INWS;out=$OUT_C;tags=$tags;args=${extra_args:-none}"
  done
}
