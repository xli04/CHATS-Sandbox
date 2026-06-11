#!/usr/bin/env bash
# Launch the medium-task lanes, wait precisely on them, write the summary.
set -u
cd /mnt/data/CHATS-Sandbox/benchmarks
for agent in claude hermes openhands; do
  nohup env OPENROUTER_API_KEY="$OPENROUTER_API_KEY" bash sweep-multi.sh tasks-medium.txt "results/multi-$agent.csv" "$agent" >> "/tmp/sweep-$agent-medium.log" 2>&1 &
done
sleep 5
# Pattern matches only real lanes (monitors never quote "tasks-medium").
while pgrep -f "sweep-multi.sh tasks-medium" >/dev/null 2>&1; do sleep 60; done
python3 aggregate.py tasks-medium.txt > results/summary-medium.txt 2>&1
echo "MEDIUM SWEEP DONE $(date -u +%H:%M)" >> /tmp/supervise.log
