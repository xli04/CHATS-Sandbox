#!/usr/bin/env bash
set -u
cd /mnt/data/CHATS-Sandbox/benchmarks
while pgrep -f "sweep-multi.sh tasks-medium" >/dev/null 2>&1; do sleep 60; done
MED='^(pytorch-model-recovery|gcode-to-text|optimal-transport|multi-source-data-merger|decommissioning-service-with-sensitive-data),'
for a in claude hermes openhands; do
  # drop plugin rows for medium tasks (incl. claude's broken pytorch rows)
  grep -vE "${MED}${a},plugin," "results/multi-$a.csv" > "results/multi-$a.csv.tmp" 2>/dev/null \
    && grep -vE "$MED.*,plugin," "results/multi-$a.csv.tmp" > "results/multi-$a.csv" && rm -f "results/multi-$a.csv.tmp"
done
for agent in claude hermes openhands; do
  nohup env OPENROUTER_API_KEY="$OPENROUTER_API_KEY" bash sweep-multi.sh tasks-medium.txt "results/multi-$agent.csv" "$agent" >> "/tmp/sweep-$agent-medium.log" 2>&1 &
done
sleep 5
while pgrep -f "sweep-multi.sh tasks-medium" >/dev/null 2>&1; do sleep 60; done
python3 aggregate.py tasks-medium.txt > results/summary-medium.txt 2>&1
python3 aggregate.py > results/summary-final.txt 2>&1
echo "NET RERUN DONE $(date -u +%H:%M)" >> /tmp/supervise.log
