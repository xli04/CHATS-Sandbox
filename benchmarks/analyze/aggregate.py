#!/usr/bin/env python3
"""Aggregate a unified ALL.csv into a RESULTS.md summary table.

Schema (lib/common.sh CSV_HEADER):
  task,dataset,agent,cond,wall_s,disk_bytes,backup_ms,cov_handled,cov_total,
  cov_pct,recovery,tok_main,tok_sub,notes

Usage: aggregate.py <ALL.csv>   # writes markdown to stdout
"""
import csv, sys, statistics as st, collections

def num(x):
    try: return float(x)
    except Exception: return None

def mean(xs):
    xs = [x for x in xs if x is not None]
    return st.mean(xs) if xs else None

def fmt(x, unit="", nd=1):
    return "—" if x is None else f"{x:.{nd}f}{unit}"

def main(path):
    rows = list(csv.DictReader(open(path)))
    rows = [r for r in rows if num(r.get("wall_s")) != -1]   # drop failed rows
    if not rows:
        print("# Results\n\n_No completed rows._"); return
    ds = sorted({r["dataset"] for r in rows}); ag = sorted({r["agent"] for r in rows})
    by = collections.defaultdict(list)
    for r in rows: by[r["cond"]].append(r)

    print(f"# Backup evaluation — {', '.join(ds)} ({', '.join(ag)})\n")
    print(f"Tasks: {len({r['task'] for r in rows})} · conditions: {len(by)} · rows: {len(rows)}\n")
    cols = ("condition", "n", "coverage", "disk", "backup", "recovery",
            "MB/1%cov", "ms/1%cov", "tok_main", "tok_sub")
    print("| " + " | ".join(cols) + " |")
    print("|" + "|".join(["---"] * len(cols)) + "|")
    for cond in sorted(by):
        rs = by[cond]
        cov = mean([num(r["cov_pct"]) for r in rs])
        mb  = mean([num(r["disk_bytes"]) for r in rs])
        mb  = mb / 1e6 if mb is not None else None
        bms = mean([num(r["backup_ms"]) for r in rs])
        rec = mean([num(r["recovery"]) for r in rs if r["recovery"] not in ("-", "")])
        tm  = mean([num(r["tok_main"]) for r in rs if r["tok_main"] not in ("-", "")])
        tsb = mean([num(r["tok_sub"]) for r in rs if r["tok_sub"] not in ("-", "")])
        mb_per = (mb / cov) if (mb is not None and cov) else None
        ms_per = (bms / cov) if (bms is not None and cov) else None
        print("| " + " | ".join([
            f"**{cond}**", str(len(rs)), fmt(cov, "%"), fmt(mb, " MB"), fmt(bms, " ms"),
            fmt(rec, "", 3), fmt(mb_per, "", 3), fmt(ms_per, "", 1),
            fmt(tm, "", 0), fmt(tsb, "", 0),
        ]) + " |")
    print("\n_coverage = % of mutating actions a method can reverse · "
          "MB/1%cov & ms/1%cov are efficiency (lower is better) · recovery = content-similarity after restore._")

if __name__ == "__main__":
    main(sys.argv[1])
