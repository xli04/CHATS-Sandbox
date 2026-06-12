#!/usr/bin/env bash
# Postgres-MCP experience benchmark — Claude Code lane.
#
# Question: does injecting learned easy-win experiences reduce LOCAL disk
# usage of the tier-3 backup (in-DB reversal) vs the default
# scrape-remote-state-to-local behavior?
#
# Conditions:
#   noexp — plugin installed, subagent on, NO experiences file
#   exp   — same + verified postgres experiences injected
#
# Per run: reset benchdb from seed, fresh workspace, run claude (sonnet
# main, haiku subagent) on the task via postgres MCP (user-scope, SSE
# gateway :8011 → chats-pg2 :5433/benchdb).
#
# Output row: task,cond,wall,local_bytes,db_delta,actions,subagent_rows,easywin,op_ok,ec
set -u
TASK_NAME="${1:?task name}"
COND="${2:?cond: noexp|exp}"
REPO=/mnt/data/CHATS-Sandbox
TASKS_FILE=$REPO/benchmarks/pg-tasks.txt
EXP_FILE=$REPO/benchmarks/experiences-samples/postgres-verified-8of8.json
PG="docker exec chats-pg2"
TIMEOUT=420

LINE=$(grep -v '^#' "$TASKS_FILE" | grep "^$TASK_NAME|") || { echo "$TASK_NAME,$COND,-1,-1,-1,-1,-1,no,error,task_not_found"; exit 1; }
INSTR=$(echo "$LINE" | cut -d'|' -f2)
CHECK=$(echo "$LINE" | cut -d'|' -f3)

# ── reset DB to seed (schema-level; gateway pool connections survive) ──
$PG psql -U postgres -d benchdb -qc "
DO \$\$ DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE '\_chats%' OR nspname='public'
  LOOP EXECUTE 'DROP SCHEMA '||quote_ident(s)||' CASCADE'; END LOOP;
  CREATE SCHEMA public;
END \$\$;" 2>/dev/null
$PG pg_restore -U postgres -d benchdb --no-owner /tmp/benchdb.seed.dump 2>/dev/null
ROWS=$($PG psql -U postgres -d benchdb -tc "SELECT count(*) FROM orders" 2>/dev/null | tr -d ' ')
[ "$ROWS" = "30000" ] || { echo "$TASK_NAME,$COND,-1,-1,-1,-1,-1,no,error,db_reset_failed"; exit 1; }
DB_BEFORE=$($PG psql -U postgres -d benchdb -tc "SELECT pg_database_size('benchdb')" | tr -d ' ')

# ── fresh workspace ──
WS=/tmp/pgbench-ws
rm -rf $WS && mkdir -p $WS && cd $WS
git init -q && git config user.email b@x && git config user.name b
echo "postgres benchmark workspace" > README.txt && git add -A && git commit -qm i
node $REPO/dist/cli.js install claude-code > /dev/null 2>&1
node $REPO/dist/cli.js config set subagentTimeoutSeconds 240 > /dev/null 2>&1
if [ "$COND" = "exp" ]; then
  mkdir -p .chats-sandbox/experiences
  cp "$EXP_FILE" .chats-sandbox/experiences/postgres.json
fi

# ── run claude (root needs IS_SANDBOX for bypassPermissions) ──
START=$(date +%s)
IS_SANDBOX=1 timeout $TIMEOUT claude -p "$INSTR" \
  --output-format json --no-session-persistence \
  --dangerously-skip-permissions --model sonnet \
  > /tmp/pgbench-agent.json 2>&1
EC=$?
WALL=$(( $(date +%s) - START ))

# ── measure ──
LOCAL=$(du -sb .chats-sandbox 2>/dev/null | awk '{print $1}'); LOCAL=${LOCAL:-0}
DB_AFTER=$($PG psql -U postgres -d benchdb -tc "SELECT pg_database_size('benchdb')" | tr -d ' ')
DB_DELTA=$((DB_AFTER - DB_BEFORE))
ACTIONS=$(ls .chats-sandbox/backups 2>/dev/null | grep -c ^action_ || echo 0)
SUB_ROWS=$(grep -l '"strategy": "subagent"' .chats-sandbox/backups/action_*/metadata.json 2>/dev/null | wc -l)
EASYWIN=$($PG psql -U postgres -d benchdb -tc "SELECT count(*) FROM pg_namespace WHERE nspname LIKE '\_chats%'" | tr -d ' ')
[ "${EASYWIN:-0}" -gt 0 ] && EASYWIN=yes || EASYWIN=no
OP=$($PG psql -U postgres -d benchdb -tc "$CHECK" 2>/dev/null | tr -d ' ')
[ "$OP" = "t" ] && OP=ok || OP=notdone
echo "$TASK_NAME,$COND,$WALL,$LOCAL,$DB_DELTA,$ACTIONS,$SUB_ROWS,$EASYWIN,$OP,ec=$EC"
