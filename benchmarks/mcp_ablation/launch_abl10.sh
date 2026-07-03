#!/usr/bin/env bash
# screen launcher for the full 40-run ablation (10 pg + 10 fs, skills+naive).
# Runs inside `screen -dmS mcpabl`; log tails to results/mcpabl/abl10.log
: "${OPENROUTER_API_KEY:?export OPENROUTER_API_KEY first}"
cd /mnt/data2/CHATS-Sandbox
RUN_TAG=abl10 bash benchmarks/mcp_ablation/run_ablation.sh \
  > benchmarks/results/mcpabl/abl10.log 2>&1
echo "EXIT=$?" >> benchmarks/results/mcpabl/abl10.log
