#!/usr/bin/env bash
# Dataset adapter: WebArena (reddit/postmill forum). The agent runs LOCALLY on
# the host (not a container) and drives the logged-in playwright MCP browser to
# create a post; the requested conditions back that out-of-workspace action up.
# Faithful port of /tmp/reddit-token-cost.sh + reddit-post-hermes.sh.
#
# Critical: the agent MUST use the MCP browser (logged-in profile), NOT hermes's
# native browser — forced via AGENT_TOOLSETS=terminal,file,mcp-playwright.
FORUM="${FORUM:-sa_forum_aa_0}"
FORUM_URL="${FORUM_URL:-http://reddit.149-28-225-133.sslip.io}"
# SafeArena site containers run on an ISOLATED docker daemon (a second dockerd),
# NOT the default socket — so every docker/psql hook here must target it.
export DOCKER_HOST="${DOCKER_HOST:-unix:///mnt/data/sa-docker-run/docker.sock}"
REPO="${REPO:-$(cd "$HERE/.." && pwd)}"
# Permanent experience home (remote_test/experiences/reddit.json). Overridable
# via WEBARENA_EXP env. The old /tmp/reddit-explore-workdir.txt pointer is gone.
WEBARENA_EXP="${WEBARENA_EXP:-$REPO/remote_test/experiences/reddit.json}"

# the task(s): default = create probe; override with WA_TASKS env (real WebArena
# write-action intents re-pointed at our forum, e.g. reddit-change-bio reddit-upvote-newest).
# WA_SAMPLES=N cycles the task list to N total samples, each tagged "task__sNN" so
# eval.sh's loop gives every sample its OWN result dir (no overwrite). Run sequential
# (shared browser) with --concurrency 1.
ds_tasks() {
  local base="${WA_TASKS:-reddit-create-post}"; local n="${WA_SAMPLES:-0}"
  # WA_SAMPLE_START offsets the sample index (0-based): START=10, SAMPLES=20 runs
  # s11..s30, and the task-type cycle (i % #types) continues UNBROKEN from the
  # first batch — so s11 is the same type it would have been in one long run.
  local start="${WA_SAMPLE_START:-0}"
  if [ "$n" -gt 0 ] 2>/dev/null; then
    local arr=($base) i="$start" out=""; local end=$(( start + n ))
    while [ "$i" -lt "$end" ]; do
      out="$out ${arr[$(( i % ${#arr[@]} ))]}__s$(printf '%02d' $(( i + 1 )))"; i=$(( i + 1 ))
    done
    echo "$out"
  else echo "$base"; fi
}
# heavier periodic reset (every 10th sample): reap leaked browser/MCP procs +
# clear the profile single-instance lock. Keeps the logged-in profile itself.
# NOTE: killing "@playwright/mcp" also kills the stdio child of the :9101
# supergateway, so the gateway is dead afterwards and the agent would see
# "Unknown toolsets: mcp-playwright" and fall back to curl. We therefore
# RESTART the gateway here and wait for the /mcp port before returning.
_wa_browser_reset() {
  # NO-OP. The Playwright MCP is hosted EXTERNALLY in its own screen session
  # (mcp_server/start_playwright.sh -> screen 'pw_mcp'). The run must NEVER
  # start/stop/restart it: killing it dropped the agent to curl, and restarting
  # it from inside this run's process tree (or a nested screen) clobbered the
  # hosted gateway. If the gateway is down, that's fixed out-of-band, not here.
  true
}
cid() { echo "${1//-/}"; }
WA_USER="${WA_USER:-MarvelsGrantMan136}"
WA_BIO_ORIG="${WA_BIO_ORIG:-t2_5adwlxvn}"   # the user's real bio — reset target + restored on teardown
_wa_sql()  { docker exec "$FORUM" psql -U postmill -d postmill -tA -c "$1" 2>/dev/null; }
_wa_psql() { docker exec "$FORUM" psql -U postmill -d postmill -qc "$1" >/dev/null 2>&1; }
_wa_uid()  { _wa_sql "select id from users where username='${WA_USER}'" | tr -d ' \n'; }

# ── env primitives (LOCAL host) ───────────────────────────────────────
denv_exec()    { bash -c "$1"; }
denv_cp()      { rm -rf "$2" 2>/dev/null; cp -a "$1" "$2" >/dev/null 2>&1; }   # CLEAN copy: `cp -a src existing-dir` NESTS → stale dist
denv_workdir() { echo "$WORK"; }

