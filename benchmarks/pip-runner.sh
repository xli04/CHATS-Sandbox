#!/usr/bin/env bash
# Pip-environment benchmark — does the plugin beat always-shadow where the
# mutation happens OUTSIDE the worktree (site-packages)?
#
# Tracks, per run:
#   extra disk   — bytes in the condition's backup store
#   extra time   — (a) summed PreToolUse hook wall (ms, in-container log)
#                  (b) whole-run wall (compare against cond=none)
#   recovery     — pip freeze before / after agent / after restore;
#                  restore_pct = % of original packages back at their
#                  exact original version after the condition's restore
#
# Conditions: none | plugin | git-add | cp-all      Agent: claude (sonnet)
# Row: task,cond,wall,backup_bytes,hook_ms,actions,changed,restore_pct,extras,done,notes
set -u
TASK_NAME="${1:?task}"; COND="${2:?cond}"
REPO=/mnt/data/CHATS-Sandbox
NODE_TAR=/mnt/data/chats-bench-cache/node-v24.14.1-linux-x64.tar.gz
TIMEOUT=360
LINE=$(grep -v '^#' $REPO/benchmarks/pip-tasks.txt | grep "^$TASK_NAME|") || { echo "$TASK_NAME,$COND,-1,-1,-1,-1,-1,-1,-1,error,task_not_found"; exit 1; }
INSTR=$(echo "$LINE" | cut -d'|' -f2)
CHECK=$(echo "$LINE" | cut -d'|' -f3)

C="pipbench-$$"
docker run -d --name "$C" python:3.12 sleep infinity > /dev/null || { echo "$TASK_NAME,$COND,-1,-1,-1,-1,-1,-1,-1,error,container_failed"; exit 1; }
trap 'docker rm -f "$C" > /dev/null 2>&1' EXIT

# ── base setup: node, claude, creds, seed env ─────────────────────────
docker cp "$NODE_TAR" "$C:/opt/node.tar.gz"
docker cp /root/.claude/.credentials.json "$C:/root/.claude-cred.json"
docker cp /root/.claude.json "$C:/root/.claude.json"
docker exec "$C" bash -c '
  set -e
  mkdir -p /opt/node /root/.claude /app
  tar -xzf /opt/node.tar.gz -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  /opt/node/bin/npm install -g @anthropic-ai/claude-code --silent
  ln -sf /opt/node/bin/claude /usr/local/bin/claude
  mv /root/.claude-cred.json /root/.claude/.credentials.json
  chmod 600 /root/.claude/.credentials.json
  pip install -q requests==2.31.0 flask==2.3.3 click==8.1.3 2>/dev/null
  cd /app && git init -q && git config user.email b@x && git config user.name b
  echo "python project workspace" > README.md && git add -A && git commit -qm init
  pip freeze > /tmp/state_before.txt
  # hook timer wrapper: stdin/stdout pass through, wall ms appended
  cat > /opt/hooktimer.sh <<"EOF"
#!/bin/bash
S=$(date +%s%3N); "$@"; RC=$?; E=$(date +%s%3N)
echo $((E-S)) >> /app/.hook-times.log
exit $RC
EOF
  chmod +x /opt/hooktimer.sh
' > /tmp/pipbench-setup.log 2>&1 || { tail -5 /tmp/pipbench-setup.log >&2; echo "$TASK_NAME,$COND,-1,-1,-1,-1,-1,-1,-1,error,setup_failed"; exit 1; }

# ── condition wiring ─────────────────────────────────────────────────
case "$COND" in
  none) : ;;
  plugin)
    docker exec "$C" mkdir -p /opt/chats-sandbox
    docker cp $REPO/dist     "$C:/opt/chats-sandbox/dist"
    docker cp $REPO/commands "$C:/opt/chats-sandbox/commands"
    docker exec "$C" bash -c '
      cd /app && node /opt/chats-sandbox/dist/cli.js install claude-code > /dev/null
      node /opt/chats-sandbox/dist/cli.js config set subagentEnabled false > /dev/null
      python3 - <<"EOF"
import json
p = "/app/.claude/settings.json"
d = json.load(open(p))
for m in d.get("hooks", {}).get("PreToolUse", []):
    for h in m.get("hooks", []):
        h["command"] = "/opt/hooktimer.sh " + h["command"]
json.dump(d, open(p, "w"), indent=2)
EOF
    ' || { echo "$TASK_NAME,$COND,-1,-1,-1,-1,-1,-1,-1,error,plugin_install_failed"; exit 1; }
    ;;
  git-add|cp-all)
    docker exec "$C" bash -c '
      mkdir -p /app/.baseline /app/.claude
      if [ "'"$COND"'" = git-add ]; then
        mkdir -p /app/.baseline/shadow /app/.baseline/shadow/info
        printf ".baseline\n.claude\n" > /app/.baseline/shadow/info/exclude
        cat > /app/.baseline/hook.sh <<"EOF"
