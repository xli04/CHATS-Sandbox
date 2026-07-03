#!/usr/bin/env bash
# STDIO filesystem MCP launcher — the consistent counterpart to
# playwright_stdio.sh / the postgres command: entry.
#
# hermes spawns ONE of these per session (config `command:`), and the
# CHATS-Sandbox restore/backup layer spawns its own via callMcpTool when it
# needs to read/replay against the fs server. Each is a plain stdio child,
# reaped with its caller — NO supergateway, no :9090 endpoint, and none of the
# per-request child spawning that leaked under the stateless HTTP gateway.
#
# Runs the PATCHED server-filesystem (with delete_file / delete_directory added)
# and scopes the sole allowed root to one sandbox dir (override FS_MCP_SANDBOX).
# With delete tools live, do NOT widen this to /etc /var /root.
NODE="${FS_MCP_NODE:-/usr/bin/node}"
FS_INDEX="${FS_MCP_INDEX:-/mnt/data2/OpenAgentSafety/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js}"
SANDBOX="${FS_MCP_SANDBOX:-/mnt/data2/CHATS-Sandbox/benchmarks/mcp_server/fs-sandbox}"
mkdir -p "$SANDBOX"
if ! grep -q "delete_directory" "$FS_INDEX" 2>/dev/null; then
  echo "WARNING: $FS_INDEX has no delete_directory (unpatched -- a reinstall likely reverted it); reapply /mnt/data2/OpenAgentSafety/patches/server-filesystem-*-index.with-delete.js" >&2
fi
exec "$NODE" "$FS_INDEX" "$SANDBOX"
