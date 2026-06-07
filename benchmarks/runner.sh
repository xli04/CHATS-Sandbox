#!/usr/bin/env bash
# Per-task benchmark runner.
#
# Flow:
#   1. `docker compose up -d` using the task's own compose file (re-uses
#      terminal-bench's native container setup — no overlay-rebuild, no
#      GPG sidesteps).
#   2. `docker exec` to install node + claude inside the client container
#      via the nodejs.org tarball (works on any Linux base regardless of
#      apt state).
#   3. Install the condition's hooks / plugin into /app.
#   4. `docker exec` run claude -p with the task's instruction.
#   5. Measure wall-clock + backup disk usage.
#   6. Run the task's tests.
#   7. `docker compose down -v --rmi local` to remove container + image.
#
# Usage: runner.sh <task-name> <condition>
#   condition: none | plugin | git-add | cp-all

set -u

TASK="${1:?task name required}"
COND="${2:?condition required}"

REPO="${REPO:-/mnt/data/CHATS-Sandbox}"
TBENCH_TASKS="${TBENCH_TASKS:-/mnt/data/ToolShield_Integrate/terminal-bench/original-tasks}"
TIMEOUT="${TIMEOUT:-600}"
MODEL="${BENCH_MODEL:-sonnet}"

# Node binary tarball, pre-cached on disk to avoid repeated downloads.
NODE_VERSION="${NODE_VERSION:-v24.14.1}"
NODE_CACHE="${NODE_CACHE:-/mnt/data/chats-bench-cache}"
mkdir -p "$NODE_CACHE"
NODE_TAR="$NODE_CACHE/node-${NODE_VERSION}-linux-x64.tar.gz"
if [ ! -f "$NODE_TAR" ]; then
  curl -sL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.gz" -o "$NODE_TAR"
fi

# Staging dir for creds (docker bind mounts on this VM require /mnt/data).
STAGE_ROOT="${BENCH_STAGE_ROOT:-/mnt/data/chats-bench-stage}"
mkdir -p "$STAGE_ROOT"
STAGE="$(mktemp -d -p "$STAGE_ROOT")"
mkdir -p "$STAGE/creds/.claude"
cp /root/.claude/.credentials.json "$STAGE/creds/.claude/.credentials.json"
cp /root/.claude.json              "$STAGE/creds/.claude.json"
chmod 600 "$STAGE/creds/.claude/.credentials.json"

TASK_DIR="$TBENCH_TASKS/$TASK"
if [ ! -d "$TASK_DIR" ]; then
  echo "$TASK,$COND,-1,-1,-1,error,task_dir_missing" && exit 1
fi

# Unique project name so `docker compose` doesn't collide across parallel runs.
PROJECT="chats-bench-${TASK//[^a-z0-9]/}-${COND}-$$"
CNAME="${PROJECT}-client"

cleanup() {
  (cd "$TASK_DIR" && \
    T_BENCH_TASK_DOCKER_CLIENT_IMAGE_NAME="$PROJECT-img" \
    T_BENCH_TASK_DOCKER_CLIENT_CONTAINER_NAME="$CNAME" \
    T_BENCH_TEST_DIR=/tests \
    T_BENCH_TASK_LOGS_PATH=/tmp/tbench-logs \
    T_BENCH_CONTAINER_LOGS_PATH=/tmp/tbench-logs-inner \
    T_BENCH_TASK_AGENT_LOGS_PATH=/tmp/tbench-agent-logs \
    T_BENCH_CONTAINER_AGENT_LOGS_PATH=/tmp/tbench-agent-logs-inner \
    docker compose -p "$PROJECT" down -v --rmi local --timeout 5 2>/dev/null
  )
  rm -rf "$STAGE"
}
trap cleanup EXIT

# Ensure host-side log dirs exist (compose mounts them in).
mkdir -p /tmp/tbench-logs /tmp/tbench-agent-logs

# ── 1. Bring up the task container ───────────────────────────────────
export T_BENCH_TASK_DOCKER_CLIENT_IMAGE_NAME="$PROJECT-img"
export T_BENCH_TASK_DOCKER_CLIENT_CONTAINER_NAME="$CNAME"
export T_BENCH_TEST_DIR=/tests
export T_BENCH_TASK_LOGS_PATH=/tmp/tbench-logs
export T_BENCH_CONTAINER_LOGS_PATH=/tmp/tbench-logs-inner
export T_BENCH_TASK_AGENT_LOGS_PATH=/tmp/tbench-agent-logs
export T_BENCH_CONTAINER_AGENT_LOGS_PATH=/tmp/tbench-agent-logs-inner

BUILD_LOG="$STAGE/compose-build.log"
(cd "$TASK_DIR" && docker compose -p "$PROJECT" up -d --build 2>&1) >"$BUILD_LOG"
if [ $? -ne 0 ]; then
  tail -20 "$BUILD_LOG" >&2
  echo "$TASK,$COND,-1,-1,-1,error,compose_up_failed" && exit 1
fi

