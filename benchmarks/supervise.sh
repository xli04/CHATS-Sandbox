#!/usr/bin/env bash
# Waits for running lanes, then relaunches passes until every
# task×agent×condition row exists, then writes the final summary.
set -u
cd /mnt/data/CHATS-Sandbox/benchmarks
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:?}"

wait_lanes() { while pgrep -f "sweep-multi.sh tasks15.txt" >/dev/null 2>&1; do sleep 60; done; }

missing_total() {
  local miss=0
  for a in claude hermes openhands; do
    while read t; do
      t="${t%%#*}"; t="${t// /}"; [ -z "$t" ] && continue
      for c in plugin git-add cp-all; do
        grep -q "^$t,$a,$c," "results/multi-$a.csv" 2>/dev/null || miss=$((miss+1))
      done
    done < tasks15.txt
  done
  echo "$miss"
}

for pass in 1 2 3; do
  wait_lanes
  m=$(missing_total)
  echo "$(date -u +%H:%M) pass-check: $m rows missing" >> /tmp/supervise.log
  [ "$m" -eq 0 ] && break
  for agent in claude hermes openhands; do
    nohup env OPENROUTER_API_KEY="$OPENROUTER_API_KEY" bash sweep-multi.sh tasks15.txt "results/multi-$agent.csv" "$agent" >> "/tmp/sweep-$agent.log" 2>&1 &
  done
  sleep 120
done
wait_lanes
python3 aggregate.py > results/summary-final.txt 2>&1
echo "$(date -u +%H:%M) FINAL SUMMARY WRITTEN ($(missing_total) missing)" >> /tmp/supervise.log
