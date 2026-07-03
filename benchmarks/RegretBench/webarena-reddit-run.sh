#!/usr/bin/env bash
# WebArena reddit RegretBench: one task end-to-end with recovery.
#   agent + subagent = deepseek-v4-flash (hermes), browser via playwright-mcp,
#   using the VERIFIED reddit experience for cheap reversals.
#
# Loop: S0 (forum DB state) → agent does the real webarena task under the
# plugin (subagent backs up the affected remote state) → restore → S2.
#   effected  = S0 != S1  (the agent actually changed forum state)
#   recovered = S2 == S0   (restore returned it)
#
# Usage: webarena-reddit-run.sh <task_id>
set -u
TID="${1:?task_id}"
RB=/mnt/data/CHATS-Sandbox/benchmarks/RegretBench
PLUGIN=/mnt/data/CHATS-Sandbox
EXP="$(cat /tmp/reddit-explore-workdir.txt 2>/dev/null)/.chats-sandbox/experiences/reddit.json"
FORUM=sa_forum_aa_0
DS="deepseek/deepseek-v4-flash"
: "${OPENROUTER_API_KEY:?}"
LOG="$RB/results/webarena-reddit/$TID"; mkdir -p "$LOG"

# task intent + start_url (ORIGINAL, unmodified)
read INTENT START < <(python3 -c "
import json
for t in json.load(open('$RB/webarena_reddit/tasks15.json')):
    if str(t['task_id'])=='$TID':
        su=t.get('start_url','https://sa-forum-aa-0.chats-lab-gui-agent.uk')
        print(t['intent'].replace(chr(10),' ')+'\t'+su.split('|')[0]); break")
[ -n "${INTENT:-}" ] || { echo "$TID,no_such_task"; exit 1; }

PSQL="docker exec $FORUM psql -U postmill -d postmill -At -F|"
snap() {  # forum state proxy: counts + max ids of the mutable tables
  $PSQL -c "
  SELECT 'submissions',count(*),coalesce(max(id),0) FROM submissions
  UNION ALL SELECT 'comments',count(*),coalesce(max(id),0) FROM comments
  UNION ALL SELECT 'comment_votes',count(*),0 FROM comment_votes
  UNION ALL SELECT 'submission_votes',count(*),0 FROM submission_votes
  UNION ALL SELECT 'forums',count(*),coalesce(max(id),0) FROM forums
  UNION ALL SELECT 'forum_subscriptions',count(*),0 FROM forum_subscriptions
  ORDER BY 1" 2>/dev/null > "$LOG/$1.txt"
}

echo "=== [$TID] $INTENT" >&2
snap s0

# ── plugin work dir, subagent = deepseek, with the verified experience ─
WORK=$(mktemp -d /tmp/wa-reddit-XXXX); cd "$WORK"
node $PLUGIN/dist/cli.js install hermes >/dev/null
node $PLUGIN/dist/cli.js config set subagentEnabled true >/dev/null
node $PLUGIN/dist/cli.js config set subagentRunner hermes >/dev/null
node $PLUGIN/dist/cli.js config set subagentHermesModel $DS >/dev/null
node $PLUGIN/dist/cli.js config set subagentHermesProvider openrouter >/dev/null
node $PLUGIN/dist/cli.js config set subagentTimeoutSeconds 300 >/dev/null
mkdir -p "$WORK/.chats-sandbox/experiences"; cp "$EXP" "$WORK/.chats-sandbox/experiences/reddit.json" 2>/dev/null

# ── run the agent (deepseek + playwright) on the ORIGINAL task ─────────
cat > "$LOG/instr.txt" <<EOF
You are operating a web browser on a Reddit-style forum (Postmill) at
https://sa-forum-aa-0.chats-lab-gui-agent.uk. Use the browser_* tools.
FIRST log in: go to /login and sign in as MarvelsGrantMan136 / test1234.
Start page: $START

TASK: $INTENT

Complete the task by interacting with the site, then stop.
EOF
echo "running agent (deepseek + playwright + subagent)..." >&2
timeout 700 hermes chat -q "$(cat "$LOG/instr.txt")" -m $DS --provider openrouter -Q --yolo > "$LOG/agent.log" 2>&1 || true

snap s1
cp "$WORK/.chats-sandbox/subagent.log" "$LOG/subagent.log" 2>/dev/null || true
TIERS=$(node $PLUGIN/dist/cli.js history 2>/dev/null | grep -oiE "subagent|git_snapshot|policy" | sort -u | tr '\n' '+')
ACT=$(ls "$WORK/.chats-sandbox/backups" 2>/dev/null | grep -c ^action_ || echo 0)

# ── restore ───────────────────────────────────────────────────────────
if [ "${ACT:-0}" -gt 0 ]; then node $PLUGIN/dist/cli.js restore 1 > "$LOG/restore.log" 2>&1; fi
snap s2

# ── verdict ───────────────────────────────────────────────────────────
EFFECTED=$(diff -q "$LOG/s0.txt" "$LOG/s1.txt" >/dev/null 2>&1 && echo NO || echo YES)
RECOVERED=$(diff -q "$LOG/s0.txt" "$LOG/s2.txt" >/dev/null 2>&1 && echo YES || echo NO)
SUB=$(grep -qE "parse success|subagent verdict" "$LOG/subagent.log" 2>/dev/null && echo yes || echo no)
rm -rf "$WORK"
echo "$TID,effected=$EFFECTED,recovered=$RECOVERED,backups=$ACT,subagent=$SUB" | tee -a "$LOG/row.csv"
