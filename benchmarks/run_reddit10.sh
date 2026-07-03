#!/usr/bin/env bash
# One-shot: start the Playwright MCP, then run the 10-sample reddit plugin
# benchmark (subagent-backup token capture).
#
# RUN THIS IN A PERSISTENT TERMINAL (your shell), NOT through an agent tool —
# the agent's Bash sandbox SIGTERMs background processes when each call ends,
# which kills the long-lived MCP gateway and the run. Your shell doesn't.
#
#   OPENROUTER_API_KEY=sk-or-... bash /mnt/data2/CHATS-Sandbox/benchmarks/run_reddit10.sh
set -uo pipefail
cd "$(dirname "$0")"

export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:?export OPENROUTER_API_KEY first}"
export PATH="/root/micromamba/envs/chats_sandbox/bin:$PATH"
# Permanent remote-test env (DOCKER_HOST, FORUM_URL, profile, experience) +
# re-seed the scratch browser profile from the permanent logged-in copy.
source "$(dirname "$0")/remote_test/env.sh"
rt_seed_profile; rt_check_forum || exit 1
export WA_TASKS="${WA_TASKS:-reddit-create-post reddit-change-bio reddit-upvote-newest reddit-delete-submission}"
export WA_SAMPLES="${WA_SAMPLES:-10}"
export HERMES_DUMP_REQUESTS=1 CHATS_KEEP_SUBAGENT_HOME=1

# STDIO mode: each task spawns its OWN playwright browser via hermes config
# `command: …/playwright_stdio.sh`. No shared :9101 gateway to host or check.
echo "[run] stdio playwright (per-task browser); no shared gateway needed"

# Run the benchmark in the FOREGROUND (stays attached to this shell).
rm -rf results/webarena/reddit10-repro
./eval.sh --dataset webarena --condition plugin --concurrency 1 --run reddit10-repro --timeout 900
echo "[run] DONE -> results/webarena/reddit10-repro/ALL.csv"
