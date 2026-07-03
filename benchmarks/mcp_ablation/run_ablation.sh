#!/usr/bin/env bash
# MCP backup ablation: SKILL-ARMED vs NAIVE tier-3 backup subagent, on
# 10 postgres tasks (benchmarks/pg-tasks.txt) + 10 filesystem tasks (mcpmark).
#
#   arm skills: full experience — playbook injected into the subagent prompt
#               + gate triggers + reverters + capture_tools tool-narrowing
#   arm naive:  NO experience file (all four channels absent); the gate runs
#               in no-knowledge mode (CHATS_SANDBOX_NAIVE_GATE=1): escalate
#               everything not read-only-by-NAME and let the subagent return
#               no_backup_needed — the fail-safe unexplored baseline
#
# Main agent deepseek-v4-pro, backup subagent qwen3.6-35b-a3b (same pairing as
# the reddit qwen ablation, so numbers are comparable). Tasks run PAIRED
# (skills then naive per task) so drift affects both arms equally.
#
#   OPENROUTER_API_KEY=sk-or-... bash benchmarks/mcp_ablation/run_ablation.sh
#   SERVERS="postgres" ... to run one server only.
#
# Results: benchmarks/results/mcpabl/<TAG>.csv + per-run dirs alongside it.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"           # benchmarks/mcp_ablation
BENCH="$(cd "$HERE/.." && pwd)"                 # benchmarks
REPO="$(cd "$BENCH/.." && pwd)"                 # repo root
: "${OPENROUTER_API_KEY:?export OPENROUTER_API_KEY first}"
export PATH="/root/micromamba/envs/chats_sandbox/bin:$PATH"

MAIN_MODEL="${MAIN_MODEL:-deepseek/deepseek-v4-pro}"
SUB_MODEL="${SUB_MODEL:-qwen/qwen3.6-35b-a3b}"
TAG="${RUN_TAG:-abl10}"
SERVERS="${SERVERS:-postgres filesystem}"
ARMS="${ARMS:-skills naive}"          # which arms to run (skills / naive / both)
PARALLEL="${PARALLEL:-1}"             # pg-lane concurrency; needs per-run isolation (below)
PG_TIMEOUT="${PG_TIMEOUT:-900}"
FS_TIMEOUT="${FS_TIMEOUT:-1500}"
SUB_TIMEOUT="${SUB_TIMEOUT:-360}"   # subagentTimeoutSeconds: qwen row-captures overrun the 240s default

PGURL="postgresql://postgres:password@localhost:5433/chats_explore"   # legacy shared DB (fs lane unaffected)
PGADMIN="postgresql://postgres:password@localhost:5433/postgres"      # admin DB for CREATE/DROP DATABASE
FS_SANDBOX="$BENCH/mcp_server/fs-sandbox"
MCP_TASKS_ROOT="${MCP_TASKS_ROOT:-/mnt/data2/OpenAgentSafety/mcpmark-main/tasks/filesystem/standard}"
MCP_ENV_ROOT="${MCP_ENV_ROOT:-/mnt/data2/OpenAgentSafety/mcpmark-main/test_environments}"
EXP_PG="$REPO/self-exploration/results/postgres.json"
EXP_FS="$REPO/self-exploration/results/filesystem.json"
PG_TASKS_FILE="${PG_TASKS_FILE:-$BENCH/pg-tasks.txt}"

OUT="$BENCH/results/mcpabl/$TAG"
mkdir -p "$OUT"
CSV="$OUT/ALL.csv"
[ -f "$CSV" ] || echo "server,task,arm,wall_s,correct,actions,sub_att,sub_ok,sub_fail,tiers,tok_main,tok_sub,dumps,notes" > "$CSV"

log() { echo "[abl $(date +%H:%M:%S)] $*"; }

# ── env resets ───────────────────────────────────────────────────────────
pg_reset() {
  local try n
  for try in 1 2; do
    psql "$PGURL" -q -f "$HERE/pg_seed.sql" >/dev/null 2>&1
    n=$(psql "$PGURL" -tAc "SELECT count(*) FROM orders" 2>/dev/null)
    [ "$n" = "300" ] && return 0
  done
  return 1
}

