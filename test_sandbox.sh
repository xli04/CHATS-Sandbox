#!/usr/bin/env bash
# CHATS-Sandbox demo — provisions `test/test1` (workspace) and `test/test2`
# (external target), installs the plugin in test1, and has `claude -p` run
# 10 mixed in-workspace / out-of-workspace operations designed to exercise
# every backup tier:
#
#   tier-0 policy rewrite:  the rm's and the chmod
#   tier-2 git_snapshot:    the Edits and Writes inside test1
#   tier-3 subagent:        the Edits and Writes inside test2 (local files
#                           outside the workspace) and the optional remote
#                           MCP tasks below
#
# Optionally exercises tier-3 for MCP-driven REMOTE state when invoked with
# `--with-remote` (or `MOCK_FORUM_URL=http://host:port`). That section uses
# the Playwright MCP server to log into a forum, create a post, then delete
# it — each MCP write fires the tier-3 subagent which scrapes pre-state
# into remote-state.json. See benchmarks/mock-forum/ for a zero-dep target.
#
# After the demo, inspect with:
#   chats-sandbox history 10          (from test1)
#   chats-sandbox dashboard           (then open http://127.0.0.1:7321)
#   chats-sandbox restore_direct 5    (jump to state before action 5)
#
# The dashboard now shows:
#   - "01 Timeline" — a vertical git-log-style strip of all actions;
#     click any node to jump and expand the matching row below.
#   - Concise/Detail toggle on the Actions list (top-right).
#   - For MCP-write actions: a Subagent Capture section with the
#     recovery plan, plus the full scraped remote-state JSON.
#
# Requirements: `claude` CLI authenticated on PATH, `node`, and the
# `chats-sandbox` CLI on PATH (or override CHATS_SANDBOX_CLI below).
# The `--with-remote` mode additionally requires Playwright MCP
# registered with claude (e.g. via `claude mcp add playwright …`)
# and a target URL (defaults to http://localhost:18080 — what
# `benchmarks/mock-forum/docker compose up` listens on).
#
# If test/ already exists, it is REMOVED and recreated. No silent merge.

set -u

# ── Config ────────────────────────────────────────────────────────────

# Defaults.
WITH_REMOTE=0
MOCK_FORUM_URL="${MOCK_FORUM_URL:-http://localhost:18080}"
FORUM_USER="${FORUM_USER:-MarvelsGrantMan136}"
FORUM_PASS="${FORUM_PASS:-test1234}"
ROOT_ARG=""

# Parse args. Anything that isn't a flag is treated as the parent dir.
while [ $# -gt 0 ]; do
  case "$1" in
    --with-remote) WITH_REMOTE=1; shift ;;
    --help|-h)
      sed -n '2,/^set -u$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) ROOT_ARG="$1"; shift ;;
  esac
done
# If MOCK_FORUM_URL was set explicitly, treat that as opting in too.
if [ -n "${MOCK_FORUM_URL_EXPLICIT:-}" ] || [ "$WITH_REMOTE" = "1" ]; then
  WITH_REMOTE=1
fi

ROOT="${ROOT_ARG:-$(pwd)}"
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
skip() { printf '  \033[2m·\033[0m %s\n' "$*"; }

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
if [ "$WITH_REMOTE" = "1" ]; then
  dim  "Remote MCP section enabled — target: $MOCK_FORUM_URL"
fi

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
# `install` defaults to claude-code; pass `install hermes` for a Hermes
# project, `install <other>` once more adapters land.
"$CHATS_SANDBOX_CLI" install > /tmp/chats-demo-install.log 2>&1
if [ $? -eq 0 ]; then
  ok "hooks wired (claude-code adapter), deny rules added, slash commands copied"
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

# ── Run 10 claude -p calls (in-process tiers 0/2/3) ───────────────────

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
    --model haiku > "/tmp/chats-demo-$label.json" 2>&1 < /dev/null
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

# 4 — OUT of workspace, Edit existing (tier-3 subagent — local-file branch
#     of Category A: snapshots test2 via external-shadow git repo before the
#     edit).
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

# ── Optional: tier-3 for MCP-driven REMOTE state ─────────────────────
#
# Each Playwright MCP write tool (browser_click, browser_fill_form, etc.)
# fires the tier-3 subagent which uses the same Playwright session to
# scrape pre-state into remote-state.json and record a recovery plan as
# natural-language MCP steps. Read-only verbs (browser_navigate,
# browser_snapshot) short-circuit — no noise actions.
#
# Inspect via dashboard: each remote action's expanded row shows a
# "Subagent Capture" section with the recovery plan + the captured JSON.

