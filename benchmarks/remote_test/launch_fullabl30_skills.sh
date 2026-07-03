#!/usr/bin/env bash
# screen launcher: SKILLS arm, samples s01-s30, current runtime + fixed staging.
: "${OPENROUTER_API_KEY:?export OPENROUTER_API_KEY first}"
cd /mnt/data2/CHATS-Sandbox/benchmarks
RUN_TAG=fullabl30 ARMS=skills WA_SAMPLES=30 WA_SAMPLE_START=0 \
  bash remote_test/run_qwen_ablation.sh \
  > results/webarena/fullabl30-skills.log 2>&1
echo "EXIT=$?" >> results/webarena/fullabl30-skills.log
