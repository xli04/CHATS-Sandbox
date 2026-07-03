#!/usr/bin/env bash
# screen launcher: postgres naive-arm rerun under the injection-only design
# (experience file present, CHATS_SANDBOX_NO_EXP_INJECT=1 for the subagent
# prompt), per-run DB/home/TMPDIR isolation, 4-way parallel.
: "${OPENROUTER_API_KEY:?export OPENROUTER_API_KEY first}"
cd /mnt/data2/CHATS-Sandbox
SERVERS=postgres ARMS=naive PARALLEL=4 RUN_TAG=abl10-naive-inj \
  bash benchmarks/mcp_ablation/run_ablation.sh \
  > benchmarks/results/mcpabl/abl10-naive-inj.log 2>&1
echo "EXIT=$?" >> benchmarks/results/mcpabl/abl10-naive-inj.log