if [ "$WITH_REMOTE" = "1" ]; then
  step "Remote MCP tasks — tier-3 subagent on remote state"

  # Probe the forum first so we fail fast with a clear message.
  if ! curl -fsS -o /dev/null -m 4 "$MOCK_FORUM_URL/" 2>/dev/null; then
    warn "Cannot reach $MOCK_FORUM_URL — skipping remote section."
    warn "Start the mock forum with: (cd benchmarks/mock-forum && docker compose up -d)"
    skip "Or set MOCK_FORUM_URL to your own target."
  else
    ok "forum reachable at $MOCK_FORUM_URL"

    call_remote_claude() {
      local label="$1"; shift
      local prompt="$*"
      printf "  %-24s " "$label"
      local start=$(date +%s)
      # Sonnet is much more reliable at multi-step browser flows than haiku.
      claude -p "$prompt" \
        --output-format json \
        --no-session-persistence \
        --dangerously-skip-permissions \
        --allowedTools "mcp__playwright" \
        --model sonnet > "/tmp/chats-demo-$label.json" 2>&1 < /dev/null
      local ec=$?
      local elapsed=$(($(date +%s) - start))
      if [ $ec -eq 0 ]; then
        printf "\033[32m✓\033[0m  %ss\n" "$elapsed"
      else
        printf "\033[31m✗\033[0m  exit=%s\n" "$ec"
      fi
    }

    # 11 — Remote login + post-create + post-delete in one task. Each MCP
    #      write (browser_fill_form, browser_click) creates its own action
    #      folder with strategy=subagent + a remote-state.json scraped via
    #      the same MCP. End-to-end coverage of tier-3 Category F.
    call_remote_claude "11-remote-cycle" \
      "Use the Playwright MCP. In order:
       1. Navigate to $MOCK_FORUM_URL/login and log in as $FORUM_USER / $FORUM_PASS.
       2. Navigate to $MOCK_FORUM_URL/submit and create a text post in forum 'test' with title 'demo-remote' body 'sandbox demo'.
       3. Navigate to $MOCK_FORUM_URL/user/$FORUM_USER/submissions, open the 'demo-remote' post, and click delete.
       Report just 'DONE'."
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────

step "Demo state"
ACTIONS=$(ls .chats-sandbox/backups 2>/dev/null | grep -c '^action_')
printf "  %s action folder(s) recorded\n" "$ACTIONS"
dim  "  (some actions may have been merged — e.g. read-only or failed calls don't materialize a folder)"

# Show how many of those used each tier, just for orientation.
if [ "$ACTIONS" -gt 0 ]; then
  python3 - <<PY 2>/dev/null || true
import json, os, glob, collections
backups = ".chats-sandbox/backups"
counts = collections.Counter()
for d in sorted(glob.glob(os.path.join(backups, "action_*"))):
    meta = os.path.join(d, "metadata.json")
    if not os.path.exists(meta): continue
    try:
        for a in json.load(open(meta)): counts[a.get("strategy","?")] += 1
    except: pass
if counts:
    print("  strategy mix:", ", ".join(f"{n}× {s}" for s, n in counts.most_common()))
PY
fi

printf "\n"
bold "Next steps"
cat <<NEXT

  Inspect the history from CLI:
    cd $WORKSPACE
    $CHATS_SANDBOX_CLI history 10

  Open the dashboard:
    $CHATS_SANDBOX_CLI dashboard
    # then open http://127.0.0.1:7321
    #
    # New: section "01 Timeline" — vertical git-log-style strip. Click
    #      any node to jump to and expand the matching row in the
    #      Actions list below.
    # New: Concise / Detail toggle on the Actions list (top-right of
    #      that section). Detail mode shows files, stats, subagent
    #      capture summary, and age inline for every row at once.
    # New: For MCP-write actions, the expanded detail panel now
    #      includes a "Subagent Capture" block with the recovery
    #      plan + the scraped remote-state JSON.

  Try a restore — jump back to state before action 5:
    $CHATS_SANDBOX_CLI restore_direct 5
    # hello.py gone (a01 made it), src/utils.py also gone (a05 made it),
    # external settings.json back to version 1.0, external types.d.ts removed.

  Or reverse-loop restore (undoes one action at a time):
    $CHATS_SANDBOX_CLI restore 3

  Multi-agent: this demo wires Claude Code. For Hermes, run
  '$CHATS_SANDBOX_CLI install hermes' in a Hermes project — same
  backup tiers, same dashboard.

  Clean up when done:
    rm -rf $TEST_DIR

NEXT