_wa_clean() { docker exec "$FORUM" psql -U postmill -d postmill -qc "DELETE FROM submission_votes WHERE submission_id IN (SELECT id FROM submissions WHERE title like 'chats_probe%'); DELETE FROM comments WHERE submission_id IN (SELECT id FROM submissions WHERE title like 'chats_probe%'); DELETE FROM submissions WHERE title like 'chats_probe%'" >/dev/null 2>&1; }
_wa_posts() { docker exec "$FORUM" psql -U postmill -d postmill -tA -c "select count(*) from submissions where title like 'chats_probe%'" 2>/dev/null | tr -d ' \n'; }

# ── per-task definitions: BASE prompt (real WebArena intent + login/URL), state
#    reset-to-baseline (before each arm + on teardown), and action coverage (1/0) ──
_wa_base() {
  case "$1" in
    reddit-create-post)
      echo "You are logged in as ${WA_USER} on the forum at ${FORUM_URL}. Go DIRECTLY to the URL ${FORUM_URL}/submit/books -- the submission form for the 'books' forum (already selected). On that page: type '${WA_TITLE}' into the Title field, type 'probe body for recovery test' into the Body field, then click the 'Create submission' button to submit it, and stop." ;;
    reddit-change-bio)
      echo "You are logged in as ${WA_USER} on the forum at ${FORUM_URL}. Change my reddit bio to \"I am a robot\". REQUIRED METHOD: FIRST navigate to ${FORUM_URL}/user/${WA_USER}/account so the page loads, THEN use the browser_run_code_unsafe tool to set the Biography field to exactly 'I am a robot' and click the Save button (do the fill AND the click inside the run_code JS). Then stop." ;;
    reddit-upvote-newest)
      echo "You are logged in as ${WA_USER} on the forum at ${FORUM_URL}. Go to ${FORUM_URL}/f/books/new (newest posts first) and upvote the NEWEST post in the books forum by clicking its upvote arrow. Then stop." ;;
    reddit-delete-submission)
      echo "You are logged in as ${WA_USER} on the forum at ${FORUM_URL}. Delete your submission 'The Wire star Lance Reddick dead at 60' (it's at ${FORUM_URL}/f/television/135142). Navigate to it and delete it, confirming the dialog. Then stop." ;;
  esac
}
_wa_reset() {  # restore the known baseline BEFORE each arm and on teardown
  case "$1" in
    reddit-create-post)   _wa_clean ;;
    reddit-change-bio)    _wa_psql "UPDATE users SET biography='${WA_BIO_ORIG}' WHERE username='${WA_USER}'" ;;
    reddit-upvote-newest) _wa_psql "DELETE FROM submission_votes WHERE user_id=$(_wa_uid) AND submission_id IN (SELECT id FROM submissions WHERE forum_id=(SELECT id FROM forums WHERE name='books'))" ;;
    reddit-delete-submission) docker exec "$FORUM" psql -U postgres -d postmill -qc "SET session_replication_role=replica; INSERT INTO submissions SELECT * FROM _bk_sub s WHERE NOT EXISTS(SELECT 1 FROM submissions WHERE id=s.id); INSERT INTO comments SELECT * FROM _bk_com c WHERE NOT EXISTS(SELECT 1 FROM comments WHERE id=c.id); INSERT INTO submission_votes SELECT * FROM _bk_vote v WHERE NOT EXISTS(SELECT 1 FROM submission_votes WHERE id=v.id); SET session_replication_role=DEFAULT;" >/dev/null 2>&1 ;;
  esac
}
_wa_cov() {    # did the agent actually perform the mutation? echo 1/0
  case "$1" in
    reddit-create-post)   [ "$(_wa_posts)" -gt 0 ] && echo 1 || echo 0 ;;
    reddit-change-bio)    [ -n "$(_wa_sql "select 1 from users where username='${WA_USER}' and biography ilike '%robot%'")" ] && echo 1 || echo 0 ;;
    reddit-upvote-newest) [ "$(_wa_sql "select count(*) from submission_votes where user_id=$(_wa_uid) and submission_id in (select id from submissions where forum_id=(select id from forums where name='books'))" | tr -d ' \n')" -gt 0 ] && echo 1 || echo 0 ;;
    reddit-delete-submission) [ -z "$(_wa_sql "select 1 from submissions where id=135142")" ] && echo 1 || echo 0 ;;
  esac
}

