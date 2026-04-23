#!/usr/bin/env bash
# CHATS-Sandbox demo — provisions `test/test1` (workspace) and `test/test2`
# (external target), installs the plugin in test1, and has `claude -p` run
# 10 mixed in-workspace / out-of-workspace operations designed to exercise
# every backup tier:
#
#   tier-0 policy rewrite:  the rm's and the chmod
#   tier-2 git_snapshot:    the Edits and Writes inside test1
#   tier-3 subagent:        the Edits and Writes inside test2
#
# After the demo, inspect with:
#   chats-sandbox history 10          (from test1)
#   chats-sandbox dashboard            (then open http://127.0.0.1:7321)
#   chats-sandbox restore_direct 5     (jump to state before action 5)
#
# Requirements: `claude` CLI authenticated on PATH, `node`, and the
# `chats-sandbox` CLI on PATH (or override CHATS_SANDBOX_CLI below).
#
# If test/ already exists, it is REMOVED and recreated. No silent merge.

set -u

# ── Config ────────────────────────────────────────────────────────────

# Parent directory for test/. Defaults to cwd. Override with arg 1.
ROOT="${1:-$(pwd)}"
TEST_DIR="$ROOT/test"
WORKSPACE="$TEST_DIR/test1"
EXTERNAL="$TEST_DIR/test2"

# Let the user override the CLI entrypoint (handy when working on the plugin).
CHATS_SANDBOX_CLI="${CHATS_SANDBOX_CLI:-chats-sandbox}"

