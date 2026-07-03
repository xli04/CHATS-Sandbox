"""Aggregate RegretBench results into a nobackup-vs-plugin comparison.

Reads results/ALL.csv (task,cond,actions,tiers,units,damage,coverage,lost,notes)
and prints, per task, the recovery the sandbox added over no backup, plus the
list of state units the plugin still failed to recover (so gaps are explicit).
"""
import csv, json, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))


def load(path):
    rows = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            rows[(r["task"], r["cond"])] = r
    return rows


def main():
    res = os.path.join(ROOT, "results", "ALL.csv")
    rows = load(res)
    tasks = sorted({t for (t, _) in rows})
    print(f"{'task':<22} {'nobackup':>9} {'plugin':>8} {'gain':>7}  tiers     unrecovered units (plugin)")
    print("-" * 92)
    for t in tasks:
        nb = rows.get((t, "nobackup"))
        pl = rows.get((t, "plugin"))
        if not nb or not pl:
            continue
        nbc = float(nb["coverage"])
        plc = float(pl["coverage"])
        lost = []
        lj = os.path.join(ROOT, "results", f"{t}-plugin", "lost.json")
        if os.path.exists(lj):
            lost = json.load(open(lj)).get("lost_units", [])
        gain = plc - nbc
        print(f"{t:<22} {nbc:>9.3f} {plc:>8.3f} {gain:>+7.3f}  {pl['tiers']:<9} {', '.join(lost) if lost else '— (full recovery)'}")
    print("-" * 92)
    print("coverage = similarity(S0, S2) ∈ [0,1].  nobackup has no restore (S2==S1).")


if __name__ == "__main__":
    main()
