#!/usr/bin/env bash
# STDIO Playwright MCP launcher — hermes spawns ONE of these per task (config
# `command:`), talks JSON-RPC over stdio, and the browser dies with the task.
# Avoids the shared-gateway problems: no persistent :9101 to keep alive, and no
# cross-task session collision (each task gets its own browser; the adapter's
# pre-task pkill clears the profile lock between tasks).
#
# Uses the persistent LOGGED-IN profile /tmp/wa-pw-profile and pins the highest
# installed chromium build (>= the profile's Chrome version; an older build
# SIGTRAPs opening a newer profile). NO --browser flag (that would set
# channel="chromium" and make playwright-core ignore --executable-path).
PROFILE="${PW_PROFILE:-/tmp/wa-pw-profile}"
NODE="${PW_NODE:-/usr/bin/node}"
MCP_CLI="${PW_MCP_CLI:-/mnt/data2/OpenAgentSafety/node_modules/@playwright/mcp/cli.js}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/root/.cache/ms-playwright}"
EXEC="${PW_EXEC:-$(ls -d "$PLAYWRIGHT_BROWSERS_PATH"/chromium-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)}"

exec "$NODE" "$MCP_CLI" --no-sandbox --executable-path "$EXEC" --user-data-dir "$PROFILE"
