#!/usr/bin/env bash
# Stress 08 — 12 actions alternating in/out of workspace.
# Every action must get a folder. Strategy mix must match action type.
set -u
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

CLI="$(cd "$(dirname "$0")" && pwd)/../dist/cli.js"
PROJ="/tmp/chats-e2e-08-proj"
EXT="/tmp/chats-e2e-08-ext"
rm -rf "$PROJ" "$EXT"
mkdir -p "$PROJ" "$EXT/src"
echo "orig_ext_v0" > "$EXT/src/out.txt"

cd "$PROJ" || exit 1
node "$CLI" install > /tmp/e2e-08-install.log 2>&1 || fail "install failed"
git init -q && git add -A && git -c user.email=e2e -c user.name=e2e commit -qm "init" >/dev/null 2>&1

call_claude() {
  local label="$1"; shift
  local prompt="$*"
  echo "--- $label ---"
  claude -p "$prompt" --output-format json --no-session-persistence --dangerously-skip-permissions --model haiku > "/tmp/e2e-08-$label.json" 2>&1
  local ec=$?
  [ $ec -eq 0 ] || fail "$label claude exit=$ec"
}

# 12 actions alternating IN, OUT, IN, OUT, ...
call_claude "a01-IN"  "Use the Write tool to create file a01.txt in the current directory with content 'a01'."
call_claude "a02-OUT" "Use the Edit tool to change the line 'orig_ext_v0' in $EXT/src/out.txt to 'v1_from_a02'."
call_claude "a03-IN"  "Use the Write tool to create file a03.txt in the current directory with content 'a03'."
call_claude "a04-OUT" "Use the Edit tool to change the line 'v1_from_a02' in $EXT/src/out.txt to 'v2_from_a04'."
call_claude "a05-IN"  "Use the Write tool to create file a05.txt in the current directory with content 'a05'."
call_claude "a06-OUT" "Use the Write tool to create file $EXT/src/new_from_a06.txt with content 'a06_external'."
call_claude "a07-IN"  "Use the Edit tool to change the line 'a01' in a01.txt to 'a01_modified_by_a07'."
call_claude "a08-OUT" "Use the Edit tool to change the line 'v2_from_a04' in $EXT/src/out.txt to 'v3_from_a08'."
call_claude "a09-IN"  "Use the Write tool to create file a09.txt in the current directory with content 'a09'."
call_claude "a10-OUT" "Use the Write tool to create file $EXT/src/new_from_a10.txt with content 'a10_external'."
call_claude "a11-IN"  "Use the Edit tool to change the line 'a03' in a03.txt to 'a03_modified_by_a11'."
call_claude "a12-OUT" "Use the Edit tool to change the line 'v3_from_a08' in $EXT/src/out.txt to 'v4_from_a12'."

# ── Assertions ──
echo ""
echo "=== Action folders ==="
ls .chats-sandbox/backups | grep '^action_' | sort

N=$(ls .chats-sandbox/backups | grep -c '^action_')
[ "$N" -eq 12 ] || fail "expected 12 folders, got $N"
pass "12 action folders"

# Seq 001..012 contiguous
SEQS=$(ls .chats-sandbox/backups | grep '^action_' | sort | awk -F_ '{print $2}' | tr '\n' ' ')
EXPECTED="001 002 003 004 005 006 007 008 009 010 011 012 "
[ "$SEQS" = "$EXPECTED" ] || fail "seqs not contiguous 001..012: got '$SEQS'"
pass "monotonic contiguous seqs 001..012"

# Per-action strategy: odd=IN (no subagent), even=OUT (yes subagent)
check_strats() {
  local n="$1"; local want_subagent="$2"
  local folder=$(ls .chats-sandbox/backups | grep "^action_$n" | head -1)
  [ -n "$folder" ] || fail "no folder for $n"
  local meta=".chats-sandbox/backups/$folder/metadata.json"
  grep -q '"strategy": "git_snapshot"' "$meta" || fail "$n missing git_snapshot"
  if [ "$want_subagent" = "yes" ]; then
    grep -q '"strategy": "subagent"' "$meta" || fail "$n missing subagent (expected OUT)"
  else
    if grep -q '"strategy": "subagent"' "$meta"; then
      fail "$n has subagent but shouldn't (IN)"
    fi
  fi
}

for i in 001 003 005 007 009 011; do check_strats "$i" "no"; done
for i in 002 004 006 008 010 012; do check_strats "$i" "yes"; done
pass "6 IN actions: git_snapshot only"
pass "6 OUT actions: git_snapshot + subagent"

