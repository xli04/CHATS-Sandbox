"""Rebuild results/ALL.csv canonically from the per-lane state manifests.

The s0/s1/s2.json snapshots are the source of truth (last completed run per
lane). damage/coverage/units/lost are recomputed from them; actions/tiers are
read from the lane's row.csv (the last well-formed 9-field line for that lane,
else 0/none). This makes the summary independent of any truncated ALL.csv.
"""
import csv, json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(ROOT, "results")
TASKS = ["git-rebase", "git-reset-hard", "git-clean-untracked"]
CONDS = ["nobackup", "plugin"]
COLS = ["task", "cond", "actions", "tiers", "units", "damage", "coverage", "lost", "notes"]


def sim(a, b):
    p = set(a) | set(b)
    return 1.0 if not p else sum(1 for k in p if a.get(k) == b.get(k)) / len(p)


def actions_tiers(lane_dir, task, cond):
    rc = os.path.join(lane_dir, "row.csv")
    if os.path.exists(rc):
        for line in open(rc):
            f = line.rstrip("\n").split(",")
            if len(f) == 9 and f[0] == task and f[1] == cond:
                return f[2], f[3]
    return "0", "none" if cond == "plugin" else "n/a"


def main():
    rows = []
    for task in TASKS:
        for cond in CONDS:
            d = os.path.join(RES, f"{task}-{cond}")
            try:
                s0 = json.load(open(os.path.join(d, "s0.json")))
                s1 = json.load(open(os.path.join(d, "s1.json")))
                s2 = json.load(open(os.path.join(d, "s2.json")))
            except FileNotFoundError:
                continue
            lost = sorted(k for k in set(s0) | set(s2) if s0.get(k) != s2.get(k))
            json.dump({"lost_units": lost}, open(os.path.join(d, "lost.json"), "w"))
            actions, tiers = actions_tiers(d, task, cond)
            rows.append({
                "task": task, "cond": cond, "actions": actions, "tiers": tiers,
                "units": len(s0), "damage": f"{sim(s0, s1):.4f}",
                "coverage": f"{sim(s0, s2):.4f}", "lost": len(lost), "notes": "ec=0",
            })
    with open(os.path.join(RES, "ALL.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows)
    print(f"rebuilt ALL.csv with {len(rows)} rows")


if __name__ == "__main__":
    main()
