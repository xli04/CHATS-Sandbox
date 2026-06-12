#!/usr/bin/env bash
set -u
cd /mnt/data/CHATS-Sandbox/benchmarks
OUT=results/swe-validate.csv
[ -f "$OUT" ] || echo "instance,agent,cond,wall,backup_bytes,actions,backup_ms,tiers,test_pass,notes" > "$OUT"
for iid in psf__requests-1766 psf__requests-1921 pallets__flask-5014 pytest-dev__pytest-6202 pydata__xarray-4094 sphinx-doc__sphinx-8459; do
  grep -q "^$iid,hermes,plugin," "$OUT" && { echo "skip $iid" >&2; continue; }
  echo -n "$iid ... " >&2
  row=$(bash swe-runner.sh "$iid" hermes plugin 2>>/tmp/swe-validate-err.log | tail -1)
  echo "$row" >> "$OUT"
  echo "$row" | cut -d, -f4-9 >&2
done
echo "SWE VALIDATE DONE" >> /tmp/supervise.log
