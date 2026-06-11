#!/usr/bin/env bash
# Multi-agent per-task benchmark runner.
#
# Extends runner.sh with an AGENT dimension: the same terminal-bench task
# container is driven by claude-code, hermes, openclaw, or openhands,
# under one of four backup conditions:
#   none    — no hooks (control: agent time without any backup)
#   plugin  — CHATS-Sandbox tiered backup (chats-sandbox install <agent>)
#   git-add — baseline: git add -A snapshot into a shadow repo per action
#   cp-all  — baseline: copy the whole workspace per action
#
# Models: claude = sonnet (4.6) main + haiku subagent (plugin default);
# the other three run deepseek/deepseek-v4-flash for main AND subagent.
#
# Usage: runner-multi.sh <task-name> <agent> <condition>
# Output row: task,agent,condition,wall_seconds,backup_bytes,actions,test_pass,notes

set -u

TASK="${1:?task name required}"
AGENT="${2:?agent required: claude|hermes|openclaw|openhands}"
COND="${3:?condition required: none|plugin|git-add|cp-all}"

REPO="${REPO:-/mnt/data/CHATS-Sandbox}"
TBENCH_TASKS="${TBENCH_TASKS:-/mnt/data/ToolShield_Integrate/terminal-bench/original-tasks}"
TIMEOUT="${TIMEOUT:-600}"
CLAUDE_MODEL="${BENCH_MODEL:-sonnet}"
DS_MODEL="deepseek/deepseek-v4-flash"
OPENROUTER_KEY="${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set}"

NODE_VERSION="${NODE_VERSION:-v24.14.1}"
NODE_CACHE="${NODE_CACHE:-/mnt/data/chats-bench-cache}"
NODE_TAR="$NODE_CACHE/node-${NODE_VERSION}-linux-x64.tar.gz"
OPENCLAW_TAR="$NODE_CACHE/openclaw-bundle.tar.gz"
HERMES_TAR="$NODE_CACHE/hermes-src.tar.gz"

STAGE_ROOT="${BENCH_STAGE_ROOT:-/mnt/data/chats-bench-stage}"
mkdir -p "$STAGE_ROOT"
STAGE="$(mktemp -d -p "$STAGE_ROOT")"

fail() { echo "$TASK,$AGENT,$COND,-1,-1,-1,error,$1"; exit 1; }

TASK_DIR="$TBENCH_TASKS/$TASK"
[ -d "$TASK_DIR" ] || fail task_dir_missing

PROJECT="cb-${TASK//[^a-z0-9]/}-${AGENT}-${COND}-$$"
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
mkdir -p /tmp/tbench-logs /tmp/tbench-agent-logs

# ── 1. Bring up the task container ───────────────────────────────────
export T_BENCH_TASK_DOCKER_CLIENT_IMAGE_NAME="$PROJECT-img"
export T_BENCH_TASK_DOCKER_CLIENT_CONTAINER_NAME="$CNAME"
export T_BENCH_TEST_DIR=/tests
export T_BENCH_TASK_LOGS_PATH=/tmp/tbench-logs
export T_BENCH_CONTAINER_LOGS_PATH=/tmp/tbench-logs-inner
export T_BENCH_TASK_AGENT_LOGS_PATH=/tmp/tbench-agent-logs
export T_BENCH_CONTAINER_AGENT_LOGS_PATH=/tmp/tbench-agent-logs-inner

(cd "$TASK_DIR" && docker compose -p "$PROJECT" up -d --build 2>&1) >"$STAGE/compose.log" \
  || { tail -20 "$STAGE/compose.log" >&2; fail compose_up_failed; }

# ── 2. Node (needed by chats hooks on every agent) + git + pytest ────
docker cp "$NODE_TAR" "$CNAME:/opt/node.tar.gz"
docker exec "$CNAME" bash -c "
  set -e
  mkdir -p /opt/node
  tar -xzf /opt/node.tar.gz -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm  /usr/local/bin/npm
  if ! command -v git >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -o Acquire::AllowInsecureRepositories=true 2>/dev/null || true
      apt-get install -y --allow-unauthenticated --no-install-recommends git 2>/dev/null || \
        apt-get install -y --no-install-recommends git 2>/dev/null || true
    fi
  fi
  if command -v pip3 >/dev/null 2>&1; then
    pip3 install --quiet --break-system-packages pytest 2>/dev/null \
      || pip3 install --quiet pytest 2>/dev/null || true
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m ensurepip --quiet 2>/dev/null || true
    python3 -m pip install --quiet --break-system-packages pytest 2>/dev/null || true
  fi
