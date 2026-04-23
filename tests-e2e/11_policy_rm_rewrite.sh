#!/usr/bin/env bash
# E2E 11 — tier-0 policy rewrite for `rm`.
# Claude is asked to delete a file; the plugin should rewrite rm into a
# move-to-trash, file content should still exist in the action's trash/,
# and `restore 1` should bring it back to the original location.
set -u
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

CLI="$(cd "$(dirname "$0")" && pwd)/../dist/cli.js"
PROJ="/tmp/chats-e2e-11"
rm -rf "$PROJ"
mkdir -p "$PROJ"
cd "$PROJ" || exit 1

# Seed a large-ish file so any tier-2 copy would be noticeable.
# We don't actually check size here, but this keeps the scenario honest.
head -c 512000 /dev/urandom > big_file.bin
echo "sentinel_content" > small_file.txt
ORIG_SHA=$(sha256sum big_file.bin | awk '{print $1}')

node "$CLI" install > /tmp/e2e-11-install.log 2>&1 || fail "install failed"
git init -q && git add -A && git -c user.email=e2e -c user.name=e2e commit -qm "init" >/dev/null 2>&1

echo "--- Asking Claude to rm small_file.txt ---"
claude -p "Use the Bash tool to run: rm small_file.txt. Do not do anything else." \
  --output-format json --no-session-persistence --dangerously-skip-permissions --model haiku > /tmp/e2e-11-claude.json 2>&1
EC=$?
[ $EC -eq 0 ] || fail "claude -p failed"

# From the user's perspective, small_file.txt is gone
[ ! -f small_file.txt ] || fail "small_file.txt still at original path (rewrite didn't happen)"
pass "small_file.txt no longer at original path (as if rm ran)"

# But the action folder should have a policy_rewrite artifact with trash/
ACTION=$(ls .chats-sandbox/backups | grep '^action_001_' | head -1)
[ -n "$ACTION" ] || fail "no action folder"
META=".chats-sandbox/backups/$ACTION/metadata.json"
grep -q '"strategy": "policy_rewrite"' "$META" || fail "expected policy_rewrite strategy, metadata: $(cat $META)"
pass "policy_rewrite strategy recorded"

grep -q '"policyRuleId": "rm-to-trash"' "$META" || fail "policyRuleId not recorded"
pass "policyRuleId: rm-to-trash"

# Trash should contain the file (renamed)
TRASH=".chats-sandbox/backups/$ACTION/trash"
[ -d "$TRASH" ] || fail "trash dir missing"
N_TRASHED=$(ls "$TRASH" | wc -l)
[ "$N_TRASHED" -ge 1 ] || fail "trash is empty — file not preserved"
pass "trash contains $N_TRASHED item(s)"

# The trashed file's content must equal the original (verify we didn't
# copy — we renamed. Both paths should have identical content if we did
# this right, but the original path is gone, so just verify trash).
TRASHED_CONTENT=$(cat "$TRASH"/*)
[ "$TRASHED_CONTENT" = "sentinel_content" ] || fail "trashed content mismatch: $TRASHED_CONTENT"
pass "trashed content matches original"

# Recovery commands must be present
RECOVERY_N=$(python3 -c "import json; m=json.load(open('$META')); print(len(m[0].get('recoveryCommands',[])))")
[ "$RECOVERY_N" -ge 1 ] || fail "no recoveryCommands recorded"
pass "$RECOVERY_N recovery command(s) recorded"

# ── Restore ──
echo "--- Restoring to action 1 ---"
node "$CLI" restore_direct 1 > /tmp/e2e-11-restore.log 2>&1 || fail "restore failed"

[ -f small_file.txt ] || fail "restore didn't bring small_file.txt back"
RESTORED=$(cat small_file.txt)
[ "$RESTORED" = "sentinel_content" ] || fail "restored content wrong: $RESTORED"
pass "restored file is back at original path with original content"

# big_file.bin was never rm'd, so it should still be there untouched
[ -f big_file.bin ] || fail "big_file.bin disappeared (shouldn't have)"
NEW_SHA=$(sha256sum big_file.bin | awk '{print $1}')
[ "$NEW_SHA" = "$ORIG_SHA" ] || fail "big_file.bin content changed (expected untouched)"
pass "untouched files untouched across the round-trip"

echo ""
echo "E2E 11 OK"
