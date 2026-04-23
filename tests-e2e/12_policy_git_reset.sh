#!/usr/bin/env bash
# E2E 12 — tier-0 rule `git-reset-hard`.
# Run without claude — this is a pure rule-matcher test, it's cheaper to
# hit the pipeline directly by piping hook JSON into the pre-tool hook.
set -u
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

CLI="$(cd "$(dirname "$0")" && pwd)/../dist/cli.js"
PRE_TOOL="$(cd "$(dirname "$0")" && pwd)/../dist/hooks/pre-tool.js"
PROJ="/tmp/chats-e2e-12"
rm -rf "$PROJ"
mkdir -p "$PROJ"
cd "$PROJ" || exit 1

# Git repo with two commits so we can meaningfully reset --hard HEAD~1
git init -q
git -c user.email=e2e -c user.name=e2e config commit.gpgsign false
echo "v1" > a.txt && git add -A && git -c user.email=e2e -c user.name=e2e commit -qm "v1"
echo "v2" > a.txt && git -c user.email=e2e -c user.name=e2e commit -aqm "v2"
BEFORE_HEAD=$(git rev-parse HEAD)
echo "HEAD before: $BEFORE_HEAD"

node "$CLI" install > /tmp/e2e-12-install.log 2>&1 || fail "install failed"

# Fire the pre-tool hook as if claude were about to run `git reset --hard HEAD~1`
echo "{\"hook_event\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git reset --hard HEAD~1\"}}" \
  | node "$PRE_TOOL" > /tmp/e2e-12-hook.json 2>&1
cat /tmp/e2e-12-hook.json | head -c 500; echo ""

# Action folder should exist with policy_rewrite + git-reset-hard
ACTION=$(ls .chats-sandbox/backups | grep '^action_001_' | head -1)
[ -n "$ACTION" ] || fail "no action folder"
pass "action folder: $ACTION"

META=".chats-sandbox/backups/$ACTION/metadata.json"
grep -q '"strategy": "policy_rewrite"' "$META" || fail "strategy wrong"
grep -q '"policyRuleId": "git-reset-hard"' "$META" || fail "ruleId not git-reset-hard"
pass "rule matched: git-reset-hard"

# Recovery command must reset back to the CURRENT head
RECOVERY=$(python3 -c "import json; m=json.load(open('$META')); print(m[0]['recoveryCommands'][0])")
echo "recoveryCommand: $RECOVERY"
echo "$RECOVERY" | grep -q "git reset --hard $BEFORE_HEAD" || fail "recovery doesn't point at original HEAD"
pass "recovery = git reset --hard $BEFORE_HEAD"

# The pre-tool hook does NOT execute the reset (our rule returns
# updatedInput=original, meaning Claude would run the reset). Simulate
# that by running the command ourselves, then run restore.
git reset --hard HEAD~1 > /dev/null
[ "$(cat a.txt)" = "v1" ] || fail "reset didn't apply (got: $(cat a.txt))"
pass "simulated user-side reset: a.txt is v1, HEAD=$(git rev-parse HEAD | cut -c1-8)"

# Restore the action → should `git reset --hard $BEFORE_HEAD` → a.txt=v2
node "$CLI" restore_direct 1 > /tmp/e2e-12-restore.log 2>&1 || fail "restore failed"
[ "$(cat a.txt)" = "v2" ] || fail "restore didn't bring HEAD back (a.txt=$(cat a.txt))"
[ "$(git rev-parse HEAD)" = "$BEFORE_HEAD" ] || fail "HEAD not at $BEFORE_HEAD"
pass "restore brought HEAD back to $BEFORE_HEAD ($(git rev-parse HEAD | cut -c1-8))"

echo ""
echo "E2E 12 OK"
