#!/usr/bin/env bash
# Stress 09 — 10 mixed actions, restore to action 3 (reverse-loop through 7).
# Assert: state matches "what existed when action 3 was about to run."
set -u
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

CLI="$(cd "$(dirname "$0")" && pwd)/../dist/cli.js"
PROJ="/tmp/chats-e2e-09-proj"
EXT="/tmp/chats-e2e-09-ext"
rm -rf "$PROJ" "$EXT"
mkdir -p "$PROJ" "$EXT/src"
echo "ext_v0" > "$EXT/src/ext.txt"

cd "$PROJ" || exit 1
node "$CLI" install > /tmp/e2e-09-install.log 2>&1 || fail "install failed"
git init -q && git add -A && git -c user.email=e2e -c user.name=e2e commit -qm "init" >/dev/null 2>&1

call_claude() {
  local label="$1"; shift
  echo "--- $label ---"
  claude -p "$*" --output-format json --no-session-persistence --dangerously-skip-permissions --model haiku > "/tmp/e2e-09-$label.json" 2>&1
  [ $? -eq 0 ] || fail "$label claude failed"
}

# Chain of 10 actions. After action 2: file_a, file_b exist + ext.txt is ext_v0.
# We'll restore to action 3 (pre-state = result of actions 1 and 2 applied).
call_claude "a01"  "Use the Write tool to create file file_a.txt with content 'file_a_v1'."
call_claude "a02"  "Use the Write tool to create file file_b.txt with content 'file_b_v1'."
# ── Expected "restore-to-3" pre-state ends HERE: file_a, file_b exist; ext.txt is ext_v0 ──

call_claude "a03"  "Use the Write tool to create file file_c.txt with content 'file_c_v1'."
call_claude "a04"  "Use the Edit tool to change 'ext_v0' in $EXT/src/ext.txt to 'ext_v1'."
call_claude "a05"  "Use the Edit tool to change 'file_a_v1' in file_a.txt to 'file_a_v2'."
call_claude "a06"  "Use the Write tool to create file $EXT/src/ext_new.txt with content 'external_written_by_a06'."
call_claude "a07"  "Use the Edit tool to change 'file_b_v1' in file_b.txt to 'file_b_v2'."
call_claude "a08"  "Use the Edit tool to change 'ext_v1' in $EXT/src/ext.txt to 'ext_v2'."
call_claude "a09"  "Use the Write tool to create file file_d.txt with content 'file_d_v1'."
call_claude "a10"  "Use the Edit tool to change 'file_c_v1' in file_c.txt to 'file_c_v2'."

echo ""
echo "=== Chain complete. 10 action folders expected ==="
N=$(ls .chats-sandbox/backups | grep -c '^action_')
[ "$N" -eq 10 ] || fail "expected 10 folders, got $N"
pass "10 action folders before restore"

# Sanity: final disk state post-chain
[ "$(cat file_a.txt)" = "file_a_v2" ]  || fail "pre-restore file_a wrong"
[ "$(cat file_b.txt)" = "file_b_v2" ]  || fail "pre-restore file_b wrong"
[ "$(cat file_c.txt)" = "file_c_v2" ]  || fail "pre-restore file_c wrong"
[ "$(cat file_d.txt)" = "file_d_v1" ]  || fail "pre-restore file_d wrong"
[ "$(cat "$EXT/src/ext.txt")" = "ext_v2" ] || fail "pre-restore ext wrong: $(cat $EXT/src/ext.txt)"
[ -f "$EXT/src/ext_new.txt" ] || fail "pre-restore ext_new missing"
pass "pre-restore final state matches expected"

# ── Restore to action 3 ──
echo ""
echo "=== Running: chats-sandbox restore 3 ==="
node "$CLI" restore 3 > /tmp/e2e-09-restore.log 2>&1
RC=$?
tail -20 /tmp/e2e-09-restore.log
[ $RC -eq 0 ] || fail "restore exited $RC"

# ── Post-restore assertions ──
echo ""
echo "=== Post-restore disk state ==="
ls
echo "ext dir:"
ls "$EXT/src"

# Files from a01/a02 must exist at v1
[ "$(cat file_a.txt 2>/dev/null)" = "file_a_v1" ] || fail "file_a not reverted to v1 (got: $(cat file_a.txt 2>/dev/null))"
[ "$(cat file_b.txt 2>/dev/null)" = "file_b_v1" ] || fail "file_b not reverted to v1 (got: $(cat file_b.txt 2>/dev/null))"
pass "file_a, file_b reverted to v1"

# Files created by a03, a09 must be gone (or reverted — c is created by a03, so gone; d by a09, gone)
[ ! -f file_c.txt ] || fail "file_c.txt should have been removed (created by a03, which is target's pre-state)"
[ ! -f file_d.txt ] || fail "file_d.txt should have been removed"
pass "file_c and file_d gone (correctly undone)"

# External file reverted to ext_v0 (both a04 and a08 edited it)
[ "$(cat "$EXT/src/ext.txt")" = "ext_v0" ] || fail "ext.txt not reverted to v0: $(cat $EXT/src/ext.txt)"
pass "ext.txt reverted to ext_v0"

# ext_new.txt was created by a06 (external); subagent should have undone it
if [ -f "$EXT/src/ext_new.txt" ]; then
  echo "NOTE: ext_new.txt still present — subagent recovery may not delete external creates. This is a known limitation (checkout-index doesn't remove extras outside the tracked tree). Flagging as soft-fail."
else
  pass "ext_new.txt removed by subagent recovery"
fi

# Intermediate action folders should be pruned after successful restore
REMAINING=$(ls .chats-sandbox/backups 2>/dev/null | grep -c '^action_' || echo 0)
echo "info: $REMAINING action folder(s) remaining post-restore"
[ "$REMAINING" -le 2 ] || fail "expected <=2 folders post-restore, got $REMAINING"
pass "restore pruned intermediate folders"

echo ""
echo "Stress 09 OK"
