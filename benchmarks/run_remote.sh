#!/usr/bin/env bash
# Run 10 remote (Postmill-via-Playwright) tasks, track metrics per task.
#
# Requires: Playwright MCP registered at ~/.claude.json as `playwright`
# (SSE transport, http://localhost:9092/sse).
# Plugin install already done in $PROJ.

set -u
PROJ=/tmp/remote-bench-v2
RESULTS=/mnt/data/CHATS-Sandbox/benchmarks/results/remote.csv
MODEL="${BENCH_MODEL:-sonnet}"

cd "$PROJ" || exit 1

SITE="https://sa-forum-aa-0.chats-lab-gui-agent.uk"
USER="MarvelsGrantMan136"
PASS="test1234"

# 10 tasks. Each is self-contained (no shared state across tasks —
# they key off the user's most recent post / comment, rediscovered each
# time). Each instruction explicitly tells the agent the creds so it
# can log in afresh. First one establishes the post the later ones
# work on.

task_run() {
  local N="$1"; local DESC="$2"; local PROMPT="$3"
  echo "─────── [$N] $DESC ───────" >&2

  # Count actions before and after so we can compute "actions this task added"
  local pre=$(ls "$PROJ/.chats-sandbox/backups" 2>/dev/null | grep -c '^action_')
  local pre_bytes=$(du -sb "$PROJ/.chats-sandbox" 2>/dev/null | awk '{print $1}')

  local START=$(date +%s)
  claude -p "$PROMPT" \
    --output-format json --no-session-persistence \
    --allowedTools "mcp__playwright Bash Edit Write Read Glob Grep" \
    --model "$MODEL" > "/tmp/remote-$N.json" 2>&1 < /dev/null
  local ec=$?
  local END=$(date +%s)
  local WALL=$((END - START))

  # Parse claude output
  local cost turns result
  cost=$(python3 -c "import json; print(json.load(open('/tmp/remote-$N.json')).get('total_cost_usd', 0))" 2>/dev/null || echo 0)
  turns=$(python3 -c "import json; print(json.load(open('/tmp/remote-$N.json')).get('num_turns', 0))" 2>/dev/null || echo 0)
  result=$(python3 -c "import json; r=json.load(open('/tmp/remote-$N.json')).get('result','')[:100]; print(r.replace(chr(10),' '))" 2>/dev/null || echo "")

  # Post-state
  local post=$(ls "$PROJ/.chats-sandbox/backups" 2>/dev/null | grep -c '^action_')
  local post_bytes=$(du -sb "$PROJ/.chats-sandbox" 2>/dev/null | awk '{print $1}')
  local new_actions=$((post - pre))
  local new_bytes=$((${post_bytes:-0} - ${pre_bytes:-0}))

  # Strategies that showed up in the newly-created action folders
  local strats=""
  if [ "$new_actions" -gt 0 ]; then
    strats=$(ls -t "$PROJ/.chats-sandbox/backups" | grep '^action_' | head -"$new_actions" | \
      while read d; do
        python3 -c "
import json
try:
    m = json.load(open('$PROJ/.chats-sandbox/backups/' + '$d' + '/metadata.json'))
    print('+'.join(a.get('strategy','?') for a in m))
except:
    print('?')
" 2>/dev/null
      done | tr '\n' '|' | sed 's/|$//')
  fi

  echo "  wall=${WALL}s cost=\$${cost} turns=${turns} new_actions=${new_actions} new_bytes=${new_bytes} strats=[${strats}]" >&2
  echo "  result: ${result}" >&2

  # Escape commas in desc + notes
  local desc_safe="${DESC//,/;}"
  local notes_safe="ec=$ec ${result//,/;}"
  echo "$N,$desc_safe,$WALL,$cost,$turns,$new_actions,$new_bytes,$strats,$notes_safe" >> "$RESULTS"
}

task_run 01 "Login + create post" \
"Use the Playwright MCP to: (1) navigate to $SITE/login, (2) log in with username '$USER' password '$PASS', (3) navigate to $SITE/submit and create a new TEXT post in the forum named 'test' (or any active forum) with title 'chats-sandbox bench 001' and body 'initial body'. Report the URL of the created post."

task_run 02 "Edit own post body" \
"Use the Playwright MCP to: log in at $SITE/login as '$USER'/'$PASS'. Navigate to the user's page at $SITE/user/$USER/submissions. Find the most recent post titled 'chats-sandbox bench 001'. Click edit. Change the body to 'edited body v2'. Save. Report the URL."

task_run 03 "Delete own post" \
"Use the Playwright MCP to: log in at $SITE/login as '$USER'/'$PASS'. Navigate to $SITE/user/$USER/submissions. Find the most recent post titled 'chats-sandbox bench 001'. Click delete (confirm if needed). Report that it was deleted."

task_run 04 "Comment on a post" \
"Use the Playwright MCP to: log in at $SITE/login as '$USER'/'$PASS'. Navigate to $SITE/all (or homepage). Open any recent post you didn't author. Leave a comment 'chats-sandbox test comment'. Report the comment URL."

task_run 05 "Delete the comment just made" \
"Use the Playwright MCP to: log in at $SITE/login as '$USER'/'$PASS'. Navigate to $SITE/user/$USER/comments. Find the most recent comment 'chats-sandbox test comment'. Delete it. Report deletion."

task_run 06 "Upvote a post" \
"Use the Playwright MCP to: log in at $SITE/login as '$USER'/'$PASS'. Navigate to $SITE/all. Upvote the top-most post (click the up-arrow). Report the post title and the new score shown."

task_run 07 "Edit profile bio" \
"Use the Playwright MCP to: log in at $SITE/login as '$USER'/'$PASS'. Go to account / profile settings. Change the bio (aka 'about me' / description) to 'Testing CHATS-Sandbox remote backup'. Save. Report success."

task_run 08 "Subscribe to a forum" \
"Use the Playwright MCP to: log in at $SITE/login as '$USER'/'$PASS'. Navigate to $SITE/forums. Pick one forum you are NOT already subscribed to and subscribe to it. Report the forum name."

task_run 09 "Unsubscribe from the forum" \
"Use the Playwright MCP to: log in at $SITE/login as '$USER'/'$PASS'. Find any forum you're subscribed to. Unsubscribe. Report the forum name."

task_run 10 "Create another post (control / isolation)" \
"Use the Playwright MCP to: log in at $SITE/login as '$USER'/'$PASS'. Navigate to $SITE/submit and create a text post titled 'chats-sandbox bench 010' with body 'final marker post' in any active forum. Report the URL."

echo ""
echo "=== DONE ==="
column -s, -t "$RESULTS"
