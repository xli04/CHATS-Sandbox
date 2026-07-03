#!/usr/bin/env bash
# Agent adapter: Hermes. Sourced by eval.sh. Operates through the env
# primitives the dataset adapter defines (denv_exec, denv_cp, denv_workdir),
# so it works identically in a SWE container or on the local host (WebArena).
#
# Contract:
#   agent_install            — ensure `hermes` + node are runnable in the env
#   agent_invoke <prompt_file> <out_log> [extra hermes args...]
#                            — run ONE headless turn on $MODEL; logs to <out_log>
#
# Tarball caches (container installs only; local hosts already have hermes):
NODE_TAR="${NODE_TAR:-/mnt/data/chats-bench-cache/node-v24.14.1-linux-x64.tar.gz}"
HERMES_TAR="${HERMES_TAR:-/mnt/data/chats-bench-cache/hermes-src.tar.gz}"

agent_install() {
  # Already present (local host / warm container)? done.
  if denv_exec 'command -v hermes >/dev/null 2>&1 && command -v node >/dev/null 2>&1'; then
    return 0
  fi
  # Container cold install: node, then hermes from source tarball.
  denv_cp "$NODE_TAR" /opt/node.tar.gz
  denv_exec '
    set -e
    if ! command -v node >/dev/null 2>&1; then
      mkdir -p /opt/node && tar -xzf /opt/node.tar.gz -C /opt/node --strip-components=1
      ln -sf /opt/node/bin/node /usr/local/bin/node
    fi
    git config --global user.email bench@x; git config --global user.name bench
    git config --global --add safe.directory "$(pwd)"' || return 1
  denv_cp "$HERMES_TAR" /opt/hermes-src.tar.gz
  denv_exec '
    set -e
    tar -xzf /opt/hermes-src.tar.gz -C /opt
    PY=/opt/miniconda3/bin/python; [ -x "$PY" ] || PY=python3
    "$PY" -m pip install --quiet --disable-pip-version-check /opt/hermes-agent
    printf "#!/usr/bin/env bash\nexec env PYTHONPATH=/opt/hermes-agent %s -m hermes_cli.main \"\$@\"\n" "$PY" > /usr/local/bin/hermes
    chmod +x /usr/local/bin/hermes && hermes --version >/dev/null' || return 1
}

# agent_invoke <prompt_file_in_env> <out_log_in_env> [extra args...]
# TOOLSETS (optional, exported by the dataset) restricts the agent's tools —
# e.g. WebArena needs "terminal,file,mcp-playwright" to force the MCP browser.
agent_invoke() {
  local prompt="$1" outlog="$2"; shift 2
  local ts_arg=""; [ -n "${AGENT_TOOLSETS:-}" ] && ts_arg="--toolsets ${AGENT_TOOLSETS}"
  denv_exec "cd $(denv_workdir) && timeout ${TIMEOUT} hermes chat $ts_arg -q \"\$(cat $prompt)\" \
    -m $MODEL --provider openrouter -Q --yolo $* > $outlog 2>&1" || true
}
