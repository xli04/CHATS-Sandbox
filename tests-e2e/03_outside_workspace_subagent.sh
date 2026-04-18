#!/usr/bin/env bash
# E2E 03 — out-of-workspace edit triggers the tier-3 subagent.
# This is the decisive test of the deny-rules-escape fix (--setting-sources user)
# and the plugin's overall ability to back up external project files.
#
# Requires: claude CLI authenticated, non-root user.
set -u
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

CLI="$(cd "$(dirname "$0")" && pwd)/../dist/cli.js"
PROJ="/tmp/chats-e2e-03a"
EXT="/tmp/chats-e2e-03b"
rm -rf "$PROJ" "$EXT"
mkdir -p "$PROJ" "$EXT/src"
echo "pre-edit payload" > "$EXT/src/target.txt"

cd "$PROJ" || exit 1

node "$CLI" install > /tmp/e2e-03-install.log 2>&1 || fail "install failed"
git init -q && git add -A && git -c user.email=e2e@test -c user.name=e2e commit -qm "init" >/dev/null 2>&1

echo "Invoking claude -p to edit OUT-OF-WORKSPACE file $EXT/src/target.txt ..."
START=$(date +%s)
claude -p "Use the Edit tool to change the single line 'pre-edit payload' in the file at $EXT/src/target.txt to the exact string 'E2E_03_EDITED_EXTERNAL'. Do not touch any other file. Report done." \
  --output-format json \
  --no-session-persistence \
  --dangerously-skip-permissions \
  --model haiku > /tmp/e2e-03-claude.json 2>&1
EC=$?
ELAPSED=$(($(date +%s) - START))
echo "claude exit=$EC elapsed=${ELAPSED}s"
[ $EC -eq 0 ] || fail "claude -p failed, see /tmp/e2e-03-claude.json"

# Primary assert: external edit actually landed
grep -q "E2E_03_EDITED_EXTERNAL" "$EXT/src/target.txt" || fail "external edit did not land (content: $(cat $EXT/src/target.txt))"
pass "external edit landed: $(cat $EXT/src/target.txt)"

# Action folder in project
ACTION=$(ls -1 .chats-sandbox/backups 2>/dev/null | grep '^action_' | head -1)
[ -n "$ACTION" ] || fail "no action folder"
pass "action folder: $ACTION"

META=".chats-sandbox/backups/$ACTION/metadata.json"

# The decisive assertions: BOTH strategies present
STRATS=$(python3 -c "import json; print(' '.join(a.get('strategy','') for a in json.load(open('$META'))))")
echo "strategies recorded: $STRATS"
echo "$STRATS" | grep -q "git_snapshot" || fail "no git_snapshot"
pass "git_snapshot recorded"

echo "$STRATS" | grep -q "subagent" || fail "no subagent artifact — tier-3 didn't fire or failed"
pass "subagent strategy recorded"

# external-shadow/ dir means the subagent actually did the work
# (not just recorded a blueprint and bailed)
SHADOW=".chats-sandbox/backups/$ACTION/external-shadow"
[ -d "$SHADOW/objects" ] || fail "external-shadow/objects missing — subagent returned blueprint but didn't execute it"
pass "external-shadow/ has git objects"

OBJS=$(find "$SHADOW/objects" -type f 2>/dev/null | wc -l)
[ "$OBJS" -gt 0 ] || fail "external-shadow has no actual git objects on disk"
pass "external-shadow/ contains $OBJS git object files"

# Confirm the subagent didn't self-refuse with "permission restrictions"
if grep -q "permission restrictions\|Unable to create" .chats-sandbox/subagent.log 2>/dev/null; then
  fail "subagent refused ('permission restrictions' found in subagent.log) — --setting-sources user is NOT escaping deny rules"
fi
pass "no self-refusal in subagent.log"

# Recovery commands were recorded
python3 -c "
import json, sys
m = json.load(open('$META'))
for a in m:
    if a.get('strategy') == 'subagent':
        cmds = a.get('subagentCommands', [])
        assert len(cmds) >= 1, 'no recovery_commands stored'
        print('  recovery_commands count:', len(cmds))
        for c in cmds:
            print('   -', c[:120])
        sys.exit(0)
sys.exit(1)
" || fail "no subagentCommands stored"
pass "recovery commands persisted"

echo ""
echo "E2E 03 OK — kept project at $PROJ, external at $EXT for inspection"