# ── Pretty-print helpers ──────────────────────────────────────────────

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
step() { printf '\n\033[36m── %s ──\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

# ── Sanity checks ─────────────────────────────────────────────────────

if ! command -v claude >/dev/null 2>&1; then
  echo "FATAL: \`claude\` not on PATH. Install Claude Code first."
  exit 1
fi
if ! command -v "$CHATS_SANDBOX_CLI" >/dev/null 2>&1; then
  echo "FATAL: \`$CHATS_SANDBOX_CLI\` not on PATH."
  echo "       Override with CHATS_SANDBOX_CLI=/path/to/cli.js or install the plugin globally."
  exit 1
fi

# ── Reset the scaffold ────────────────────────────────────────────────

bold "CHATS-Sandbox demo"
dim  "Working under $TEST_DIR"

if [ -e "$TEST_DIR" ]; then
  step "Removing existing $TEST_DIR"
  rm -rf "$TEST_DIR"
  ok "cleared"
fi

step "Creating scaffold"
mkdir -p "$WORKSPACE" "$EXTERNAL"
ok "test/test1/  (workspace)"
ok "test/test2/  (external target)"

# Seed both dirs with initial files so Edits have something to edit.
cat > "$WORKSPACE/README.md" <<'EOF'
# Test 1
Initial workspace file.
EOF

cat > "$EXTERNAL/settings.json" <<'EOF'
{"debug": false, "version": "1.0"}
EOF
ok "seeded README.md (workspace) and settings.json (external)"

# ── Install plugin ────────────────────────────────────────────────────

step "Installing CHATS-Sandbox in test1"
cd "$WORKSPACE" || exit 1
"$CHATS_SANDBOX_CLI" install > /tmp/chats-demo-install.log 2>&1
if [ $? -eq 0 ]; then
  ok "hooks wired, deny rules added, slash commands copied"
else
  warn "install failed (see /tmp/chats-demo-install.log)"
  exit 1
fi

# Initialize git so tier-2 git_snapshot has something to baseline against.
git init -q
git -c user.email=demo@local -c user.name=demo config --local commit.gpgsign false
git add -A
git -c user.email=demo@local -c user.name=demo commit -qm "demo: seed" >/dev/null 2>&1
ok "git initialized with seed commit"

# ── Run 10 claude -p calls ────────────────────────────────────────────

step "Running 10 actions (this takes ~2-4 minutes)"

call_claude() {
  local label="$1"; shift
  local prompt="$*"
  printf "  %-24s " "$label"
  local start=$(date +%s)
  claude -p "$prompt" \
    --output-format json \
    --no-session-persistence \
    --dangerously-skip-permissions \
    --model haiku > "/tmp/chats-demo-$label.json" 2>&1
  local ec=$?
  local elapsed=$(($(date +%s) - start))
  if [ $ec -eq 0 ]; then
    printf "\033[32m✓\033[0m  %ss\n" "$elapsed"
  else
    printf "\033[31m✗\033[0m  exit=%s\n" "$ec"
  fi
}

# 1 — IN workspace, Write a new file (tier-2 git_snapshot baseline captures
#     the pre-state of everything we haven't touched yet).
call_claude "01-write-in" \
  "Use the Write tool to create hello.py in the current directory with this exact content: 'def greet():\n    return \"hi\"\n'"

# 2 — IN workspace, Edit (tier-2 delta).
call_claude "02-edit-in" \
  "Use the Edit tool to change 'def greet():\n    return \"hi\"\n' in hello.py to 'def greet(name):\n    return f\"hi {name}\"\n'"

# 3 — OUT of workspace, Write NEW file. Tier-0 shortcuts (no data to preserve,
#     recovery = rm). Cheaper than spawning a subagent for a pure create.
call_claude "03-write-out-new" \
  "Use the Write tool to create the file at $EXTERNAL/types.d.ts with this content: 'export type Config = { debug: boolean; version: string };\n'"

# 4 — OUT of workspace, Edit existing (tier-3 subagent: snapshots test2 via
#     external-shadow git repo before the edit).
call_claude "04-edit-out" \
  "Use the Edit tool to change '\"version\": \"1.0\"' in $EXTERNAL/settings.json to '\"version\": \"2.0\"'"

# 5 — IN workspace, Write nested (tier-2).
call_claude "05-write-nested" \
  "Use the Write tool to create src/utils.py with the content: 'def slug(s):\n    return s.lower().replace(\" \", \"-\")\n'"

# 6 — IN workspace, rm — **tier-0 policy rewrite**. File is moved to
#     .chats-sandbox/backups/action_006_*/trash/ instead of deleted.
call_claude "06-rm-in" \
  "Use the Bash tool to run: rm hello.py"

# 7 — IN workspace, chmod — tier-0 policy rule (record old mode, recover via chmod).
call_claude "07-chmod" \
  "Use the Bash tool to run: chmod 755 src/utils.py"

# 8 — IN workspace, second Edit (tier-2).
call_claude "08-edit-in" \
  "Use the Edit tool to change 'def slug' in src/utils.py to 'def slugify'"

# 9 — OUT of workspace, rm — tier-0 rule. Same FS assumed; moves to trash in
#     the action folder.
call_claude "09-rm-out" \
  "Use the Bash tool to run: rm $EXTERNAL/settings.json"

# 10 — IN workspace, final Edit.
call_claude "10-edit-readme" \
  "Use the Edit tool to change 'Initial workspace file.' in README.md to 'Demo complete.'"

# ── Summary ──────────────────────────────────────────────────────────

step "Demo state"
ACTIONS=$(ls .chats-sandbox/backups 2>/dev/null | grep -c '^action_')
printf "  %s action folder(s) recorded\n" "$ACTIONS"
dim  "  (some actions may have been merged — e.g. read-only or failed calls don't materialize a folder)"

printf "\n"
bold "Next steps"
cat <<NEXT

  Inspect the history from CLI:
    cd $WORKSPACE
    $CHATS_SANDBOX_CLI history 10

  Open the dashboard (default Concise view):
    $CHATS_SANDBOX_CLI dashboard
    # then open http://127.0.0.1:7321

  Try a restore — jump back to state before action 5:
    $CHATS_SANDBOX_CLI restore_direct 5
    # hello.py gone (it was created by a01), src/utils.py also gone (a05 made it),
    # external settings.json back to version 1.0, external types.d.ts removed.

  Or reverse-loop restore (undoes one action at a time):
    $CHATS_SANDBOX_CLI restore 3

  Clean up when done:
    rm -rf $TEST_DIR

NEXT
