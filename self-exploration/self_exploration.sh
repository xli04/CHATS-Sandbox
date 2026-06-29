#!/usr/bin/env bash
# Starting script for CHATS-Sandbox self-exploration (mirrors ToolShield's run.sh).
#
# A STANDALONE, offline pipeline: (1) a model PROPOSES the cheapest easy-win
# reversal for each destructive MCP op, (2) a live agent EXECUTES each against
# the real MCP backend to verify. It is NOT the runtime backup path and does
# NOT read .chats-sandbox/config.json — the runner/model/tools come from the
# args below.
#
# Args (positional or env):
#   tools / server  — which MCP server to explore (must exist in ~/.hermes/config.yaml)
#   agent           — coding agent / runner: hermes | claude | codex | openclaw  (default: hermes)
#   model           — ONE model used for BOTH stages                              (default: deepseek/deepseek-v4-pro)
#   provider        — model provider                                             (default: openrouter)
#
# NOTE: stage-2 (verify) needs live MCP tools, which today is wired only for
# `hermes`; other agents are rejected by the CLI. Live tool discovery reads the
# named server from ~/.hermes/config.yaml regardless of agent.
#
#   ./self_exploration.sh postgres
#   AGENT=hermes MODEL=deepseek/deepseek-v4-pro ./self_exploration.sh postgres
#   TOOLS=postgres ./self_exploration.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CLI="$REPO/dist/cli.js"

# ── Args (override via env or $1) ─────────────────────────────────────
TOOLS="${TOOLS:-${1:-}}"                       # which MCP server/tools to explore
AGENT="${AGENT:-hermes}"                        # coding agent / runner
MODEL="${MODEL:-deepseek/deepseek-v4-pro}"      # single model for both stages
PROVIDER="${PROVIDER:-openrouter}"
: "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY (export it before running)}"

if [[ -z "$TOOLS" ]]; then
  echo "usage: ./self_exploration.sh <server>   (or TOOLS=<server> ./self_exploration.sh)" >&2
  echo "       <server> must be defined in ~/.hermes/config.yaml under mcp_servers" >&2
  exit 1
fi
if [[ ! -f "$CLI" ]]; then
  echo "error: $CLI not found — run 'npm run build' in $REPO first." >&2
  exit 1
fi

# Archive copies of results here (explore.ts honors this env var).
export CHATS_SELF_EXPLORATION_RESULTS="$HERE/results"
mkdir -p "$CHATS_SELF_EXPLORATION_RESULTS"

LOG="$CHATS_SELF_EXPLORATION_RESULTS/${TOOLS}-explore.log"
echo "Self-exploration → tools='$TOOLS' agent='$AGENT' model='$MODEL' provider='$PROVIDER'"
echo "Results: $CHATS_SELF_EXPLORATION_RESULTS    Log: $LOG"

nohup node "$CLI" explore "$TOOLS" \
  --agent "$AGENT" \
  --model "$MODEL" \
  --provider "$PROVIDER" \
  > "$LOG" 2>&1 &

echo "PID: $!"
echo "Follow: tail -f $LOG"