#!/usr/bin/env bash
cd /app
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git init -q 2>/dev/null || true
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git config user.email b@x
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git config user.name b
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git add -A 2>/dev/null
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git commit -qm snap --allow-empty-message --allow-empty 2>/dev/null
exit 0
EOF
      else
        mkdir -p /app/.baseline/trash
        cat > /app/.baseline/hook.sh <<"EOF"
#!/usr/bin/env bash
N=$(ls /app/.baseline/trash 2>/dev/null | wc -l)
SEQ=$(printf "%03d" $((N+1)))
mkdir -p /app/.baseline/trash/action_$SEQ
find /app -mindepth 1 -maxdepth 1 ! -name .baseline ! -name .claude -print0 2>/dev/null \
  | xargs -0 -I{} cp -a {} /app/.baseline/trash/action_$SEQ/ 2>/dev/null
exit 0
EOF
      fi
      chmod +x /app/.baseline/hook.sh
      cat > /app/.claude/settings.json <<EOF
{"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "/opt/hooktimer.sh /app/.baseline/hook.sh"}]}]}}
EOF
    ' ;;
  *) echo "$TASK_NAME,$COND,-1,-1,-1,-1,-1,-1,-1,error,unknown_condition"; exit 1 ;;
esac

# ── run the agent ────────────────────────────────────────────────────
START=$(date +%s)
docker exec -e IS_SANDBOX=1 -e HOME=/root "$C" bash -c "
  cd /app && timeout $TIMEOUT claude -p \"\$(cat <<'P'
$INSTR
P
)\" --output-format json --no-session-persistence --dangerously-skip-permissions --model sonnet > /tmp/agent.json 2>&1
" > /dev/null 2>&1
EC=$?
WALL=$(( $(date +%s) - START ))
docker exec "$C" bash -c "pip freeze > /tmp/state_after.txt"
DONE_OK=$(docker exec "$C" bash -c "$CHECK > /dev/null 2>&1 && echo yes || echo no")

# ── measure disk + hook time + actions ───────────────────────────────
case "$COND" in
  plugin)  BYTES=$(docker exec "$C" du -sb /app/.chats-sandbox 2>/dev/null | awk '{print $1}')
           ACTIONS=$(docker exec "$C" bash -c 'ls /app/.chats-sandbox/backups 2>/dev/null | grep -c ^action_') ;;
  git-add|cp-all) BYTES=$(docker exec "$C" du -sb /app/.baseline 2>/dev/null | awk '{print $1}')
           ACTIONS=$(docker exec "$C" bash -c 'ls /app/.baseline/trash 2>/dev/null | wc -l; GIT_DIR=/app/.baseline/shadow git rev-list --count HEAD 2>/dev/null' | sort -rn | head -1) ;;
  none)    BYTES=0; ACTIONS=0 ;;
esac
HOOK_MS=$(docker exec "$C" awk '{s+=$1} END{print s+0}' /app/.hook-times.log 2>/dev/null </dev/null); HOOK_MS=${HOOK_MS:-0}

# ── restore + recovery quality ───────────────────────────────────────
case "$COND" in
  plugin)  docker exec "$C" bash -c "cd /app && node /opt/chats-sandbox/dist/cli.js restore 1" > /tmp/pipbench-restore.log 2>&1 ;;
  git-add) docker exec "$C" bash -c '
             FIRST=$(GIT_DIR=/app/.baseline/shadow git rev-list --max-parents=0 HEAD 2>/dev/null | head -1)
             [ -n "$FIRST" ] && cd /app && GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git read-tree "$FIRST" \
               && GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git checkout-index -f -a' > /tmp/pipbench-restore.log 2>&1 ;;
  cp-all)  docker exec "$C" bash -c '[ -d /app/.baseline/trash/action_001 ] && cp -a /app/.baseline/trash/action_001/. /app/' > /tmp/pipbench-restore.log 2>&1 ;;
  none) : ;;
esac
docker exec "$C" bash -c "pip freeze > /tmp/state_restored.txt"
read CHANGED RESTORE_PCT EXTRAS <<< "$(docker exec "$C" python3 -c "
def load(p):
    d={}
    for l in open(p):
        l=l.strip()
        if '==' in l: k,v=l.split('==',1); d[k.lower()]=v
    return d
b=load('/tmp/state_before.txt'); a=load('/tmp/state_after.txt'); r=load('/tmp/state_restored.txt')
changed=sum(1 for k in set(b)|set(a) if b.get(k)!=a.get(k))
ok=sum(1 for k in b if r.get(k)==b[k])
extras=sum(1 for k in r if k not in b)
print(changed, round(100*ok/max(len(b),1)), extras)")"

echo "$TASK_NAME,$COND,$WALL,$BYTES,$HOOK_MS,$ACTIONS,$CHANGED,$RESTORE_PCT,$EXTRAS,$DONE_OK,ec=$EC"
