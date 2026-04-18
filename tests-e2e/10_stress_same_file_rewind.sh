#!/usr/bin/env bash
# Stress 10 — 6 consecutive edits to the SAME external file + 2 interleaved
# inside-workspace writes (8 actions total). Then rewind: restore to 5, 4,
# 3, 2, 1 in turn, verifying the external file content at each step.
# This stresses the subagent recovery chain under repeated overwrites.
set -u
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

CLI="$(cd "$(dirname "$0")" && pwd)/../dist/cli.js"
PROJ="/tmp/chats-e2e-10-proj"
EXT="/tmp/chats-e2e-10-ext"
rm -rf "$PROJ" "$EXT"
mkdir -p "$PROJ" "$EXT/src"
echo "EXT_V0" > "$EXT/src/file.txt"

cd "$PROJ" || exit 1
node "$CLI" install > /tmp/e2e-10-install.log 2>&1 || fail "install failed"
git init -q && git add -A && git -c user.email=e2e -c user.name=e2e commit -qm "init" >/dev/null 2>&1

call_claude() {
  local label="$1"; shift
  echo "--- $label ---"
  claude -p "$*" --output-format json --no-session-persistence --dangerously-skip-permissions --model haiku > "/tmp/e2e-10-$label.json" 2>&1
  [ $? -eq 0 ] || fail "$label claude failed"
}

# 8 actions. Out = edits to SAME external file. In = workspace file writes.
# Track expected values in an array.
#   a01 OUT: EXT_V0 → EXT_V1
#   a02 IN:  create in_01.txt
#   a03 OUT: EXT_V1 → EXT_V2
#   a04 OUT: EXT_V2 → EXT_V3
#   a05 IN:  create in_02.txt
#   a06 OUT: EXT_V3 → EXT_V4
#   a07 OUT: EXT_V4 → EXT_V5
#   a08 OUT: EXT_V5 → EXT_V6

call_claude "a01" "Use the Edit tool to change 'EXT_V0' in $EXT/src/file.txt to 'EXT_V1'."
call_claude "a02" "Use the Write tool to create file in_01.txt with content 'in_01_value'."
call_claude "a03" "Use the Edit tool to change 'EXT_V1' in $EXT/src/file.txt to 'EXT_V2'."
call_claude "a04" "Use the Edit tool to change 'EXT_V2' in $EXT/src/file.txt to 'EXT_V3'."
call_claude "a05" "Use the Write tool to create file in_02.txt with content 'in_02_value'."
call_claude "a06" "Use the Edit tool to change 'EXT_V3' in $EXT/src/file.txt to 'EXT_V4'."
call_claude "a07" "Use the Edit tool to change 'EXT_V4' in $EXT/src/file.txt to 'EXT_V5'."
call_claude "a08" "Use the Edit tool to change 'EXT_V5' in $EXT/src/file.txt to 'EXT_V6'."

# Sanity
N=$(ls .chats-sandbox/backups | grep -c '^action_')
[ "$N" -eq 8 ] || fail "expected 8 folders, got $N"
pass "8 action folders"

[ "$(cat "$EXT/src/file.txt")" = "EXT_V6" ] || fail "final ext wrong: $(cat $EXT/src/file.txt)"
pass "final state: ext=EXT_V6 as expected"

# Check: each OUT action should have created its own external-shadow/ with
# pre-edit content. Walk through 6 OUT actions and confirm distinct shadow repos.
OUT_ACTIONS="001 003 004 006 007 008"
SHADOWS=0
for n in $OUT_ACTIONS; do
  folder=$(ls .chats-sandbox/backups | grep "^action_$n" | head -1)
  [ -d ".chats-sandbox/backups/$folder/external-shadow" ] && SHADOWS=$((SHADOWS + 1))
done
[ "$SHADOWS" -eq 6 ] || fail "expected 6 external-shadow dirs (one per OUT action), got $SHADOWS"
pass "6 distinct external-shadow repos (one per OUT action)"

# ── Sequential rewind ──
# Restore to action N should leave external file at the value it had BEFORE action N ran.
# Before a01: EXT_V0, before a03: EXT_V1 (a02 didn't touch ext), before a04: EXT_V2,
# before a06: EXT_V3, before a07: EXT_V4, before a08: EXT_V5.

check_after_restore() {
  local target_seq="$1"; local expected="$2"
  echo "--- Restoring to action $target_seq (expect ext=$expected) ---"
  node "$CLI" restore "$target_seq" > "/tmp/e2e-10-restore-$target_seq.log" 2>&1
  local rc=$?
  [ $rc -eq 0 ] || fail "restore $target_seq failed (rc=$rc); tail: $(tail -5 /tmp/e2e-10-restore-$target_seq.log)"
  local got=$(cat "$EXT/src/file.txt")
  [ "$got" = "$expected" ] || fail "after restore to $target_seq, ext=$got expected=$expected"
  pass "restore to $target_seq → ext=$expected"
}

# Rewind through the chain. Each restore should leave ext at action N's pre-state.
# Note: restore prunes intermediates, so after restoring to 7 we can only go to <=6.
check_after_restore 7 "EXT_V4"
check_after_restore 6 "EXT_V3"
check_after_restore 4 "EXT_V2"
check_after_restore 3 "EXT_V1"
check_after_restore 1 "EXT_V0"

# Inside-workspace files: at this point we're back to pre-a01, which is
# before a02 (which created in_01.txt) too. So in_01.txt should be gone.
[ ! -f in_01.txt ] || fail "in_01.txt should have been removed by final restore"
[ ! -f in_02.txt ] || fail "in_02.txt should have been removed"
pass "inside-workspace files also reverted"

echo ""
echo "Stress 10 OK — proj $PROJ, ext $EXT"
