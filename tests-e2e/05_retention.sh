#!/usr/bin/env bash
# E2E 05 — retention pruning honors maxActions=3 across 5 synthetic actions.
# Runs without claude — uses the plugin CLI + direct hook invocation (stdin).
# This is the e2e counterpart of the unit tests; we want to be sure the
# installed binary behaves the same as the test harness.
set -u
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

CLI="$(cd "$(dirname "$0")" && pwd)/../dist/cli.js"
PRE_TOOL="$(cd "$(dirname "$0")" && pwd)/../dist/hooks/pre-tool.js"
PROJ="/tmp/chats-e2e-05"
rm -rf "$PROJ"
mkdir -p "$PROJ"
cd "$PROJ" || exit 1

node "$CLI" install > /tmp/e2e-05-install.log 2>&1 || fail "install failed"
node "$CLI" config set maxActions 3 > /dev/null || fail "config set failed"

# Fire 5 pre-tool hook invocations with distinct Bash commands.
# Use commands matching alwaysBackupPatterns so a backup is guaranteed.
for i in 1 2 3 4 5; do
  echo "{\"hook_event\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"pip install test-pkg-$i\"}}" \
    | node "$PRE_TOOL" > /dev/null 2>&1
  sleep 1  # keep folder timestamps distinct (seconds granularity)
done

# Count action folders
N=$(ls .chats-sandbox/backups 2>/dev/null | grep -c '^action_')
echo "action folders on disk: $N (max=3)"

[ "$N" -eq 3 ] || fail "expected exactly 3, got $N"
pass "maxActions=3 enforced"

# And the 3 kept should be the NEWEST (action_003, _004, _005 → pruned _001, _002)
KEPT=$(ls .chats-sandbox/backups | grep '^action_' | sort | awk -F_ '{print $2}' | tr '\n' ' ')
echo "seq numbers kept: $KEPT"

# Must include 003 004 005 and NOT include 001 002
echo "$KEPT" | grep -q "003" || fail "expected 003 in survivors"
echo "$KEPT" | grep -q "004" || fail "expected 004 in survivors"
echo "$KEPT" | grep -q "005" || fail "expected 005 in survivors"
echo "$KEPT" | grep -q "001" && fail "001 should have been pruned"
echo "$KEPT" | grep -q "002" && fail "002 should have been pruned"
pass "oldest (001, 002) pruned; newest three kept"

echo ""
echo "E2E 05 OK — project kept at $PROJ"
