#!/usr/bin/env bash
# E2E 04 — restore reverts the action.
# Tests BOTH tier-2 (git_snapshot) and tier-3 (subagent recovery_commands).
# Reuses the project dirs left over from E2E 02 and E2E 03.
set -u
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

CLI="$(cd "$(dirname "$0")" && pwd)/../dist/cli.js"

# ── Part A: tier-2 (inside-workspace) restore ─────────────────────────
PROJ_A="/tmp/chats-e2e-02"
if [ ! -d "$PROJ_A" ]; then
  echo "SKIP part A: run 02 first"
else
  echo "=== Part A: tier-2 restore (inside-workspace) ==="
  cd "$PROJ_A" || exit 1
  # Pre-check: file currently says E2E_02_EDITED
  BEFORE=$(cat file.txt)
  echo "file.txt before restore: $BEFORE"
  grep -q "E2E_02_EDITED" file.txt || fail "starting state wrong (expected E2E_02_EDITED)"

  # restore_direct 1 → apply the pre-action snapshot, reverting the edit
  node "$CLI" restore_direct 1 > /tmp/e2e-04a.log 2>&1 || fail "restore_direct failed, see /tmp/e2e-04a.log"

  AFTER=$(cat file.txt)
  echo "file.txt after restore:  $AFTER"
  grep -q "original content line 1" file.txt || fail "file.txt NOT reverted (after=$AFTER)"
  ! grep -q "E2E_02_EDITED" file.txt || fail "E2E_02_EDITED still present"
  pass "tier-2 restore reverted file.txt"
fi

echo ""

# ── Part B: tier-3 (subagent) restore on external file ───────────────
PROJ_B="/tmp/chats-e2e-03a"
EXT_B="/tmp/chats-e2e-03b"
if [ ! -d "$PROJ_B" ]; then
  echo "SKIP part B: run 03 first"
else
  echo "=== Part B: tier-3 restore (subagent recovery_commands) ==="
  cd "$PROJ_B" || exit 1
  BEFORE=$(cat "$EXT_B/src/target.txt")
  echo "target.txt before restore: $BEFORE"
  grep -q "E2E_03_EDITED_EXTERNAL" "$EXT_B/src/target.txt" || fail "starting state wrong"

  node "$CLI" restore_direct 1 > /tmp/e2e-04b.log 2>&1 || fail "restore_direct failed, see /tmp/e2e-04b.log"

  AFTER=$(cat "$EXT_B/src/target.txt")
  echo "target.txt after restore:  $AFTER"
  grep -q "pre-edit payload" "$EXT_B/src/target.txt" || fail "external file NOT reverted (after=$AFTER)"
  ! grep -q "E2E_03_EDITED_EXTERNAL" "$EXT_B/src/target.txt" || fail "edit still present"
  pass "tier-3 subagent recovery_commands reverted external file"
fi

echo ""
echo "E2E 04 OK"