" >"$STAGE/base-setup.log" 2>&1 || { tail -20 "$STAGE/base-setup.log" >&2; fail base_setup_failed; }

# ── 3. Agent-specific install ────────────────────────────────────────
case "$AGENT" in
  claude)
    mkdir -p "$STAGE/creds/.claude"
    cp /root/.claude/.credentials.json "$STAGE/creds/.claude/.credentials.json"
    cp /root/.claude.json              "$STAGE/creds/.claude.json"
    chmod 600 "$STAGE/creds/.claude/.credentials.json"
    docker cp "$STAGE/creds" "$CNAME:/root/creds-staging"
    docker exec "$CNAME" bash -c "
      set -e
      /opt/node/bin/npm install -g @anthropic-ai/claude-code --silent
      ln -sf /opt/node/bin/claude /usr/local/bin/claude
      id bench 2>/dev/null || useradd -m -u 1010 -s /bin/bash bench
      mkdir -p /home/bench/.claude
      cp /root/creds-staging/.claude/.credentials.json /home/bench/.claude/
      cp /root/creds-staging/.claude.json             /home/bench/
      chown -R bench:bench /home/bench
      chmod 600 /home/bench/.claude/.credentials.json
      chown -R bench:bench /app 2>/dev/null || true
    " >"$STAGE/agent-setup.log" 2>&1 || { tail -20 "$STAGE/agent-setup.log" >&2; fail claude_install_failed; }
    ;;
  hermes)
    docker cp "$HERMES_TAR" "$CNAME:/opt/hermes-src.tar.gz"
    docker exec "$CNAME" bash -c "
      set -e
      mkdir -p /opt && tar -xzf /opt/hermes-src.tar.gz -C /opt
      PIPFLAGS='--quiet --disable-pip-version-check'
      python3 -m pip install \$PIPFLAGS --break-system-packages /opt/hermes-agent 2>/dev/null \
        || python3 -m pip install \$PIPFLAGS /opt/hermes-agent
      cat > /usr/local/bin/hermes <<'EOS'
#!/usr/bin/env bash
exec env PYTHONPATH=/opt/hermes-agent python3 -m hermes_cli.main \"\$@\"
EOS
      chmod +x /usr/local/bin/hermes
      hermes --version >/dev/null
    " >"$STAGE/agent-setup.log" 2>&1 || { tail -25 "$STAGE/agent-setup.log" >&2; fail hermes_install_failed; }
    ;;
  openclaw)
    docker cp "$OPENCLAW_TAR" "$CNAME:/opt/openclaw.tar.gz"
    docker exec "$CNAME" bash -c "
      set -e
      mkdir -p /opt/openclaw && tar -xzf /opt/openclaw.tar.gz -C /opt/openclaw
      cat > /usr/local/bin/openclaw <<'EOS'
#!/usr/bin/env bash
exec /usr/local/bin/node /opt/openclaw/openclaw.mjs \"\$@\"
EOS
      chmod +x /usr/local/bin/openclaw
      # Point the embedded agent's workspace at the task dir.
      mkdir -p /root/.openclaw
      ln -sfn /app /root/.openclaw/workspace
      openclaw --version >/dev/null
    " >"$STAGE/agent-setup.log" 2>&1 || { tail -20 "$STAGE/agent-setup.log" >&2; fail openclaw_install_failed; }
    ;;
  openhands)
    docker exec "$CNAME" bash -c "
      set -e
      PIPFLAGS='--quiet --disable-pip-version-check'
      # old-resolver pip picks a mismatched sdk (1.17) for tools 1.28 —
      # upgrade pip first, then pin the matched pair.
      python3 -m pip install \$PIPFLAGS --upgrade pip --break-system-packages 2>/dev/null \
        || python3 -m pip install \$PIPFLAGS --upgrade pip || true
      python3 -m pip install \$PIPFLAGS --break-system-packages 'openhands-sdk==1.28.0' 'openhands-tools==1.28.0' 2>/dev/null \
        || python3 -m pip install \$PIPFLAGS 'openhands-sdk==1.28.0' 'openhands-tools==1.28.0'
      cat > /opt/oh-driver.py <<'EOS'
import os, sys
from pydantic import SecretStr
from openhands.sdk import LLM, Conversation, Agent
from openhands.sdk.hooks import HookConfig
from openhands.tools.terminal import TerminalTool
from openhands.sdk.tool import Tool, register_tool

