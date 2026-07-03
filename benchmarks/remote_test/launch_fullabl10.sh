#!/usr/bin/env bash
# screen launcher: reddit ablation, NAIVE arm only (no experience +
# CHATS_SANDBOX_NAIVE_GATE=1 no-knowledge gate; subagent judges no_backup_needed).
: "${OPENROUTER_API_KEY:?export OPENROUTER_API_KEY first}"
cd /mnt/data2/CHATS-Sandbox/benchmarks
RUN_TAG=fullabl10 ARMS=naive bash remote_test/run_qwen_ablation.sh \
  > results/webarena/fullabl10.log 2>&1
echo "EXIT=$?" >> results/webarena/fullabl10.log
