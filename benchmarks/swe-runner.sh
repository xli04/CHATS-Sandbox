#!/usr/bin/env bash
# SWE-bench Verified backup-stress runner.
#
# Phase A (this script, AGENT=hermes COND=plugin): tier-validation —
# run the real SWE issue with hermes/deepseek under the plugin, then a
# scripted "tier drill" exercising T0 (rm/sed), T1 (pip install),
# T2 (edit) and T3 (outside-workspace write), and report which tiers
# produced artifacts + the per-action backup latency from the ledger.
#
# Usage: swe-runner.sh <instance_id> <agent: hermes|claude> <cond: plugin|git-add|cp-all>
# Row: instance,agent,cond,wall,backup_bytes,actions,backup_ms,tiers,test_pass,notes
set -u
IID="${1:?instance id}"; AGENT="${2:?agent}"; COND="${3:?cond}"
REPO=/mnt/data/CHATS-Sandbox
SWE=/mnt/data/swe-stress
NODE_TAR=/mnt/data/chats-bench-cache/node-v24.14.1-linux-x64.tar.gz
HERMES_TAR=/mnt/data/chats-bench-cache/hermes-src.tar.gz
DS_MODEL="deepseek/deepseek-v4-flash"
AGENT_TIMEOUT=${AGENT_TIMEOUT:-900}

IMG="swebench/sweb.eval.x86_64.${IID//__/_1776_}:latest"
ROW_FAIL() { echo "$IID,$AGENT,$COND,-1,-1,-1,-1,none,error,$1"; exit 1; }

INSTANCE_JSON=$(python3 -c "
import json,sys
for l in open('$SWE/subset16.jsonl'):
    r=json.loads(l)
    if r['instance_id']=='$IID': print(json.dumps(r)); break")
[ -n "$INSTANCE_JSON" ] || ROW_FAIL instance_not_found
PROBLEM=$(echo "$INSTANCE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['problem_statement'])")

C="swe-${IID//[^a-z0-9]/}-$$"
docker run -d --name "$C" "$IMG" sleep infinity > /dev/null || ROW_FAIL container_failed
# KEEP=1 leaves the container alive for post-run forensics.
if [ "${KEEP:-0}" != "1" ]; then
  trap 'docker rm -f "$C" > /dev/null 2>&1' EXIT
else
  echo "KEEP=1: container $C left running" >&2
fi

# ── base: node (hooks) everywhere; git identity for shadow repos ──────
docker cp "$NODE_TAR" "$C:/opt/node.tar.gz"
docker exec "$C" bash -c '
  set -e
  mkdir -p /opt/node && tar -xzf /opt/node.tar.gz -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  git config --global user.email bench@x && git config --global user.name bench
  git config --global --add safe.directory /testbed
' > /tmp/swe-setup.log 2>&1 || { tail -5 /tmp/swe-setup.log >&2; ROW_FAIL node_setup_failed; }

# ── agent install ─────────────────────────────────────────────────────
case "$AGENT" in
  hermes)
    : "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set for hermes}"
    docker cp "$HERMES_TAR" "$C:/opt/hermes-src.tar.gz"
    docker exec "$C" bash -c '
      set -e
      tar -xzf /opt/hermes-src.tar.gz -C /opt
      /opt/miniconda3/bin/python -m pip install --quiet --disable-pip-version-check /opt/hermes-agent
      cat > /usr/local/bin/hermes <<"EOS"
#!/usr/bin/env bash
exec env PYTHONPATH=/opt/hermes-agent /opt/miniconda3/bin/python -m hermes_cli.main "$@"
EOS
      chmod +x /usr/local/bin/hermes
      hermes --version > /dev/null
    ' > /tmp/swe-agent.log 2>&1 || { tail -8 /tmp/swe-agent.log >&2; ROW_FAIL hermes_install_failed; }
    ;;
  claude)
    docker exec "$C" mkdir -p /root/.claude
    docker cp /root/.claude/.credentials.json "$C:/root/.claude/.credentials.json"
    docker cp /root/.claude.json "$C:/root/.claude.json"
    docker exec "$C" bash -c '
      /opt/node/bin/npm install -g @anthropic-ai/claude-code --silent
      ln -sf /opt/node/bin/claude /usr/local/bin/claude
      chmod 600 /root/.claude/.credentials.json
    ' > /tmp/swe-agent.log 2>&1 || { tail -5 /tmp/swe-agent.log >&2; ROW_FAIL claude_install_failed; }
    ;;
  *) ROW_FAIL unknown_agent ;;
