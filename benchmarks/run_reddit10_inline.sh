#!/usr/bin/env bash
# Same 10 reddit tasks, but the INLINE main-agent-backup condition (the baseline:
# the main agent records reversals inline via the backup-guidance prefix; no
# tier-3 subagent). For comparing inline backup cost vs the subagent backup.
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
echo "[run] stdio playwright (per-task browser); INLINE main_agent_backup condition"
rm -rf results/webarena/reddit10-inline
./eval.sh --dataset webarena --condition main_agent_backup --concurrency 1 --run reddit10-inline --timeout 900
echo "[run] DONE -> results/webarena/reddit10-inline/ALL.csv"
