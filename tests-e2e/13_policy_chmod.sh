#!/usr/bin/env bash
# E2E 13 — tier-0 rule `chmod`.
set -u
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

CLI="$(cd "$(dirname "$0")" && pwd)/../dist/cli.js"
PRE_TOOL="$(cd "$(dirname "$0")" && pwd)/../dist/hooks/pre-tool.js"
PROJ="/tmp/chats-e2e-13"
rm -rf "$PROJ"
mkdir -p "$PROJ"
cd "$PROJ" || exit 1

touch target.sh
chmod 644 target.sh
BEFORE_MODE=$(stat -c %a target.sh 2>/dev/null || stat -f %Lp target.sh)
echo "mode before: $BEFORE_MODE"

node "$CLI" install > /tmp/e2e-13-install.log 2>&1 || fail "install failed"

echo "{\"hook_event\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"chmod 755 target.sh\"}}" \
  | node "$PRE_TOOL" > /tmp/e2e-13-hook.json 2>&1

ACTION=$(ls .chats-sandbox/backups | grep '^action_001_' | head -1)
[ -n "$ACTION" ] || fail "no action folder"
META=".chats-sandbox/backups/$ACTION/metadata.json"
grep -q '"policyRuleId": "chmod"' "$META" || fail "not matched by chmod rule"
pass "matched chmod rule"

# Simulate claude running the actual chmod
chmod 755 target.sh
AFTER_MODE=$(stat -c %a target.sh 2>/dev/null || stat -f %Lp target.sh)
[ "$AFTER_MODE" = "755" ] || fail "chmod didn't apply (mode=$AFTER_MODE)"
pass "simulated chmod: mode now 755"

# Restore → chmod back to original
node "$CLI" restore_direct 1 > /tmp/e2e-13-restore.log 2>&1 || fail "restore failed"
RESTORED=$(stat -c %a target.sh 2>/dev/null || stat -f %Lp target.sh)
[ "$RESTORED" = "$BEFORE_MODE" ] || fail "restore didn't revert mode (got $RESTORED, expected $BEFORE_MODE)"
pass "restored mode to $BEFORE_MODE"

echo ""
echo "E2E 13 OK"
