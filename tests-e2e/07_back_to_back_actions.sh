#!/usr/bin/env bash
# E2E 07 — two consecutive actions both produce action folders, even when
# the workspace hasn't drifted between them (regression guard for the
# "silent action #2" bug where PreToolUse git snapshot dedup swallowed
# a write whose pre-state matched the previous snapshot).
set -u
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

CLI="$(cd "$(dirname "$0")" && pwd)/../dist/cli.js"
PROJ="/tmp/chats-e2e-07-proj"
EXT="/tmp/chats-e2e-07-ext"
rm -rf "$PROJ" "$EXT"
mkdir -p "$PROJ" "$EXT/src"
echo "original external" > "$EXT/src/target.txt"

cd "$PROJ" || exit 1
node "$CLI" install > /tmp/e2e-07-install.log 2>&1 || fail "install failed"
git init -q && git add -A && git -c user.email=e2e@test -c user.name=e2e commit -qm "init" >/dev/null 2>&1

# --- Action 1: outside-workspace edit (triggers subagent) ---
echo "--- Action 1: edit outside-workspace file ---"
claude -p "Use the Edit tool to change the single line 'original external' in $EXT/src/target.txt to 'EXTERNAL_EDITED'. Report done." \
  --output-format json --no-session-persistence --dangerously-skip-permissions --model haiku > /tmp/e2e-07-a.json 2>&1
[ $? -eq 0 ] || fail "action 1 claude failed"

# --- Action 2: inside-workspace write (the one that used to be swallowed) ---
echo "--- Action 2: write file inside workspace ---"
claude -p "Use the Write tool to create file config/new_settings.ts in the current workspace with a single line 'export const X = 1;'. Report done." \
  --output-format json --no-session-persistence --dangerously-skip-permissions --model haiku > /tmp/e2e-07-b.json 2>&1
[ $? -eq 0 ] || fail "action 2 claude failed"

# --- Assertions ---
echo ""
echo "=== Action folders on disk ==="
ls .chats-sandbox/backups | grep '^action_' | sort

N=$(ls .chats-sandbox/backups | grep -c '^action_')
[ "$N" -eq 2 ] || fail "expected 2 action folders, got $N"
pass "2 action folders created (action 2 was not swallowed)"

# Action 1 should have subagent + git_snapshot
A1=$(ls .chats-sandbox/backups | grep '^action_001_' | head -1)
[ -n "$A1" ] || fail "no action_001_*"
grep -q '"strategy": "subagent"' ".chats-sandbox/backups/$A1/metadata.json" || fail "action 1 missing subagent"
grep -q '"strategy": "git_snapshot"' ".chats-sandbox/backups/$A1/metadata.json" || fail "action 1 missing git_snapshot"
pass "action 1: git_snapshot + subagent"

# Action 2 should have ONLY git_snapshot (inside workspace, pointer to HEAD)
A2=$(ls .chats-sandbox/backups | grep '^action_002_' | head -1)
[ -n "$A2" ] || fail "no action_002_*"
grep -q '"strategy": "git_snapshot"' ".chats-sandbox/backups/$A2/metadata.json" || fail "action 2 missing git_snapshot"
! grep -q '"strategy": "subagent"' ".chats-sandbox/backups/$A2/metadata.json" || fail "action 2 should not have subagent"
pass "action 2: git_snapshot only"

# Confirm action 2's git_snapshot points at a valid commit hash
HASH=$(python3 -c "import json; m=json.load(open('.chats-sandbox/backups/$A2/metadata.json')); print(m[0]['commitHash'])")
[ ${#HASH} -eq 40 ] || fail "action 2 commitHash malformed: $HASH"
pass "action 2 references commit $(echo $HASH | cut -c1-8)..."

# Pointer-artifact description contains "pointer →" when workspace didn't drift
DESC=$(python3 -c "import json; m=json.load(open('.chats-sandbox/backups/$A2/metadata.json')); print(m[0]['description'])")
echo "  action 2 description: $DESC"
echo "$DESC" | grep -q "pointer" && pass "action 2 description flags pointer path" || echo "  (note: fresh workspace drift — file was created, so this committed a new snapshot, that's fine)"

echo ""
echo "E2E 07 OK"