# ── 2. Inject node + claude CLI into the client container ───────────
# Copy the node tarball + creds, then extract and npm-install claude inside.
docker cp "$NODE_TAR" "$CNAME:/opt/node.tar.gz"
docker cp "$STAGE/creds" "$CNAME:/root/creds-staging"

docker exec "$CNAME" bash -c "
  set -e
  # Extract node under /opt
  mkdir -p /opt/node
  tar -xzf /opt/node.tar.gz -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm  /usr/local/bin/npm
  ln -sf /opt/node/bin/npx  /usr/local/bin/npx
  # Install claude globally
  /opt/node/bin/npm install -g @anthropic-ai/claude-code --silent
  ln -sf /opt/node/bin/claude /usr/local/bin/claude

  # Install git — the plugin's tier-2 git_snapshot needs it for shadow-repo
  # commits. Use --allow-unauthenticated because several t-bench bases have
  # expired debian GPG signatures.
  if ! command -v git >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -o Acquire::AllowInsecureRepositories=true 2>/dev/null || true
      apt-get install -y --allow-unauthenticated --no-install-recommends git 2>/dev/null || \
        apt-get install -y --no-install-recommends git 2>/dev/null || true
    fi
  fi

  # Install pytest via pip (avoid the task's run-tests.sh which uses apt + uv
  # — broken on several t-bench bases with expired debian GPG signatures).
  if command -v pip3 >/dev/null 2>&1; then
    pip3 install --quiet --break-system-packages pytest 2>/dev/null \
      || pip3 install --quiet pytest 2>/dev/null \
      || true
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m ensurepip --quiet 2>/dev/null || true
    python3 -m pip install --quiet --break-system-packages pytest 2>/dev/null || true
  fi

  # Create bench user (claude needs non-root for bypassPermissions)
  id bench 2>/dev/null || useradd -m -u 1010 -s /bin/bash bench

  # Move staged creds into bench's home
  mkdir -p /home/bench/.claude
  cp /root/creds-staging/.claude/.credentials.json /home/bench/.claude/
  cp /root/creds-staging/.claude.json             /home/bench/
  chown -R bench:bench /home/bench
  chmod 600 /home/bench/.claude/.credentials.json

  # Make /app writable by bench
  chown -R bench:bench /app 2>/dev/null || true
" >"$STAGE/setup.log" 2>&1
if [ $? -ne 0 ]; then
  tail -30 "$STAGE/setup.log" >&2
  echo "$TASK,$COND,-1,-1,-1,error,claude_install_failed" && exit 1
fi

# ── 3. Condition-specific setup ────────────────────────────────────
case "$COND" in
  none)
    : # no hooks
    ;;
  plugin)
    # Mount chats-sandbox dist into the container; bench runs `install`.
    docker cp "$REPO/dist"      "$CNAME:/opt/chats-sandbox-dist"
    docker cp "$REPO/commands"  "$CNAME:/opt/chats-sandbox-commands"
    docker exec "$CNAME" bash -c "
      set -e
      chown -R bench:bench /opt/chats-sandbox-dist /opt/chats-sandbox-commands
      mkdir -p /opt/chats-sandbox
      mv /opt/chats-sandbox-dist     /opt/chats-sandbox/dist
      mv /opt/chats-sandbox-commands /opt/chats-sandbox/commands
      chown -R bench:bench /opt/chats-sandbox
    " >"$STAGE/plugin-setup.log" 2>&1 || { tail -20 "$STAGE/plugin-setup.log" >&2; echo "$TASK,$COND,-1,-1,-1,error,plugin_copy_failed"; exit 1; }
    docker exec --user bench "$CNAME" bash -c "
      cd /app
      node /opt/chats-sandbox/dist/cli.js install
    " >"$STAGE/plugin-install.log" 2>&1 || { tail -30 "$STAGE/plugin-install.log" >&2; echo "$TASK,$COND,-1,-1,-1,error,plugin_install_failed"; exit 1; }
    ;;
  git-add)
    docker exec "$CNAME" bash -c "
      mkdir -p /app/.claude /app/.baseline/shadow
      cat > /app/.baseline/hook.sh <<'EOF'
#!/usr/bin/env bash
cd /app
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git init -q 2>/dev/null || true
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git config user.email b@x 2>/dev/null
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git config user.name b 2>/dev/null
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git add -A 2>/dev/null
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git commit -qm snap --allow-empty-message --allow-empty 2>/dev/null
exit 0
EOF
      chmod +x /app/.baseline/hook.sh
      cat > /app/.claude/settings.json <<EOF
{\"hooks\": {\"PreToolUse\": [{\"matcher\": \"*\", \"hooks\": [{\"type\": \"command\", \"command\": \"/app/.baseline/hook.sh\"}]}]}}
EOF
      chown -R bench:bench /app/.claude /app/.baseline
    "
    ;;
  cp-all)
    docker exec "$CNAME" bash -c "
      mkdir -p /app/.claude /app/.baseline/trash
      cat > /app/.baseline/hook.sh <<'EOF'
