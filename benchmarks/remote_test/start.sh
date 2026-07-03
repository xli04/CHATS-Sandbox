#!/usr/bin/env bash
# One-shot startup check for the reddit REMOTE test. Run this BEFORE a run to
# confirm the environment is ready and to (re)seed the scratch browser profile
# from the permanent logged-in copy.
#
#   bash remote_test/start.sh           # check + seed scratch profile if absent
#   bash remote_test/start.sh force     # also overwrite an existing scratch profile
#
# It does NOT start the run (use run_reddit10.sh / run_reddit10_inline.sh) and
# does NOT start the forum (that lives in OpenAgentSafety/servers).
set -uo pipefail
source "$(cd "$(dirname "$0")" && pwd)/env.sh"

echo "== reddit remote-test environment =="
echo "  DOCKER_HOST  = $DOCKER_HOST"
echo "  FORUM_URL    = $FORUM_URL"
echo "  PW_PROFILE   = $PW_PROFILE  (scratch, seeded from $RT_PROFILE_SRC)"
echo "  WEBARENA_EXP = $WEBARENA_EXP"

rt_seed_profile "${1:-}" && echo "  scratch profile seeded ($(du -sh "$PW_PROFILE" 2>/dev/null | cut -f1))"

if [ -f "$WEBARENA_EXP" ]; then echo "  experience   = present"; else
  echo "  experience   = MISSING (runs fall back to GENERIC guidance; run reddit self-exploration to populate)"; fi

rt_check_forum
echo "== ready (run: bash run_reddit10.sh  |  bash run_reddit10_inline.sh) =="
