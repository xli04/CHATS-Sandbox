#!/usr/bin/env bash
# Host the Playwright MCP for CHATS-Sandbox benchmarks in a DETACHED `screen`
# session, so it stays up independently of whoever launched it. (An agent's
# Bash sandbox SIGTERMs background processes when a tool call ends, which kept
# killing the gateway; a screen session reparents to init and is immune.)
#
# The coding agent (hermes) just connects to:
#     http://localhost:${PW_PORT}/mcp        (stateful streamable-HTTP)
#
# Usage:
#     bash start_playwright.sh          # (re)host in screen 'pw_mcp'
#     screen -r pw_mcp                  # attach to watch it
#     screen -S pw_mcp -X quit          # stop it
#
# Fixed vs the original OpenAgentSafety script (which is stale on this box):
#   port 9092 -> 9101 + streamableHttp /mcp   hermes connects to /mcp, not SSE.
#   --stateful                                browser persists across the agent's calls.
#   --isolated -> --user-data-dir /tmp/wa-pw-profile   persistent, already-LOGGED-IN
#                                             profile (--isolated is logged-OUT).
#   add --executable-path <highest chromium build>   the default 'chrome' channel
#                                             wants /opt/google/chrome/chrome (absent),
#                                             and an OLDER chromium SIGTRAPs opening a
#                                             profile made by a NEWER Chrome -> pin the
#                                             highest installed build (>= profile).
#   node v24.11.0 (gone) -> /usr/bin/node ;  /mnt/data (stale) -> /mnt/data2.
#
# Env-overridable: PW_PORT PW_PROFILE PW_NODE OAS_DIR PLAYWRIGHT_BROWSERS_PATH
#                  PW_EXEC PW_SESSION
set -uo pipefail

PORT="${PW_PORT:-9101}"
PROFILE="${PW_PROFILE:-/tmp/wa-pw-profile}"
NODE="${PW_NODE:-/usr/bin/node}"
OAS="${OAS_DIR:-/mnt/data2/OpenAgentSafety}"
MCP_CLI="$OAS/node_modules/@playwright/mcp/cli.js"
SESSION="${PW_SESSION:-pw_mcp}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/root/.cache/ms-playwright}"

# Highest installed chromium build (version-sorted) — must be >= the profile's.
EXEC="${PW_EXEC:-$(ls -d "$PLAYWRIGHT_BROWSERS_PATH"/chromium-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)}"
[ -n "$EXEC" ] && [ -x "$EXEC" ] || { echo "ERROR: no chromium under $PLAYWRIGHT_BROWSERS_PATH/chromium-*/chrome-linux64/chrome" >&2; exit 1; }

CHILD="env PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH $NODE $MCP_CLI --no-sandbox --executable-path $EXEC --user-data-dir $PROFILE"

# ── Foreground mode (run INSIDE the screen session): become supergateway ──
if [ "${1:-}" = "__serve" ]; then
  exec npx -y supergateway \
    --port "$PORT" \
    --outputTransport streamableHttp --streamableHttpPath /mcp \
    --stateful \
    --stdio "$CHILD"
fi

# ── Host mode: replace any prior session/gateway, (re)host detached in screen ──
screen -S "$SESSION" -X quit 2>/dev/null || true
pkill -9 -f "[s]upergateway --port ${PORT}" 2>/dev/null || true
sleep 1
rm -f "$PROFILE"/Singleton* 2>/dev/null || true

SELF="$(readlink -f "$0")"
screen -L -Logfile "/tmp/pw-${PORT}.log" -dmS "$SESSION" "$SELF" __serve

# Wait (<=25s) for /mcp to answer.
code=000
for _ in $(seq 1 25); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/mcp" 2>/dev/null)"
  [ "$code" != "000" ] && break
  sleep 1
done
echo "Playwright MCP hosted in screen '$SESSION' on :$PORT/mcp  (status $code)"
echo "  attach: screen -r $SESSION    stop: screen -S $SESSION -X quit    log: /tmp/pw-$PORT.log"