#!/usr/bin/env bash
N=\$(ls /app/.baseline/trash 2>/dev/null | wc -l)
SEQ=\$(printf '%03d' \$((N+1)))
mkdir -p /app/.baseline/trash/action_\$SEQ
find /app -mindepth 1 -maxdepth 1 ! -name .baseline ! -name .claude -print0 2>/dev/null \\
  | xargs -0 -I{} cp -a {} /app/.baseline/trash/action_\$SEQ/ 2>/dev/null
exit 0
EOF
      chmod +x /app/.baseline/hook.sh
      cat > /app/.claude/settings.json <<EOF
{\"hooks\": {\"PreToolUse\": [{\"matcher\": \"*\", \"hooks\": [{\"type\": \"command\", \"command\": \"/app/.baseline/hook.sh\"}]}]}}
EOF
      chown -R bench:bench /app/.claude /app/.baseline
    "
    ;;
  *)
    echo "$TASK,$COND,-1,-1,-1,error,unknown_condition" && exit 1
    ;;
esac

# ── 4. Read task instruction ───────────────────────────────────────
# Append a verification tail so the agent performs more tool calls
# (reads back its own output, sanity-checks file listings, etc). Nudges
# action count toward 6+ without changing what the task's tests check.
INSTRUCTION_RAW="$(python3 -c "
import yaml, sys
with open('$TASK_DIR/task.yaml') as f:
    d = yaml.safe_load(f)
print(d.get('instruction','').strip())
")"
INSTRUCTION="$INSTRUCTION_RAW

After completing the task, verify your work by:
- Listing the contents of /app with \`ls -la /app\` via Bash.
- Reading any file(s) you created or modified using the Read tool.
- Printing the first few lines of each with \`head -20 <path>\` via Bash.
- Reporting a one-sentence confirmation of what you produced."

# ── 5. Run claude -p as bench ──────────────────────────────────────
START=$(date +%s)
docker exec "$CNAME" su bench -c "
  cd /app
  export HOME=/home/bench
  timeout $TIMEOUT claude -p \"\$(cat <<'PROMPT'
$INSTRUCTION
PROMPT
)\" \
    --output-format json \
    --no-session-persistence \
    --permission-mode bypassPermissions \
    --model $MODEL \
    > /tmp/claude.json 2>&1
" >/dev/null 2>&1
CLAUDE_EC=$?
END=$(date +%s)
WALL=$((END - START))

# ── 6. Measure backup disk + action count ──────────────────────────
case "$COND" in
  plugin)
    # Fair comparison: include the shadow git repo (where tier-2 stores the
    # actual backup data) alongside the action-folder metadata. Otherwise
    # we only count a few KB of metadata.json/instruction.txt and miss the
    # real storage. Excludes only the dashboard artifacts (there are none
    # in headless mode anyway).
    BYTES=$(docker exec "$CNAME" du -sb /app/.chats-sandbox 2>/dev/null | awk '{print $1}')
    ACTIONS=$(docker exec "$CNAME" bash -c 'ls /app/.chats-sandbox/backups 2>/dev/null | grep -c ^action_' | tr -d '\n\r ')
    ;;
  git-add)
    BYTES=$(docker exec "$CNAME" du -sb /app/.baseline 2>/dev/null | awk '{print $1}')
    ACTIONS=$(docker exec "$CNAME" bash -c 'GIT_DIR=/app/.baseline/shadow git rev-list --count HEAD 2>/dev/null || echo 0' | tr -d '\n\r ')
    ;;
  cp-all)
    BYTES=$(docker exec "$CNAME" du -sb /app/.baseline 2>/dev/null | awk '{print $1}')
    ACTIONS=$(docker exec "$CNAME" bash -c 'ls /app/.baseline/trash 2>/dev/null | wc -l' | tr -d '\n\r ')
    ;;
  none)
    BYTES=0; ACTIONS=0
    ;;
esac
BYTES="${BYTES:-0}"; ACTIONS="${ACTIONS:-0}"

# ── 7. Run task tests ──────────────────────────────────────────────
# Bypass the task's run-tests.sh (it uses apt + uv, which fails on bases
# with expired debian GPG). Copy /tests into the container and invoke
# pytest directly — we pre-installed pytest during setup.
TEST_PASS="unknown"
if [ -d "$TASK_DIR/tests" ]; then
  docker cp "$TASK_DIR/tests" "$CNAME:/tests"
  docker exec "$CNAME" bash -c '
    cd /
    # Find test files (test_*.py is the convention).
    if compgen -G "/tests/test_*.py" >/dev/null; then
      python3 -m pytest /tests/test_*.py -rA >/tmp/test.log 2>&1
    else
      # Fallback: no test_*.py files — run every .py under tests/.
      python3 -m pytest /tests/ -rA >/tmp/test.log 2>&1
    fi
  '
  [ $? -eq 0 ] && TEST_PASS="pass" || TEST_PASS="fail"
fi

echo "$TASK,$COND,$WALL,$BYTES,$ACTIONS,$TEST_PASS,ec=$CLAUDE_EC"