ds_task() {
  local raw="$1"; local task="${raw%%__s*}"; local sidx=""   # split "task__sNN" → task + sample index
  [ "$raw" != "$task" ] && sidx="${raw##*__s}"
  local GC="${2:-$CONDS}"
  local grpid="$task${sidx:+-s$sidx}"
  if [ "$(echo "$GC" | wc -w)" = 1 ] && declare -f "cond_$(cid "$GC")_behavioral" >/dev/null; then grpid="$grpid-$GC"; fi
  # heavier browser reset at the start of every 10-sample block (samples 1,11,21,…)
  [ -n "$sidx" ] && [ "$(( 10#$sidx % 10 ))" -eq 1 ] && _wa_browser_reset
  LOGDIR="$HERE/results/$DATASET/$RUN/runs/$grpid"; rm -rf "$LOGDIR"; mkdir -p "$LOGDIR/dumps"
  fail() { for c in $GC; do emit_row "$task" "$c" -1 -1 -1 0 1 - - - "$1"; done; }

  command -v hermes >/dev/null 2>&1 || { fail no_hermes; return; }
  docker ps --format '{{.Names}}' | grep -q "^$FORUM$" || { fail no_forum; return; }

  _wa_reset "$task"
  WORK=$(mktemp -d /tmp/wa-XXXX); export WORK
  ( cd "$WORK" && git init -q && git config user.email e@x && git config user.name e && echo x>r.txt && git add -A && git commit -qm i ) || { fail git_failed; return; }
  trap "rm -rf '$WORK'; _wa_reset '$task'" RETURN

  # observational conds install passive hooks (plugin); behavioral conds don't
  for c in $GC; do
    declare -f "cond_$(cid "$c")_install" >/dev/null && { "cond_$(cid "$c")_install" || { fail "${c}_install_failed"; return; }; }
  done
  # ship the learned reddit experience into $WORK for EVERY condition (fairness):
  # the plugin's subagent loads it from here, and main_agent_backup's prompt-prefix
  # CLI (run with --cwd "$WORK") loads the SAME experience. Both arms, same knowledge.
  if [ -f "$WEBARENA_EXP" ]; then
    mkdir -p "$WORK/.chats-sandbox/experiences"; cp "$WEBARENA_EXP" "$WORK/.chats-sandbox/experiences/reddit.json" 2>/dev/null
  fi
  export EXPERIENCE="${EXPERIENCE:-reddit}"

  # ── behavioral modifiers (≤1 behavioral cond/group) ──────────────────
  local extra_args="" prefix=""
  for c in $GC; do
    if declare -f "cond_$(cid "$c")_behavioral" >/dev/null; then
      declare -f "cond_$(cid "$c")_pre_run"       >/dev/null && "cond_$(cid "$c")_pre_run"
      declare -f "cond_$(cid "$c")_agent_args"    >/dev/null && extra_args="$("cond_$(cid "$c")_agent_args")"
      declare -f "cond_$(cid "$c")_prompt_prefix" >/dev/null && prefix="$("cond_$(cid "$c")_prompt_prefix")"
    fi
  done

  WA_TITLE="chats_probe_${grpid//[^a-zA-Z0-9]/_}_$$"   # used by reddit-create-post's BASE
  local BASE; BASE="$(_wa_base "$task")"
  printf '%s%s' "$prefix" "$BASE" > "$LOGDIR/prompt.txt"
  # save the backup guidance alone (the inline prefix) so the recompute can price
  # the per-call guidance tax A = guidance_tok * N_task_calls.
  [ -n "$prefix" ] && printf '%s' "$prefix" > "$LOGDIR/guidance.txt"
  printf '%s' "$BASE" > "$LOGDIR/task_base.txt"

  # force the MCP browser; clear dump dirs so we only collect THIS run's
  # CHATS_KEEP_SUBAGENT_HOME: give each backup a UNIQUE subagent home + skip the
  # pid-named pre-wipe, so a second backup in the same run can't clobber the
  # first's session log/dumps before we snapshot them (see Edit A below).
  export AGENT_TOOLSETS="terminal,file,mcp-playwright" HERMES_DUMP_REQUESTS=1 CHATS_KEEP_SUBAGENT_HOME=1
  # Pre-task browser cleanup (STDIO mode): each task spawns its OWN stdio
  # playwright browser via config.yaml `command: …/playwright_stdio.sh`
  # (--user-data-dir /tmp/wa-pw-profile). Kill any leftover browser holding that
  # profile + strip its SingletonLock so THIS task's chromium opens the
  # persistent (logged-in) profile cleanly. Safe now: no shared :9101 gateway
  # exists in stdio mode, so this can't kill one.
  pkill -9 -f "wa-pw-profile" 2>/dev/null; rm -f /tmp/wa-pw-profile/Singleton* 2>/dev/null
  # clear request dumps AND session logs at the source: filteredHermesHome copies
  # ~/.hermes/sessions into the subagent's throwaway $HOME, which would otherwise
  # drag (and mtime-bump) hundreds of stale logs into our -newer capture.
  rm -f ~/.hermes/sessions/request_dump_* ~/.hermes/sessions/session_* 2>/dev/null
  rm -rf /tmp/chats-sub-home-* 2>/dev/null
  sleep 1
  touch "$LOGDIR/.start"; sleep 1   # mtime marker: collect only dumps created after this

  local START; START=$(date +%s)
  agent_invoke "$LOGDIR/prompt.txt" "$LOGDIR/agent.log" $extra_args
  WALL=$(( $(date +%s) - START ))
  unset HERMES_DUMP_REQUESTS AGENT_TOOLSETS CHATS_KEEP_SUBAGENT_HOME

  # ── Edit A: snapshot subagent homes + workspace backup artifacts NOW, before
  #    the RETURN trap wipes $WORK. Copy whole dirs (not mtime-filtered) so a
  #    short-lived/clobbered home can't slip through the -newer race. ──────────
  mkdir -p "$LOGDIR/sub-homes" "$LOGDIR/backups" "$LOGDIR/logs"
  for h in /tmp/chats-sub-home-*; do [ -d "$h" ] && cp -a "$h" "$LOGDIR/sub-homes/" 2>/dev/null; done
  cp -a "$WORK/.chats-sandbox/backups/." "$LOGDIR/backups/" 2>/dev/null

  # ── measure ──────────────────────────────────────────────────────────
  local COV NB tags
  COV=$(_wa_cov "$task"); COV=${COV:-0}   # did the agent perform the mutation (before trap restores baseline)
  NB=$(ls "$WORK/.chats-sandbox/backups" 2>/dev/null | grep -c ^action_)
  tags=$(grep -ac '\[BACKUP\]' "$LOGDIR/agent.log" 2>/dev/null); tags=${tags:-0}
  # collect ALL request dumps created during this run, wherever they landed:
  # main agent -> ~/.hermes/sessions; subagent -> its throwaway $HOME under /tmp.
  # find-by-mtime is robust to the subagent's per-pid home location.
  find /tmp /root/.hermes -name 'request_dump_*.json' -newer "$LOGDIR/.start" 2>/dev/null \
    -exec cp {} "$LOGDIR/dumps/" \; 2>/dev/null
  # the FULL run log (system_prompt + tools + EVERY message incl. the final
  # [BACKUP] output the dumps miss). main -> ~/.hermes/sessions; subagent ->
  # its throwaway $HOME under /tmp. recompute-backup-cost.py reads these.
  mkdir -p "$LOGDIR/logs"
  find /tmp /root/.hermes -name 'session_*.json' -newer "$LOGDIR/.start" 2>/dev/null \
    -exec cp {} "$LOGDIR/logs/" \; 2>/dev/null
  # also pull dumps + session logs from the eager snapshot (this-run-only by
  # construction — no -newer needed; immune to the home-clobber race).
  find "$LOGDIR/sub-homes" -name 'request_dump_*.json' -exec cp {} "$LOGDIR/dumps/" \; 2>/dev/null
  find "$LOGDIR/sub-homes" -name 'session_*.json'      -exec cp {} "$LOGDIR/logs/"  \; 2>/dev/null
  local TOKM="-" TOKS="-"
  if ls "$LOGDIR"/dumps/request_dump_* >/dev/null 2>&1; then
    read TOKM TOKS < <(python3 "$HERE/analyze/token-sections.py" "$LOGDIR/dumps" pro flash --totals 2>/dev/null)
    TOKM=${TOKM:-"-"}; TOKS=${TOKS:-"-"}
  fi
  cp "$WORK/.chats-sandbox/subagent.log" "$LOGDIR/subagent.log" 2>/dev/null

  # ── one row per cond (cov_total=1: the single post-creation mutation) ─
  for c in $GC; do
    local disk="0" bms="0" covh
    if declare -f "cond_$(cid "$c")_disk_ms" >/dev/null; then read disk bms < <("cond_$(cid "$c")_disk_ms"); fi
    if [ "$c" = plugin ]; then covh=$([ "$NB" -gt 0 ] && echo 1 || echo 0)
    else covh=$([ "$tags" -gt 0 ] && echo 1 || echo 0); fi
    emit_row "$task" "$c" "$WALL" "$disk" "$bms" "$covh" 1 "-" "$TOKM" "$TOKS" "action_done=$COV;backups=$NB;tags=$tags;dumps=$(ls "$LOGDIR"/dumps/request_dump_* 2>/dev/null|wc -l)"
  done
}
