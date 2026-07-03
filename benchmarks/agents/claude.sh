#!/usr/bin/env bash
# Agent adapter: Claude Code. Operates through the dataset's env primitives
# (denv_exec/denv_cp/denv_workdir) like the hermes adapter.
#
#   agent_install            — ensure node + `claude` are runnable in the env
#   agent_invoke <prompt_file> <out_log> [extra claude args...]
#
# Plugin install target differs from the adapter name (the plugin knows this
# runner as "claude-code"); conditions/plugin.sh reads $AGENT_PLUGIN_TARGET.
AGENT_PLUGIN_TARGET="claude-code"
AGENT_SUBAGENT_RUNNER="claude"
NODE_TAR="${NODE_TAR:-/mnt/data/chats-bench-cache/node-v24.14.1-linux-x64.tar.gz}"

agent_install() {
  if denv_exec 'command -v claude >/dev/null 2>&1'; then return 0; fi
  denv_cp "$NODE_TAR" /opt/node.tar.gz
  denv_exec '
    set -e
    if ! command -v node >/dev/null 2>&1; then
      mkdir -p /opt/node && tar -xzf /opt/node.tar.gz -C /opt/node --strip-components=1
      ln -sf /opt/node/bin/node /usr/local/bin/node; ln -sf /opt/node/bin/npm /usr/local/bin/npm
    fi
    git config --global user.email bench@x; git config --global user.name bench
    git config --global --add safe.directory "$(pwd)"
    npm install -g @anthropic-ai/claude-code --silent
    command -v claude >/dev/null' || return 1
}

# agent_invoke <prompt_file_in_env> <out_log_in_env> [extra args...]
# Claude reads ANTHROPIC_API_KEY (or the gateway key) from the env. --print/-p
# is the headless one-shot turn; permissions bypassed for the sandboxed bench.
agent_invoke() {
  local prompt="$1" outlog="$2"; shift 2
  denv_exec "cd $(denv_workdir) && timeout ${TIMEOUT} claude -p \"\$(cat $prompt)\" \
    --model $MODEL --dangerously-skip-permissions $* > $outlog 2>&1" || true
}