esac

# ── condition wiring (workspace = /testbed) ───────────────────────────
case "$COND" in
  plugin)
    docker exec "$C" mkdir -p /opt/chats-sandbox
    docker cp $REPO/dist     "$C:/opt/chats-sandbox/dist"
    docker cp $REPO/commands "$C:/opt/chats-sandbox/commands"
    AGENT_KIND=$([ "$AGENT" = claude ] && echo claude-code || echo hermes)
    docker exec "$C" bash -c "
      cd /testbed && node /opt/chats-sandbox/dist/cli.js install $AGENT_KIND > /dev/null
      node /opt/chats-sandbox/dist/cli.js config set subagentEnabled true > /dev/null
      $([ "$AGENT" = hermes ] && echo "node /opt/chats-sandbox/dist/cli.js config set subagentRunner hermes > /dev/null && node /opt/chats-sandbox/dist/cli.js config set subagentHermesModel $DS_MODEL > /dev/null && node /opt/chats-sandbox/dist/cli.js config set subagentHermesProvider openrouter > /dev/null" || echo true)
      node /opt/chats-sandbox/dist/cli.js config set subagentTimeoutSeconds 240 > /dev/null
    " || ROW_FAIL plugin_install_failed
    ;;
  git-add|cp-all)
    docker exec "$C" bash -c '
      mkdir -p /testbed/.baseline
      if [ "'"$COND"'" = git-add ]; then
        mkdir -p /testbed/.baseline/shadow/info
        printf ".baseline\n.claude\n.hermes\n" > /testbed/.baseline/shadow/info/exclude
        cat > /testbed/.baseline/hook.sh <<"EOS"
#!/usr/bin/env bash
cd /testbed
GIT_DIR=/testbed/.baseline/shadow GIT_WORK_TREE=/testbed git init -q 2>/dev/null || true
GIT_DIR=/testbed/.baseline/shadow GIT_WORK_TREE=/testbed git config user.email b@x
GIT_DIR=/testbed/.baseline/shadow GIT_WORK_TREE=/testbed git config user.name b
GIT_DIR=/testbed/.baseline/shadow GIT_WORK_TREE=/testbed git add -A 2>/dev/null
GIT_DIR=/testbed/.baseline/shadow GIT_WORK_TREE=/testbed git commit -qm s --allow-empty 2>/dev/null
exit 0
EOS
      else
        mkdir -p /testbed/.baseline/trash
        cat > /testbed/.baseline/hook.sh <<"EOS"
#!/usr/bin/env bash
N=$(ls /testbed/.baseline/trash 2>/dev/null | wc -l)
SEQ=$(printf "%03d" $((N+1)))
mkdir -p /testbed/.baseline/trash/action_$SEQ
find /testbed -mindepth 1 -maxdepth 1 ! -name .baseline ! -name .claude ! -name .hermes -print0 2>/dev/null \
  | xargs -0 -I{} cp -a {} /testbed/.baseline/trash/action_$SEQ/ 2>/dev/null
exit 0
EOS
      fi
      chmod +x /testbed/.baseline/hook.sh
      S=$(date +%s%3N) # timer wrapper for latency parity with the plugin ledger
      cat > /testbed/.baseline/timed-hook.sh <<"EOS"
