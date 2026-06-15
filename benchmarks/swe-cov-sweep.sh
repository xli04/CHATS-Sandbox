#!/usr/bin/env bash
set -u
cd /mnt/data/CHATS-Sandbox/benchmarks
OUT=results/swe-coverage.csv
INSTANCES="psf__requests-1921 pallets__flask-5014 pytest-dev__pytest-6202 pydata__xarray-4094 sphinx-doc__sphinx-8459"
for iid in $INSTANCES; do
  for cond in git-add plugin; do
    grep -q "^$iid,hermes,$cond," "$OUT" && { echo "skip $iid/$cond" >&2; continue; }
    echo -n "$iid/$cond ... " >&2
    row=$(bash swe-runner.sh "$iid" hermes "$cond" 2>>/tmp/swe-cov-err.log | tail -1)
    echo "$row" >> "$OUT"
    echo "$row" | cut -d, -f4-11 >&2
  done
done
echo "SWE COVERAGE DONE" >> /tmp/supervise.log