os.chdir(\"/app\")
instruction = open(\"/tmp/instr.txt\").read()
llm = LLM(usage_id=\"agent\", model=\"openrouter/deepseek/deepseek-v4-flash\",
          api_key=SecretStr(os.environ[\"OPENROUTER_API_KEY\"]))
register_tool(\"TerminalTool\", TerminalTool)
agent = Agent(llm=llm, tools=[Tool(name=\"TerminalTool\")])
conv = Conversation(agent=agent, workspace=\"/app\",
                    hook_config=HookConfig.load(working_dir=\"/app\"))
conv.send_message(instruction)
conv.run()
print(\"STATUS:\", conv.state.execution_status)
EOS
    " >"$STAGE/agent-setup.log" 2>&1 || { tail -25 "$STAGE/agent-setup.log" >&2; fail openhands_install_failed; }
    ;;
  *) fail unknown_agent ;;
esac

# ── 4. Condition wiring ──────────────────────────────────────────────
install_baseline_hook() {  # $1 = hook body variant (git-add | cp-all)
  docker exec "$CNAME" bash -c "
    mkdir -p /app/.baseline
    if [ '$1' = git-add ]; then
      mkdir -p /app/.baseline/shadow
      cat > /app/.baseline/hook.sh <<'EOF'
#!/usr/bin/env bash
cd /app
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git init -q 2>/dev/null || true
mkdir -p /app/.baseline/shadow/info
printf '.baseline\n.claude\n.hermes\n.openclaw\n.openhands\n' > /app/.baseline/shadow/info/exclude
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git config user.email b@x 2>/dev/null
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git config user.name b 2>/dev/null
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git add -A 2>/dev/null
GIT_DIR=/app/.baseline/shadow GIT_WORK_TREE=/app git commit -qm snap --allow-empty-message --allow-empty 2>/dev/null
exit 0
EOF
    else
      mkdir -p /app/.baseline/trash
      cat > /app/.baseline/hook.sh <<'EOF'
#!/usr/bin/env bash
N=\$(ls /app/.baseline/trash 2>/dev/null | wc -l)
SEQ=\$(printf '%03d' \$((N+1)))
mkdir -p /app/.baseline/trash/action_\$SEQ
find /app -mindepth 1 -maxdepth 1 ! -name .baseline ! -name .claude ! -name .hermes ! -name .openclaw ! -name .openhands -print0 2>/dev/null \\
  | xargs -0 -I{} cp -a {} /app/.baseline/trash/action_\$SEQ/ 2>/dev/null
exit 0
EOF
    fi
    chmod +x /app/.baseline/hook.sh
  "
}

wire_baseline() {  # hook.sh exists; wire it into this agent's hook system
  case "$AGENT" in
    claude)
      docker exec "$CNAME" bash -c "
        mkdir -p /app/.claude
        cat > /app/.claude/settings.json <<EOF
{\"hooks\": {\"PreToolUse\": [{\"matcher\": \"*\", \"hooks\": [{\"type\": \"command\", \"command\": \"/app/.baseline/hook.sh\"}]}]}}
EOF
        chown -R bench:bench /app/.claude /app/.baseline
      " ;;
    hermes)
      docker exec "$CNAME" bash -c "
        mkdir -p /app/.hermes/plugins
        cat > /app/.hermes/plugins/baseline.py <<'EOF'
import subprocess
def _pre(tool_name, args):
    try: subprocess.run(['/app/.baseline/hook.sh'], timeout=600, capture_output=True)
    except Exception: pass
def attach(registry):
    registry.add_pre_hook(_pre)
EOF
      " ;;
    openhands)
      docker exec "$CNAME" bash -c "
        mkdir -p /app/.openhands
        cat > /app/.openhands/hooks.json <<EOF
{\"hooks\": {\"PreToolUse\": [{\"matcher\": \"*\", \"hooks\": [{\"command\": \"/app/.baseline/hook.sh\", \"timeout\": 600}]}]}}
EOF
      " ;;
    openclaw)
      docker exec "$CNAME" bash -c '
        set -e
        D=/app/.openclaw/extensions/baseline
        mkdir -p "$D"
        cat > "$D/openclaw.plugin.json" <<EOF
{"id":"baseline","name":"Baseline","version":"0.1.0","description":"baseline backup hook",
 "activation":{"onStartup":true},"enabledByDefault":true,
 "configSchema":{"type":"object","additionalProperties":false,"properties":{}}}
EOF
        cat > "$D/package.json" <<EOF
{"name":"baseline-hook","version":"0.1.0","private":true,"type":"module",
 "openclaw":{"extensions":["./index.mjs"]}}
EOF
        cat > "$D/index.mjs" <<EOF
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { spawn } from "node:child_process";
function runHook() {
  return new Promise((res) => {
    try {
      const c = spawn("/app/.baseline/hook.sh", [], { stdio: "ignore" });
      const t = setTimeout(() => { try { c.kill(); } catch {} res(); }, 600000);
      c.on("close", () => { clearTimeout(t); res(); });
      c.on("error", () => { clearTimeout(t); res(); });
    } catch { res(); }
  });
}
export default definePluginEntry({
  id: "baseline", name: "Baseline",
  register(api) { api.on("before_tool_call", async () => { try { await runHook(); } catch {} }); },
});
EOF
        openclaw plugins install --link --dangerously-force-unsafe-install "$D" >/dev/null 2>&1
      ' ;;
  esac
}

case "$COND" in
  none) : ;;
  plugin)
    docker cp "$REPO/dist"     "$CNAME:/opt/cs-dist"
    docker cp "$REPO/commands" "$CNAME:/opt/cs-commands"
    docker exec "$CNAME" bash -c "
      set -e
      mkdir -p /opt/chats-sandbox
      mv /opt/cs-dist     /opt/chats-sandbox/dist
      mv /opt/cs-commands /opt/chats-sandbox/commands
    " >>"$STAGE/plugin.log" 2>&1 || fail plugin_copy_failed
    INSTALL_NAME="$AGENT"; [ "$AGENT" = claude ] && INSTALL_NAME="claude-code"
    if [ "$AGENT" = claude ]; then
      docker exec "$CNAME" bash -c "chown -R bench:bench /opt/chats-sandbox"
      docker exec --user bench "$CNAME" bash -c "
        cd /app && node /opt/chats-sandbox/dist/cli.js install claude-code
      " >>"$STAGE/plugin.log" 2>&1 || { tail -20 "$STAGE/plugin.log" >&2; fail plugin_install_failed; }
    else
      docker exec "$CNAME" bash -c "
        cd /app && node /opt/chats-sandbox/dist/cli.js install $INSTALL_NAME
      " >>"$STAGE/plugin.log" 2>&1 || { tail -20 "$STAGE/plugin.log" >&2; fail plugin_install_failed; }
    fi
    # Subagent models: deepseek for the non-claude agents (claude keeps haiku default)
    case "$AGENT" in
      hermes)   docker exec "$CNAME" bash -c "cd /app && node /opt/chats-sandbox/dist/cli.js config set subagentHermesModel $DS_MODEL" >>"$STAGE/plugin.log" 2>&1 ;;
      openclaw) docker exec "$CNAME" bash -c "cd /app && node /opt/chats-sandbox/dist/cli.js config set subagentOpenclawModel openrouter/$DS_MODEL" >>"$STAGE/plugin.log" 2>&1 ;;
    esac
    ;;
  git-add|cp-all)
    install_baseline_hook "$COND" || fail baseline_hook_failed
    wire_baseline || fail baseline_wire_failed
    ;;
  *) fail unknown_condition ;;
esac

# ── 5. Instruction ───────────────────────────────────────────────────
INSTRUCTION_RAW="$(python3 -c "
import yaml
with open('$TASK_DIR/task.yaml') as f:
    d = yaml.safe_load(f)
print(d.get('instruction','').strip())
")"
INSTRUCTION="$INSTRUCTION_RAW

After completing the task, verify your work by:
- Listing the contents of /app with \`ls -la /app\` via your shell tool.
- Reading back any file(s) you created or modified.
- Printing the first few lines of each with \`head -20 <path>\`.
- Reporting a one-sentence confirmation of what you produced."

printf '%s' "$INSTRUCTION" > "$STAGE/instr.txt"
docker cp "$STAGE/instr.txt" "$CNAME:/tmp/instr.txt"

# ── 6. Run the agent ─────────────────────────────────────────────────
START=$(date +%s)
case "$AGENT" in
  claude)
    docker exec "$CNAME" su bench -c "
      cd /app
      export HOME=/home/bench
      timeout $TIMEOUT claude -p \"\$(cat /tmp/instr.txt)\" \
        --output-format json \
        --no-session-persistence \
        --permission-mode bypassPermissions \
        --model $CLAUDE_MODEL \
        > /tmp/agent-out.log 2>&1
    " >/dev/null 2>&1
    AGENT_EC=$?
    ;;
  hermes)
    docker exec -e OPENROUTER_API_KEY="$OPENROUTER_KEY" "$CNAME" bash -c "
      cd /app
      timeout $TIMEOUT hermes chat -q \"\$(cat /tmp/instr.txt)\" \
        -m $DS_MODEL --provider openrouter -Q --yolo \
        > /tmp/agent-out.log 2>&1
    " >/dev/null 2>&1
    AGENT_EC=$?
    ;;
  openclaw)
    docker exec -e OPENROUTER_API_KEY="$OPENROUTER_KEY" "$CNAME" bash -c "
      cd /app
      timeout $TIMEOUT openclaw agent --local --agent main --session-id bench-run \
        -m \"\$(cat /tmp/instr.txt)\" --model openrouter/$DS_MODEL \
        > /tmp/agent-out.log 2>&1
    " >/dev/null 2>&1
    AGENT_EC=$?
    ;;
  openhands)
    docker exec -e OPENROUTER_API_KEY="$OPENROUTER_KEY" "$CNAME" bash -c "
      cd /app
      timeout $TIMEOUT python3 /opt/oh-driver.py > /tmp/agent-out.log 2>&1
    " >/dev/null 2>&1
    AGENT_EC=$?
    ;;
esac
END=$(date +%s)
WALL=$((END - START))

# ── 7. Measure backup disk + action count ────────────────────────────
case "$COND" in
  plugin)
    BYTES=$(docker exec "$CNAME" du -sb /app/.chats-sandbox 2>/dev/null | awk '{print $1}')
    ACTIONS=$(docker exec "$CNAME" bash -c 'ls /app/.chats-sandbox/backups 2>/dev/null | grep -c ^action_' | tr -d '\n\r ')
    # Net-new disk: rm-to-trash MOVES bytes out of the workspace (total
    # disk unchanged), so subtract those from the backup-dir size. Copy
    # -based trash (sed/truncate/mv-clobber) still counts in full.
    MOVED=$(docker exec "$CNAME" python3 -c "
import json, os, glob
tot = 0
for m in glob.glob('/app/.chats-sandbox/backups/action_*/metadata.json'):
    try:
        arts = json.load(open(m))
    except Exception:
        continue
    if any(a.get('policyRuleId') == 'rm-to-trash' for a in arts):
        td = os.path.join(os.path.dirname(m), 'trash')
        for r, _, fs in os.walk(td):
            for f in fs:
                try: tot += os.path.getsize(os.path.join(r, f))
                except OSError: pass
print(tot)
" 2>/dev/null | tr -d '\n\r ')
    MOVED="${MOVED:-0}"
    NETB=$((BYTES - MOVED))
    ;;
  git-add)
    BYTES=$(docker exec "$CNAME" du -sb /app/.baseline 2>/dev/null | awk '{print $1}')
    ACTIONS=$(docker exec "$CNAME" bash -c 'GIT_DIR=/app/.baseline/shadow git rev-list --count HEAD 2>/dev/null || echo 0' | tr -d '\n\r ')
    ;;
  cp-all)
    BYTES=$(docker exec "$CNAME" du -sb /app/.baseline 2>/dev/null | awk '{print $1}')
    ACTIONS=$(docker exec "$CNAME" bash -c 'ls /app/.baseline/trash 2>/dev/null | wc -l' | tr -d '\n\r ')
    ;;
  none) BYTES=0; ACTIONS=0 ;;
esac
BYTES="${BYTES:-0}"; ACTIONS="${ACTIONS:-0}"

# ── 8. Task tests ────────────────────────────────────────────────────
TEST_PASS="unknown"
if [ -d "$TASK_DIR/tests" ]; then
  docker cp "$TASK_DIR/tests" "$CNAME:/tests"
  docker exec "$CNAME" bash -c '
    cd /
    if compgen -G "/tests/test_*.py" >/dev/null; then
      python3 -m pytest /tests/test_*.py -rA >/tmp/test.log 2>&1
    else
      python3 -m pytest /tests/ -rA >/tmp/test.log 2>&1
    fi
  '
  [ $? -eq 0 ] && TEST_PASS="pass" || TEST_PASS="fail"
fi

NETB="${NETB:-$BYTES}"
echo "$TASK,$AGENT,$COND,$WALL,$BYTES,$ACTIONS,$TEST_PASS,ec=$AGENT_EC;net=$NETB"