#!/usr/bin/env bash
S=$(date +%s%3N); /testbed/.baseline/hook.sh; RC=$?; E=$(date +%s%3N)
echo $((E-S)) >> /testbed/.baseline/hook-times.log
exit $RC
EOS
      chmod +x /testbed/.baseline/timed-hook.sh
    '
    if [ "$AGENT" = claude ]; then
      docker exec "$C" bash -c 'mkdir -p /testbed/.claude && cat > /testbed/.claude/settings.json <<EOF
{"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "/testbed/.baseline/timed-hook.sh"}]}]}}
EOF'
    else
      docker exec "$C" bash -c 'mkdir -p /testbed/.hermes/plugins && cat > /testbed/.hermes/plugins/baseline.py <<"EOF"
import subprocess
def register(api):
    def pre(tool_name, args):
        subprocess.run(["/testbed/.baseline/timed-hook.sh"], capture_output=True, timeout=600)
        return None
    api.add_pre_hook(pre)
EOF'
    fi
    ;;
  *) ROW_FAIL unknown_condition ;;
esac

# ── run the SWE issue ─────────────────────────────────────────────────
# The problem statement is arbitrary text (markdown backticks, $(), …):
# write it via a quoted python heredoc with NO shell processing.
echo "$INSTANCE_JSON" > /tmp/swe-instance.json
python3 - <<'PYWRITE'
import json
r = json.load(open("/tmp/swe-instance.json"))
header = (
    "You are working in the git repository at /testbed (a real Python project).\n"
    "Below is a GitHub issue for this repository. Fix the issue by modifying the\n"
    "source code. The project's Python environment is the conda env 'testbed'\n"
    "(/opt/miniconda3/envs/testbed/bin/python). Run relevant tests if useful.\n"
    "Do not commit; leave changes in the working tree.\n\nISSUE:\n"
)
open("/tmp/swe-instr.txt", "w").write(header + r["problem_statement"])
PYWRITE
docker cp /tmp/swe-instr.txt "$C:/tmp/instr.txt"
START=$(date +%s)
if [ "$AGENT" = hermes ]; then
  docker exec -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" "$C" bash -c "
    cd /testbed && timeout $AGENT_TIMEOUT hermes chat -q \"\$(cat /tmp/instr.txt)\" -m $DS_MODEL --provider openrouter -Q --yolo > /tmp/agent-out.log 2>&1"
else
  docker exec -e IS_SANDBOX=1 -e HOME=/root "$C" bash -c "
    cd /testbed && timeout $AGENT_TIMEOUT claude -p \"\$(cat /tmp/instr.txt)\" --output-format json --no-session-persistence --dangerously-skip-permissions --model sonnet > /tmp/agent-out.log 2>&1"
fi
EC=$?
WALL=$(( $(date +%s) - START ))

# ── tier drill (plugin validation only): exercise T0/T1/T2/T3 ─────────
TIERS="n/a"
if [ "$COND" = "plugin" ]; then
  docker exec -i "$C" bash -c "cat > /tmp/drill.txt" <<'EOF'
