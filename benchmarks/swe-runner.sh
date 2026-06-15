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
# Row: instance,agent,cond,wall,backup_bytes,actions,backup_ms,tiers,cov_handled,cov_total,cov_pct,test_pass,notes
#
# cov_* = coverage: handled/total mutating actions (from a method-
# independent observer that classifies each tool call in/out of the
# workspace). git-add handles in-workspace mutations only; the plugin
# handles all classes. This exposes git-add's blind spot — its low cost
# partly reflects that it silently captures nothing outside the worktree.
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
def _pre(tool_name, args):
    try:
        subprocess.run(["/testbed/.baseline/timed-hook.sh"], capture_output=True, timeout=600)
    except Exception:
        pass
def attach(registry):
    registry.add_pre_hook(_pre)
EOF'
    fi
    ;;
  *) ROW_FAIL unknown_condition ;;
esac

# ── coverage observer (method-independent) ────────────────────────────
# A passive hermes plugin that classifies every tool call into
# read / inws (in-workspace mutation) / outside (outside-workspace
# mutation) and logs it to /testbed/.observer.jsonl. Runs under EVERY
# condition so coverage is measured identically: git-add can only
# handle 'inws' actions, the plugin handles all mutation classes.
if [ "$AGENT" = hermes ]; then
  docker exec "$C" bash -c 'mkdir -p /testbed/.hermes/plugins && cat > /testbed/.hermes/plugins/observer.py <<"OBS"
import json, re, os
WS = "/testbed"; LOG = "/testbed/.observer.jsonl"
OUT_PATTERNS = [r"\bpip3?\s+(install|uninstall)", r"\bnpm\s+(install|uninstall|ci)",
  r"\bapt(-get)?\s+(install|remove|purge)", r"\bbrew\s+(install|uninstall)",
  r"\bgit\s+(push|fetch|pull|clone|remote)", r"\bcurl\b.*-X\s*(POST|PUT|DELETE|PATCH)",
  r"\bwget\b", r"\bssh\b", r"\bscp\b", r"\bdocker\s+(run|push|stop|rm|build)",
  r"\bkubectl\b", r"\bsystemctl\b", r"\b(export|unset)\s+\w+", r"\bsource\s+"]
def classify(tool, args):
    t = (tool or "").lower()
    if t in ("read_file", "search_files", "read", "glob", "grep"): return "read"
    if t.startswith("mcp__"):
        return "read" if re.search(r"(get|list|read|search|describe|navigate|snapshot)", t) else "outside"
    if t in ("write_file", "patch", "edit", "write", "str_replace", "file_editor"): return "inws"
    cmd = ""
    if isinstance(args, dict):
        cmd = str(args.get("command") or args.get("cmd") or args.get("input") or "")
    c = cmd.strip()
    if re.match(r"^(ls|cat|grep|rg|find|head|tail|wc|which|echo|pwd|stat|file|tree|env|printenv|python -m pytest|pytest|git (status|log|diff|show|branch|rev-parse|ls-files|config))\b", c) and ">" not in c:
        return "read"
    for p in OUT_PATTERNS:
        if re.search(p, c, re.I): return "outside"
    for m in re.findall(r"/[\w./-]+", c):
        if len([x for x in m.split("/") if x]) >= 2:
            ab = os.path.realpath(m)
            if not ab.startswith(WS + "/") and ab != WS and not ab.startswith(("/dev/", "/proc/", "/tmp/")):
                if re.search(r"(>|>>|\b(cp|mv|rm|tee|dd|touch|mkdir|ln|install|truncate|chmod|chown)\b)", c):
                    return "outside"
    return "inws"
def _pre(tool_name, args):
    try:
        with open(LOG, "a") as f:
            f.write(json.dumps({"tool": tool_name, "class": classify(tool_name, args)}) + "\n")
    except Exception:
        pass
def attach(registry):
    registry.add_pre_hook(_pre)
OBS'
fi

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

# ── mixed-workload drill (ALL conditions): a known set of actions that
# spans in-workspace (edit), outside-workspace pkg (pip), in-workspace
# delete (rm), and outside-workspace file (/tmp). Run under every
# condition so the coverage metric sees the same outside component and
# the plugin/git-add cost comparison is on an identical workload.
TIERS="n/a"
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
if [ "$COND" = "plugin" ]; then
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

