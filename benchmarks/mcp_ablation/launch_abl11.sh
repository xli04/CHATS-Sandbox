#!/usr/bin/env bash
# screen launcher: clean postgres ablation, BOTH arms, fixed runtime
# (whole-word triggers + unambiguous matchPattern + injection-only naive arm).
: "${OPENROUTER_API_KEY:?export OPENROUTER_API_KEY first}"
cd /mnt/data2/CHATS-Sandbox
SERVERS=postgres ARMS="skills naive" PARALLEL=4 RUN_TAG=abl11 \
  bash benchmarks/mcp_ablation/run_ablation.sh \
  > benchmarks/results/mcpabl/abl11.log 2>&1
echo "EXIT=$?" >> benchmarks/results/mcpabl/abl11.log
