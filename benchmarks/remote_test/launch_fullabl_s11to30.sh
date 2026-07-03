#!/usr/bin/env bash
# screen launcher: naive arm, samples s11-s30 (extends fullabl10-naive to n=30).
: "${OPENROUTER_API_KEY:?export OPENROUTER_API_KEY first}"
cd /mnt/data2/CHATS-Sandbox/benchmarks
RUN_TAG=fullabl_s11to30 ARMS=naive WA_SAMPLES=20 WA_SAMPLE_START=10 \
  bash remote_test/run_qwen_ablation.sh \
  > results/webarena/fullabl_s11to30.log 2>&1
echo "EXIT=$?" >> results/webarena/fullabl_s11to30.log
