#!/usr/bin/env bash
# E2E 01 — install wiring sanity check.
# No claude call required. Runs anywhere (root OK).
set -u
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

CLI="$(cd "$(dirname "$0")" && pwd)/../dist/cli.js"
PROJ="/tmp/chats-e2e-01"
rm -rf "$PROJ"
mkdir -p "$PROJ"
cd "$PROJ" || exit 1

node "$CLI" install > /tmp/e2e-01-install.log 2>&1 || fail "install exit code $?"

# Assert: .claude/settings.json exists
[ -f .claude/settings.json ] || fail ".claude/settings.json not created"
pass "settings.json exists"

# Assert: all 4 hooks wired
for hook in PreToolUse PostToolUse PostToolUseFailure UserPromptSubmit; do
  grep -q "\"$hook\"" .claude/settings.json || fail "missing $hook in settings"
done
pass "4 hooks wired"

# Assert: deny rules for .chats-sandbox/** are present
for tool in Read Edit Write Glob Grep; do
  grep -q "\"$tool(.chats-sandbox/\*\*)\"" .claude/settings.json || fail "missing deny rule for $tool"
done
pass "5 deny rules present"

# Assert: config + gitignore
[ -f .chats-sandbox/config.json ] || fail "config.json not created"
pass "config.json exists"
grep -q "^\.chats-sandbox/$" .gitignore 2>/dev/null && pass ".gitignore entry present" || echo "NOTE: no .gitignore or missing entry (not fatal unless repo)"

# Assert: slash commands installed
ls .claude/commands/sandbox:*.md > /tmp/e2e-01-cmds.txt 2>/dev/null
CMD_COUNT=$(wc -l < /tmp/e2e-01-cmds.txt)
[ "$CMD_COUNT" -ge 8 ] || fail "expected >=8 slash commands, got $CMD_COUNT"
pass "$CMD_COUNT slash commands installed"

echo ""
echo "E2E 01 OK — project kept at $PROJ for inspection"