# Final disk state
grep -q "a01_modified_by_a07" a01.txt || fail "a01.txt wrong"
grep -q "a03_modified_by_a11" a03.txt || fail "a03.txt wrong"
grep -q "^a05$" a05.txt || fail "a05.txt wrong: $(cat a05.txt)"
grep -q "^a09$" a09.txt || fail "a09.txt wrong: $(cat a09.txt)"
grep -q "v4_from_a12" "$EXT/src/out.txt" || fail "out.txt wrong: $(cat $EXT/src/out.txt)"
grep -q "a06_external" "$EXT/src/new_from_a06.txt" || fail "new_from_a06 missing"
grep -q "a10_external" "$EXT/src/new_from_a10.txt" || fail "new_from_a10 missing"
pass "all 12 actions left correct final state on disk"

# Pointer-artifact count (expected on OUT-after-OUT sequences where the
# workspace didn't drift between them).
POINTERS=$(grep -l "pointer →" .chats-sandbox/backups/*/metadata.json 2>/dev/null | wc -l)
echo "info: $POINTERS pointer-artifacts across the chain"

# ── Restore checks ──
# Spot-check restore at two points: action 7 and action 1.
# Going to action 7 means undoing actions 8..12. Pre-a07 state:
#   a01.txt = 'a1' (a07 changes it, so BEFORE a07 it should still be 'a1')
#   a03.txt = 'a3' (a11 changes it, so pre-a07 it's still 'a3')
#   a05.txt = 'a5' (never changed; was created by a05 so exists pre-a07)
#   a09.txt: DOES NOT EXIST (a09 creates it, after a07)
#   ext out.txt: pre-a07 → it's 'v2_from_a04' (a08 changes it to v3, a12 to v4)
#   ext new_from_a06.txt: EXISTS (a06 creates before a07)
#   ext new_from_a10.txt: DOES NOT EXIST (a10 creates, after a07)
echo ""
echo "=== Restore to action 7 (undoes a08..a12) ==="
node "$CLI" restore 7 > /tmp/e2e-08-restore7.log 2>&1 || fail "restore 7 failed"

[ "$(cat a01.txt 2>/dev/null)" = "a01" ] || fail "a01.txt should be 'a01' pre-a07, got: $(cat a01.txt 2>/dev/null)"
[ "$(cat a03.txt 2>/dev/null)" = "a03" ] || fail "a03.txt should be 'a03' pre-a07, got: $(cat a03.txt 2>/dev/null)"
[ -f a05.txt ] || fail "a05.txt should exist pre-a07"
[ ! -f a09.txt ] || fail "a09.txt should NOT exist pre-a07"
[ "$(cat "$EXT/src/out.txt")" = "v2_from_a04" ] || fail "out.txt should be v2_from_a04 pre-a07, got: $(cat $EXT/src/out.txt)"
[ -f "$EXT/src/new_from_a06.txt" ] || fail "new_from_a06 should exist pre-a07"
[ ! -f "$EXT/src/new_from_a10.txt" ] || fail "new_from_a10 should NOT exist pre-a07 (was created by a10)"
pass "restore to 7 → all 7 disk assertions hold"

# Remaining actions post-restore should be 1..6 (a07 and later got pruned)
POST_N=$(ls .chats-sandbox/backups | grep -c '^action_')
[ "$POST_N" -le 6 ] || fail "expected ≤6 action folders post-restore-to-7, got $POST_N"
pass "intermediate folders pruned after restore (now $POST_N)"

# Second restore to action 1 — fully back to the state after a01 ran.
# Pre-a01 pre-state includes only the .claude/ install artifacts and the
# empty workspace. After running a01 (Write a01.txt) the workspace has
# a01.txt='a01'. But restore N applies action N's PRE-state, which is the
# workspace BEFORE a01 — so a01.txt should be gone.
echo ""
echo "=== Restore to action 1 (back to PRE-a01 state) ==="
node "$CLI" restore 1 > /tmp/e2e-08-restore1.log 2>&1 || fail "restore 1 failed"

[ ! -f a01.txt ] || fail "a01.txt should be gone after restore to action 1 (pre-state had no a01.txt)"
[ ! -f a03.txt ] || fail "a03.txt should be gone"
[ ! -f a05.txt ] || fail "a05.txt should be gone"
pass "restore to 1 → all inside-workspace created files removed"

# External file reverts too
[ "$(cat "$EXT/src/out.txt")" = "orig_ext_v0" ] || fail "out.txt not reverted to orig, got: $(cat $EXT/src/out.txt)"
pass "external out.txt reverted to orig_ext_v0"

echo ""
echo "Stress 08 OK — proj at $PROJ, ext at $EXT"