# stage mcpmark task env at the ROOT of $2 (mirrors datasets/mcp.sh _mcp_stage:
# envs ship nested — a single inner dir holds the real task files).
fs_stage() {
  local task="$1" dest="$2"
  local cat="${task%%/*}" src inner entries only
  src="$MCP_ENV_ROOT/$cat"
  rm -rf "$dest"; mkdir -p "$dest"
  [ -d "$src" ] || return 1
  entries=$(find "$src" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
  inner="$src"
  if [ "$entries" = 1 ]; then
    only=$(find "$src" -mindepth 1 -maxdepth 1)
    [ -d "$only" ] && inner="$only"
  fi
  cp -a "$inner/." "$dest/" 2>/dev/null
  [ -n "$(ls -A "$dest" 2>/dev/null)" ]
}

# ── the 10 filesystem tasks (same set as datasets/mcp.sh) ────────────────
fs_tasks() {
  cat <<'EOF'
papers/author_folders
papers/find_math_paper
file_context/file_merging
file_context/duplicates_searching
folder_structure/structure_mirror
file_property/size_classification
student_database/gradebased_score
legal_document/dispute_review
desktop/timeline_extraction
desktop_template/file_arrangement
EOF
}

# ── one run: <server> <taskname> <arm> ───────────────────────────────────
# expects prompt already at $LOGDIR/prompt.txt and env already reset/staged
run_agent_and_measure() {
  local server="$1" task="$2" arm="$3" timeout_s="$4" LOGDIR="$5" WS="$6"

  # fresh workspace + plugin install (subagent = hermes/qwen)
  rm -rf "$WS"; mkdir -p "$WS"
  ( cd "$WS" && git init -q && git config user.email b@x && git config user.name b \
    && echo "ablation workspace" > README.txt && git add -A && git commit -qm init \
    && node "$REPO/dist/cli.js" install hermes >/dev/null 2>&1 \
    && node "$REPO/dist/cli.js" config set subagentEnabled true >/dev/null \
    && node "$REPO/dist/cli.js" config set subagentRunner hermes >/dev/null \
    && node "$REPO/dist/cli.js" config set subagentHermesModel "$SUB_MODEL" >/dev/null \
    && node "$REPO/dist/cli.js" config set subagentHermesProvider openrouter >/dev/null \
    && node "$REPO/dist/cli.js" config set subagentTimeoutSeconds "$SUB_TIMEOUT" >/dev/null )

  # ARMING (full-package ablation): the skills arm gets the whole learned
  # experience (prompt playbook + gate triggers + reverters + capture_tools
  # narrowing). The naive arm gets NO experience file at all — all four
  # channels absent — and runs the NO-KNOWLEDGE gate instead
  # (CHATS_SANDBOX_NAIVE_GATE=1): escalate every remote action the hardcoded
  # read-only NAME filter can't clear, and the backup subagent itself judges
  # no_backup_needed. Fail-safe coverage without learning; measures what the
  # full experience package buys over that baseline.
  local expfile="" armenv=""
  [ "$server" = postgres ]   && expfile="$EXP_PG"
  [ "$server" = filesystem ] && expfile="$EXP_FS"
  if [ "$arm" = skills ] && [ -f "$expfile" ]; then
    mkdir -p "$WS/.chats-sandbox/experiences"
    cp "$expfile" "$WS/.chats-sandbox/experiences/$server.json"
  fi
  [ "$arm" = naive ] && armenv="CHATS_SANDBOX_NAIVE_GATE=1"

  # ── per-run isolation (concurrency-safe when RUN_HOME/RUN_TMP are set by
  #    the caller): hermes reads HERMES_HOME first, sub-homes land in TMPDIR,
  #    dumps are collected from THIS run's home/tmp only. Sequential callers
  #    that set neither keep the legacy global-home behavior.
  local HERMES_DIR TMPD env_prefix=""
  if [ -n "${RUN_HOME:-}" ]; then
    HERMES_DIR="$RUN_HOME/.hermes"; TMPD="${RUN_TMP:-$WS/tmp}"; mkdir -p "$TMPD"
    env_prefix="HOME=$RUN_HOME HERMES_HOME=$HERMES_DIR TMPDIR=$TMPD"
  else
    HERMES_DIR="$HOME/.hermes"; TMPD="/tmp"
    rm -f "$HERMES_DIR"/sessions/request_dump_* "$HERMES_DIR"/sessions/session_* 2>/dev/null
    rm -rf /tmp/chats-sub-home-* 2>/dev/null
  fi
  mkdir -p "$LOGDIR/dumps" "$LOGDIR/sub-homes"
  sleep 1; touch "$LOGDIR/.start"; sleep 1

  local START WALL
  START=$(date +%s)
  ( cd "$WS" && env $env_prefix $armenv AGENT_TOOLSETS="terminal,file,mcp-$server" HERMES_DUMP_REQUESTS=1 CHATS_KEEP_SUBAGENT_HOME=1 \
      timeout "$timeout_s" hermes chat --toolsets "terminal,file,mcp-$server" \
      -q "$(cat "$LOGDIR/prompt.txt")" -m "$MAIN_MODEL" --provider openrouter -Q --yolo \
      > "$LOGDIR/agent.log" 2>&1 ) || true
  WALL=$(( $(date +%s) - START ))

  # snapshot subagent homes + backups + dumps (from THIS run's tmp + home)
  for h in "$TMPD"/chats-sub-home-*; do [ -d "$h" ] && cp -a "$h" "$LOGDIR/sub-homes/" 2>/dev/null; done
  cp -a "$WS/.chats-sandbox" "$LOGDIR/chats-sandbox" 2>/dev/null
  find "$HERMES_DIR" -name 'request_dump_*.json' -newer "$LOGDIR/.start" -exec cp {} "$LOGDIR/dumps/" \; 2>/dev/null
  find "$LOGDIR/sub-homes" -name 'request_dump_*.json' -exec cp {} "$LOGDIR/dumps/" \; 2>/dev/null

  local ACTIONS SUBB SUBATT SUBFAIL TIERS TOKM="-" TOKS="-" NDUMP
  ACTIONS=$(ls "$WS/.chats-sandbox/backups" 2>/dev/null | grep -c ^action_); ACTIONS=${ACTIONS:-0}
  # recorded subagent artifacts (metadata written = verified + recorded)
  SUBB=$(grep -l '"strategy": "subagent"' "$WS"/.chats-sandbox/backups/action_*/metadata.json 2>/dev/null | wc -l | tr -d ' ')
  # attempts + failures from the subagent log: "tried but timed out / unparseable"
  # is a different story than "no backup fired at all"
  SUBATT=$(grep -ac "invoking:" "$WS/.chats-sandbox/subagent.log" 2>/dev/null); SUBATT=${SUBATT:-0}
  SUBFAIL=$(grep -acE "parse failed|refusing to record|timed out" "$WS/.chats-sandbox/subagent.log" 2>/dev/null); SUBFAIL=${SUBFAIL:-0}
  TIERS=$(python3 - "$WS" <<'PYEOF'
import json,glob,sys
ts=set()
for m in glob.glob(sys.argv[1]+"/.chats-sandbox/backups/action_*/metadata.json"):
    try:
        for a in json.load(open(m)):
            s=a.get("strategy","")
            if "policy" in s: ts.add("T0")
            elif s in ("pip_freeze","file_copy","env_snapshot"): ts.add("T1")
            elif s=="git_snapshot": ts.add("T2")
            elif s=="subagent": ts.add("T3")
            elif s in ("pattern_reverter","deterministic_reverter"): ts.add("REV")
    except Exception: pass
print(" ".join(sorted(ts)) or "none")
PYEOF
)
  NDUMP=$(ls "$LOGDIR"/dumps/request_dump_* 2>/dev/null | wc -l | tr -d ' ')
  if [ "$NDUMP" -gt 0 ]; then
    read TOKM TOKS < <(python3 "$BENCH/analyze/token-sections.py" "$LOGDIR/dumps" pro qwen --totals 2>/dev/null)
    TOKM=${TOKM:-"-"}; TOKS=${TOKS:-"-"}
  fi

  RES_WALL=$WALL; RES_ACTIONS=$ACTIONS; RES_SUBB=$SUBB; RES_SUBATT=$SUBATT; RES_SUBFAIL=$SUBFAIL; RES_TIERS=$TIERS
  RES_TOKM=$TOKM; RES_TOKS=$TOKS; RES_NDUMP=$NDUMP
}

# ── postgres lane ────────────────────────────────────────────────────────
# One pg run, fully isolated: its own database (created from pg_seed.sql), its
# own hermes home (config.yaml rewritten to that DB), its own TMPDIR. Safe to
# run PARALLEL>1 of these — nothing global is touched. CSV appends go through
# flock. Runs in a background subshell, so its RES_* globals stay private.
run_pg_one() {
  local name="$1" instr="$2" check="$3" arm="$4"
  local GI="pg_${name//-/_}-$arm"
  local LOGDIR="$OUT/runs/$GI" WS="/tmp/mcp-abl/$GI"
  rm -rf "$LOGDIR" "$WS"; mkdir -p "$LOGDIR" "$WS"
  local DB; DB="abl_$(echo "$GI" | tr 'A-Z-' 'a-z_' | tr -cd 'a-z0-9_')"
  local DBURL="postgresql://postgres:password@localhost:5433/$DB"

  # per-run DB, seeded fresh
  psql "$PGADMIN" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" 2>/dev/null
  if ! psql "$PGADMIN" -qc "CREATE DATABASE $DB" 2>/dev/null \
     || ! psql "$DBURL" -q -f "$HERE/pg_seed.sql" >/dev/null 2>&1 \
     || [ "$(psql "$DBURL" -tAc 'SELECT count(*) FROM orders' 2>/dev/null)" != "300" ]; then
    log "pg/$name/$arm: DB CREATE/SEED FAILED — skipping"
    ( flock 9; echo "postgres,$name,$arm,-1,error,-1,-1,-1,-1,-,-,-,0,db_seed_failed" >> "$CSV" ) 9>>"$CSV.lock"
    return
  fi

  # per-run hermes home: clone the real one (minus session noise), point its
  # postgres MCP at THIS run's DB. The hook + subagent inherit HERMES_HOME, so
  # the whole backup pipeline runs against the isolated DB too. MUST live
  # OUTSIDE $WS: run_agent_and_measure wipes $WS at entry.
  RUN_HOME="$WS-iso/home"; RUN_TMP="$WS-iso/tmp"
  rm -rf "$WS-iso"; mkdir -p "$RUN_HOME/.hermes" "$RUN_TMP"
  cp -a "$HOME/.hermes/." "$RUN_HOME/.hermes/" 2>/dev/null
  rm -rf "$RUN_HOME/.hermes/sessions" "$RUN_HOME/.hermes/logs" "$RUN_HOME/.hermes/sandboxes" 2>/dev/null
  mkdir -p "$RUN_HOME/.hermes/sessions"
  sed -i "s|localhost:5433/chats_explore|localhost:5433/$DB|" "$RUN_HOME/.hermes/config.yaml"

  printf '%s\n\nThe tables live in the connected database (reachable only through your postgres MCP tools).\n' "$instr" > "$LOGDIR/prompt.txt"
  log "pg/$name/$arm: start (db=$DB)"
  run_agent_and_measure postgres "$name" "$arm" "$PG_TIMEOUT" "$LOGDIR" "$WS"
  local OP; OP=$(psql "$DBURL" -tAc "$check" 2>/dev/null)
  [ "$OP" = "t" ] && OP=pass || OP=fail
  ( flock 9; echo "postgres,$name,$arm,$RES_WALL,$OP,$RES_ACTIONS,$RES_SUBATT,$RES_SUBB,$RES_SUBFAIL,$RES_TIERS,$RES_TOKM,$RES_TOKS,$RES_NDUMP," >> "$CSV" ) 9>>"$CSV.lock"
  log "pg/$name/$arm: done wall=${RES_WALL}s correct=$OP actions=$RES_ACTIONS sub=$RES_SUBATT/$RES_SUBB/$RES_SUBFAIL(att/ok/fail) tiers=$RES_TIERS tokM=$RES_TOKM tokS=$RES_TOKS"
  psql "$PGADMIN" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" 2>/dev/null
  rm -rf "$WS" "$WS-iso"
}

run_pg() {
  # read tasks into arrays first (a while-read pipeline would put the worker
  # jobs in a subshell where `wait` can't see them)
  local names=() instrs=() checks=()
  while IFS='|' read -r name instr check; do
    [ -n "$name" ] || continue
    names+=("$name"); instrs+=("$instr"); checks+=("$check")
  done < <(grep -v '^#' "$PG_TASKS_FILE")

  local i arm
  for ((i=0; i<${#names[@]}; i++)); do
    for arm in $ARMS; do
      while [ "$(jobs -rp | wc -l)" -ge "$PARALLEL" ]; do wait -n; done
      run_pg_one "${names[$i]}" "${instrs[$i]}" "${checks[$i]}" "$arm" &
    done
  done
  wait
}

# ── filesystem lane ──────────────────────────────────────────────────────
run_fs() {
  for task in $(fs_tasks); do
    local name="${task//\//_}"
    local verify="$MCP_TASKS_ROOT/$task/verify.py"
    local descr="$MCP_TASKS_ROOT/$task/description.md"
    if [ ! -f "$verify" ] || [ ! -f "$descr" ]; then
      log "fs/$name: missing verify/description — skipping"
      for arm in $ARMS; do echo "filesystem,$name,$arm,-1,error,-1,-1,-1,-1,-,-,-,0,no_task_files" >> "$CSV"; done
      continue
    fi
    for arm in $ARMS; do
      local GI="fs_${name}-$arm"
      local LOGDIR="$OUT/runs/$GI" WS="/tmp/mcp-abl/$GI"
      rm -rf "$LOGDIR"; mkdir -p "$LOGDIR"
      # TASKDIR sits INSIDE the fs-MCP sandbox root; wipe the whole sandbox
      # so a prior run's leftovers (incl. backup trash dirs) never leak in.
      rm -rf "$FS_SANDBOX"; mkdir -p "$FS_SANDBOX"
      local TASKDIR="$FS_SANDBOX/$GI"
      if ! fs_stage "$task" "$TASKDIR"; then
        log "fs/$name/$arm: STAGE FAILED — skipping"
        echo "filesystem,$name,$arm,-1,error,-1,-1,-1,-1,-,-,-,0,stage_failed" >> "$CSV"
        continue
      fi
      {
        cat "$descr"
        printf '\n\n----\nWORKING DIRECTORY: all files for this task live in the directory %s\n' "$TASKDIR"
        printf 'Operate ONLY inside that directory, and ONLY through the filesystem MCP tools (the "filesystem" server: read_text_file, write_file, edit_file, create_directory, move_file, delete_file, list_directory, directory_tree, ...). Paths you pass to the MCP tools must be absolute, e.g. %s/...\n' "$TASKDIR"
      } > "$LOGDIR/prompt.txt"
      log "fs/$name/$arm: start"
      run_agent_and_measure filesystem "$name" "$arm" "$FS_TIMEOUT" "$LOGDIR" "$WS"
      local OP="fail"
      if FILESYSTEM_TEST_DIR="$TASKDIR" python3 "$verify" > "$LOGDIR/verify.log" 2>&1; then OP="pass"; fi
      echo "filesystem,$name,$arm,$RES_WALL,$OP,$RES_ACTIONS,$RES_SUBATT,$RES_SUBB,$RES_SUBFAIL,$RES_TIERS,$RES_TOKM,$RES_TOKS,$RES_NDUMP," >> "$CSV"
      log "fs/$name/$arm: done wall=${RES_WALL}s correct=$OP actions=$RES_ACTIONS sub=$RES_SUBATT/$RES_SUBB/$RES_SUBFAIL(att/ok/fail) tiers=$RES_TIERS tokM=$RES_TOKM tokS=$RES_TOKS"
      rm -rf "$WS" "$TASKDIR"
    done
  done
}

log "ablation start: tag=$TAG servers=[$SERVERS] arms=[$ARMS] parallel=$PARALLEL main=$MAIN_MODEL sub=$SUB_MODEL"
for s in $SERVERS; do
  case "$s" in
    postgres)   run_pg ;;
    filesystem) run_fs ;;
    *) log "unknown server '$s' — skipping" ;;
  esac
done
log "ablation DONE -> $CSV"
