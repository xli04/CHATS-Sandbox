#!/usr/bin/env bash
# E2E 02 — inside-workspace edit creates an action folder with git_snapshot.
# Requires: claude CLI authenticated (on PATH). Run as non-root (linuxuser).
set -u
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

CLI="$(cd "$(dirname "$0")" && pwd)/../dist/cli.js"
PROJ="/tmp/chats-e2e-02"
rm -rf "$PROJ"
mkdir -p "$PROJ"
cd "$PROJ" || exit 1

# Seed a file to edit
echo "original content line 1" > file.txt

node "$CLI" install > /tmp/e2e-02-install.log 2>&1 || fail "install failed"

# Initialize a git repo so git_snapshot has something to baseline against
git init -q && git add -A && git -c user.email=e2e@test -c user.name=e2e commit -qm "init" >/dev/null 2>&1

echo "Invoking claude -p to edit file.txt..."
START=$(date +%s)
# NOTE: do NOT pass --setting-sources user here — the plugin's hooks live in
# project .claude/settings.json, and this claude call simulates a real user
# session that SHOULD load them. Only the plugin's internal subagent uses
# --setting-sources user (to skip the deny rules).
claude -p "Use the Edit tool to change the line 'original content line 1' in file.txt to 'E2E_02_EDITED'. Report done." \
  --output-format json \
  --no-session-persistence \
  --dangerously-skip-permissions \
  --model haiku > /tmp/e2e-02-claude.json 2>&1
EC=$?
ELAPSED=$(($(date +%s) - START))
echo "claude exit=$EC elapsed=${ELAPSED}s"
[ $EC -eq 0 ] || fail "claude -p failed, see /tmp/e2e-02-claude.json"

# Assert: file.txt contains the edit
grep -q "E2E_02_EDITED" file.txt || fail "file.txt not edited (content: $(cat file.txt))"
pass "file.txt edit landed"

# Assert: action folder exists
ACTION=$(ls -1 .chats-sandbox/backups 2>/dev/null | grep '^action_' | head -1)
[ -n "$ACTION" ] || fail "no action folder created"
pass "action folder: $ACTION"

# Assert: metadata.json contains a git_snapshot artifact
META=".chats-sandbox/backups/$ACTION/metadata.json"
[ -f "$META" ] || fail "metadata.json missing"
grep -q '"strategy": "git_snapshot"' "$META" || fail "no git_snapshot in metadata: $(cat $META)"
pass "git_snapshot artifact recorded"

# Assert: shared shadow repo was created
[ -d .chats-sandbox/shadow-repo ] || fail "shadow-repo dir missing"
pass "shadow repo exists"

# Summary
echo ""
echo "=== Action dir contents ==="
ls -la ".chats-sandbox/backups/$ACTION/"
echo ""
echo "=== Strategies recorded ==="
python3 -c "import json; [print('  -', a.get('strategy')) for a in json.load(open('$META'))]"

echo ""
echo "E2E 02 OK — project kept at $PROJ for inspection"
