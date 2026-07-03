#!/usr/bin/env bash
# screen launcher: postgres NAIVE arm under the full-package design —
# no experience file, gate in no-knowledge mode (CHATS_SANDBOX_NAIVE_GATE=1,
# escalate unless read-only-by-name, subagent judges no_backup_needed).
# Compare against abl11's skills arm (runtime unchanged for that arm).
: "${OPENROUTER_API_KEY:?export OPENROUTER_API_KEY first}"
cd /mnt/data2/CHATS-Sandbox
SERVERS=postgres ARMS=naive PARALLEL=4 RUN_TAG=abl12-naive-full \
  bash benchmarks/mcp_ablation/run_ablation.sh \
  > benchmarks/results/mcpabl/abl12-naive-full.log 2>&1
echo "EXIT=$?" >> benchmarks/results/mcpabl/abl12-naive-full.log
