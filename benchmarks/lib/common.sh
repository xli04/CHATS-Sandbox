#!/usr/bin/env bash
# Shared driver plumbing for the unified eval pipeline (sourced by eval.sh).
# Provides: run-id, the canonical CSV schema + atomic appends, a resume-safe
# concurrency pool, logging, and small helpers. Dataset/agent/condition
# adapters source nothing from here directly — eval.sh wires them together.
#
# CONCURRENCY CONTRACT (learned the hard way in swe-30-dual.sh): the ONLY
# writes to ALL.csv are single-line `>>` appends (atomic for <4KB lines on
# Linux). Never rewrite ALL.csv while workers run — that race clobbers rows.
# Partial-row cleanup happens ONCE at startup, single-threaded.

# ── canonical result schema ───────────────────────────────────────────
# Every row, every dataset/condition. Adapters fill what applies, "-" else.
CSV_HEADER="task,dataset,agent,cond,wall_s,disk_bytes,backup_ms,cov_handled,cov_total,cov_pct,recovery,tok_main,tok_sub,notes"

log()  { echo "[$(date +%H:%M:%S)] $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

# pct <handled> <total> -> integer percent (0 if total==0)
pct() { [ "${2:-0}" -gt 0 ] 2>/dev/null && python3 -c "print(round(100*$1/$2))" || echo 0; }

# emit_row <task> <cond> <wall> <disk> <backup_ms> <covh> <covt> <recovery> <tokmain> <toksub> <notes>
# Single atomic append. DATASET/AGENT come from the driver env.
emit_row() {
  local task="$1" cond="$2" wall="$3" disk="$4" bms="$5" covh="$6" covt="$7" rec="$8" tm="$9" ts="${10}" notes="${11}"
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$task" "$DATASET" "$AGENT" "$cond" "$wall" "$disk" "$bms" \
    "$covh" "$covt" "$(pct "$covh" "$covt")" "$rec" "$tm" "$ts" "$notes" >> "$OUT"
}

# init_out — create OUT with header if missing; one-time partial-row cleanup.
# A "complete" task has one row per requested condition (CONDS, space-list).
init_out() {
  mkdir -p "$(dirname "$OUT")"
  [ -f "$OUT" ] || echo "$CSV_HEADER" > "$OUT"
  local ncond; ncond=$(echo "$CONDS" | wc -w)
  python3 - "$OUT" "$ncond" <<'PY'
import csv, sys, collections
p, ncond = sys.argv[1], int(sys.argv[2])
rows = list(csv.reader(open(p)))
if not rows: sys.exit()
hdr, by = rows[0], collections.defaultdict(list)
for r in rows[1:]:
    if r: by[r[0]].append(r)          # group by task (col 0)
keep = [hdr]
for task, rs in by.items():
    if len(rs) >= ncond: keep.extend(rs[:ncond])   # keep only complete tasks
csv.writer(open(p, 'w')).writerows(keep)
PY
}

# task_done <task> — true if OUT already has >= len(CONDS) rows for this task.
task_done() {
  local n; n=$(grep -c "^$1," "$OUT" 2>/dev/null); n=${n:-0}
  [ "$n" -ge "$(echo "$CONDS" | wc -w)" ]
}

# pool_wait — block until a worker slot frees (MAXJOBS).
pool_wait() { while [ "$(jobs -rp | wc -l)" -ge "$MAXJOBS" ]; do wait -n 2>/dev/null || sleep 3; done; }

# require_env_key — fail fast if the provider key is absent.
require_env_key() { : "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY in the environment}"; }

# cid <cond-name> -> function-safe id (git-add -> gitadd, cp-all -> cpall)
cid() { echo "${1//-/}"; }