# ── coverage: handled / total mutating actions ────────────────────────
# From the method-independent observer log. read-only calls excluded;
# 'inws' = in-workspace mutation (git-add CAN capture), 'outside' =
# outside-workspace mutation (git-add CANNOT). git-add handles inws
# only; the plugin handles both (T0/T1/T2/T3 all fire — verified by the
# tier column). COVERAGE is handled/total for the running method.
read COV_HANDLED COV_TOTAL < <(docker exec "$C" python3 -c "
import json, collections
c = collections.Counter()
try:
    for l in open('/testbed/.observer.jsonl'):
        if l.strip(): c[json.loads(l)['class']] += 1
except Exception: pass
inws, out = c['inws'], c['outside']
total = inws + out
cond = '$COND'
tiers = '$TIERS'
# in-workspace mutations: covered iff the snapshot tier fired (git-add
# always snapshots; plugin's T2). outside mutations: git-add/cp-all can
# NEVER cover them (no out-of-workspace mechanism); plugin covers them
# iff an out-of-workspace tier actually fired (T0 rewrite / T1 manifest
# / T3 subagent). This is MEASURED from the tiers, not assumed.
if cond == 'plugin':
    handled_inws = inws if 'T2' in tiers else 0
    handled_out  = out if any(t in tiers for t in ('T0','T1','T3')) else 0
    handled = handled_inws + handled_out
else:
    handled = inws   # baselines: workspace snapshot only, outside uncoverable
print(handled, total)" 2>/dev/null)
COV_HANDLED=${COV_HANDLED:-0}; COV_TOTAL=${COV_TOTAL:-0}
if [ "${COV_TOTAL:-0}" -gt 0 ]; then
  COV_PCT=$(python3 -c "print(round(100*$COV_HANDLED/$COV_TOTAL))")
else
  COV_PCT=0
fi

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

# ── persist per-run forensics BEFORE teardown ─────────────────────────
# Save the per-action backup ledger, observer classifications, a
# per-action tier+latency breakdown, and the agent/drill transcripts so
# any row (e.g. a high backup_ms) can be dissected later without a
# KEEP=1 re-run.
LOGDIR="${LOGDIR:-/mnt/data/CHATS-Sandbox/benchmarks/results/swe-logs}/${IID}-${COND}"
mkdir -p "$LOGDIR"
if [ "$COND" = "plugin" ]; then
  docker exec "$C" python3 -c "
import json, glob, os
out = []
for m in sorted(glob.glob('/testbed/.chats-sandbox/backups/action_*/metadata.json')):
    seq = os.path.basename(os.path.dirname(m))
    try: arts = json.load(open(m))
    except Exception: arts = []
    strat = [a.get('strategy','') for a in arts]
    desc = [a.get('description','')[:80] for a in arts]
    out.append({'action': seq, 'strategies': strat, 'desc': desc})
# join per-action latency from the ledger
lat = {}
try:
    for l in open('/testbed/.chats-sandbox/backup-timings.jsonl'):
        if l.strip():
            e = json.loads(l); lat[e['action']] = e['addedLatencyMs']
except Exception: pass
for o in out: o['addedLatencyMs'] = lat.get(o['action'])
print(json.dumps(out, indent=2))" > "$LOGDIR/per-action.json" 2>/dev/null
  docker cp "$C:/testbed/.chats-sandbox/backup-timings.jsonl" "$LOGDIR/backup-timings.jsonl" 2>/dev/null || true
  # Subagent reasoning: description + backup/recovery commands per T3 action.
  docker exec "$C" python3 -c "
import json, glob, os
out = []
for f in sorted(glob.glob('/testbed/.chats-sandbox/backups/action_*/subagent_result.json')):
    try: r = json.load(open(f))
    except Exception: continue
    out.append({'action': os.path.basename(os.path.dirname(f)),
                'description': r.get('description',''),
                'backup_commands': r.get('backup_commands',[]),
                'recovery_commands': r.get('recovery_commands',[]),
                'live_restore': r.get('live_restore')})
print(json.dumps(out, indent=2))" > "$LOGDIR/subagent-reasoning.json" 2>/dev/null || true
fi
docker cp "$C:/testbed/.observer.jsonl"      "$LOGDIR/observer.jsonl"   2>/dev/null || true
docker cp "$C:/tmp/agent-out.log"            "$LOGDIR/agent-out.log"    2>/dev/null || true
docker cp "$C:/tmp/drill-out.log"            "$LOGDIR/drill-out.log"    2>/dev/null || true

echo "$IID,$AGENT,$COND,$WALL,$BYTES,$ACTIONS,$BACKUP_MS,$TIERS,$COV_HANDLED,$COV_TOTAL,$COV_PCT,$TEST_PASS,ec=$EC"