Do exactly these four small maintenance steps in /testbed, one at a time, then stop:
1. Append the line "# drill marker" to the end of setup.py (or tox.ini if setup.py does not exist) using a file edit.
2. Run: pip install six
3. Create a scratch file /testbed/scratch_drill.txt containing "x", then delete it by running: rm /testbed/scratch_drill.txt
4. Append the line "drill" to the file /tmp/outside_drill.txt (outside the repository).
EOF
  if [ "$AGENT" = hermes ]; then
    docker exec -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" "$C" bash -c "
      cd /testbed && timeout 600 hermes chat -q \"\$(cat /tmp/drill.txt)\" -m $DS_MODEL --provider openrouter -Q --yolo > /tmp/drill-out.log 2>&1" || true
  else
    docker exec -e IS_SANDBOX=1 -e HOME=/root "$C" bash -c "
      cd /testbed && timeout 600 claude -p \"\$(cat /tmp/drill.txt)\" --output-format json --no-session-persistence --dangerously-skip-permissions --model sonnet > /tmp/drill-out.log 2>&1" || true
  fi
  TIERS=$(docker exec "$C" python3 -c "
import json, glob
strats = set()
for m in glob.glob('/testbed/.chats-sandbox/backups/action_*/metadata.json'):
    try:
        for a in json.load(open(m)): strats.add(a.get('strategy',''))
    except Exception: pass
t = []
if 'policy_rewrite' in strats: t.append('T0')
if strats & {'pip_freeze','npm_list','env_snapshot','git_tag'}: t.append('T1')
if 'git_snapshot' in strats: t.append('T2')
if 'subagent' in strats: t.append('T3')
print('+'.join(t) if t else 'none')")
fi

# ── measure ───────────────────────────────────────────────────────────
case "$COND" in
  plugin)
    BYTES=$(docker exec "$C" bash -c "du -sb /testbed/.chats-sandbox 2>/dev/null | cut -f1")
    LEDGER=$(docker exec "$C" bash -c "stat -c%s /testbed/.chats-sandbox/backup-timings.jsonl 2>/dev/null || echo 0")
    BYTES=$((BYTES - LEDGER))
    ACTIONS=$(docker exec "$C" bash -c "ls /testbed/.chats-sandbox/backups 2>/dev/null | grep -c ^action_" | tr -d '\n\r ')
    ACTIONS=${ACTIONS:-0}
    BACKUP_MS=$(docker exec "$C" python3 -c "
import json
try: print(sum(json.loads(l)['addedLatencyMs'] for l in open('/testbed/.chats-sandbox/backup-timings.jsonl') if l.strip()))
except Exception: print(0)")
    ;;
  git-add|cp-all)
    BYTES=$(docker exec "$C" bash -c "du -sb /testbed/.baseline 2>/dev/null | cut -f1")
    ACTIONS=$(docker exec "$C" bash -c "ls /testbed/.baseline/trash 2>/dev/null | wc -l; GIT_DIR=/testbed/.baseline/shadow git rev-list --count HEAD 2>/dev/null" | sort -rn | head -1)
    BACKUP_MS=$(docker exec "$C" bash -c "awk '{s+=\$1} END{print s+0}' /testbed/.baseline/hook-times.log 2>/dev/null || echo 0")
    ;;
esac

# ── evaluate: apply test_patch, run FAIL_TO_PASS ──────────────────────
echo "$INSTANCE_JSON" | python3 -c "
import json,sys
r = json.load(sys.stdin)
open('/tmp/swe-test.patch','w').write(r['test_patch'])
f2p = r['FAIL_TO_PASS']
if isinstance(f2p, str): f2p = json.loads(f2p)
open('/tmp/swe-f2p.txt','w').write('\n'.join(f2p))"
docker cp /tmp/swe-test.patch "$C:/tmp/test.patch"
docker cp /tmp/swe-f2p.txt "$C:/tmp/f2p.txt"
TEST_PASS=$(docker exec "$C" bash -c '
  source /opt/miniconda3/bin/activate testbed
  cd /testbed
  # reset test files the agent may have touched, then apply the gold test patch
  for f in $(git apply --numstat /tmp/test.patch 2>/dev/null | cut -f3); do git checkout -- "$f" 2>/dev/null; done
  git apply /tmp/test.patch 2>/dev/null || git apply --3way /tmp/test.patch 2>/dev/null || { echo error_patch; exit 0; }
  REPO_KIND=$(ls tests/runtests.py 2>/dev/null && echo django || echo pytest)
  if [ "$REPO_KIND" = django ]; then
    TESTS=$(python3 -c "
import re
names=set()
for l in open(\"/tmp/f2p.txt\"):
    m=re.search(r\"\((.+)\)\", l)
    if m: names.add(\".\".join(m.group(1).split(\".\")[:2]))
print(\" \".join(sorted(names)))")
    cd tests && timeout 600 python runtests.py --verbosity 0 --parallel 1 $TESTS > /tmp/test-out.log 2>&1 \
      && echo pass || echo fail
  else
    timeout 600 python -m pytest -x -q $(cat /tmp/f2p.txt | tr "\n" " ") > /tmp/test-out.log 2>&1 \
      && echo pass || echo fail
  fi' | tail -1)

echo "$IID,$AGENT,$COND,$WALL,$BYTES,$ACTIONS,$BACKUP_MS,$TIERS,$TEST_PASS,ec=$EC"
