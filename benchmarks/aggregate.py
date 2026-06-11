#!/usr/bin/env python3
"""Aggregate the multi-agent backup benchmark CSVs into a comparison table.

Reads results/multi-{claude,hermes,openhands}.csv, keeps rows whose task is
in tasks15.txt, and reports per agent x condition:
  runs, test pass rate, wall time (median/mean), backup bytes (median/total),
  actions (median) — plus per-agent space/time ratios of the CHATS plugin
  vs the two baselines (git-add = always-shadow-repo, cp-all = copy-changed).
"""
import csv, statistics, sys, os

BASE = os.path.dirname(os.path.abspath(__file__))
AGENTS = ["claude", "hermes", "openhands"]
CONDS = ["plugin", "git-add", "cp-all"]

tasks = set()
TASKS_FILE = sys.argv[1] if len(sys.argv) > 1 else "tasks15.txt"
with open(os.path.join(BASE, TASKS_FILE)) as f:
    for line in f:
        line = line.split("#")[0].strip()
        if line:
            tasks.add(line)

rows = []
for a in AGENTS:
    p = os.path.join(BASE, "results", f"multi-{a}.csv")
    if not os.path.exists(p):
        continue
    with open(p) as f:
        for r in csv.DictReader(f):
            if r["task"] not in tasks or r["condition"] not in CONDS:
                continue
            try:
                wall = int(r["wall_seconds"]); by = int(r["backup_bytes"]); acts = int(r["actions"])
            except (ValueError, KeyError):
                continue
            if wall < 0:
                continue  # error rows
            net = by
            notes = r.get("notes") or ""
            if ";net=" in notes:
                try: net = int(notes.split(";net=")[1].split(";")[0])
                except ValueError: pass
            rows.append({"task": r["task"], "agent": r["agent"], "cond": r["condition"],
                         "wall": wall, "bytes": by, "net": net, "actions": acts,
                         "pass": r["test_pass"] == "pass"})

def fmt_b(n):
    if n >= 1 << 30: return f"{n/(1<<30):.2f} GB"
    if n >= 1 << 20: return f"{n/(1<<20):.2f} MB"
    if n >= 1 << 10: return f"{n/(1<<10):.1f} KB"
    return f"{n} B"

print(f"rows used: {len(rows)} (tasks={len(tasks)})\n")
print(f"{'agent':<10} {'condition':<8} {'n':>3} {'pass%':>6} {'wall med':>9} {'wall mean':>10} {'bytes med':>10} {'bytes total':>12} {'acts med':>9}")
print("-" * 84)
summary = {}
for a in AGENTS:
    for c in CONDS:
        sel = [r for r in rows if r["agent"] == a and r["cond"] == c]
        if not sel:
            continue
        walls = [r["wall"] for r in sel]; bys = [r["bytes"] for r in sel]
        s = {
            "n": len(sel),
            "pass": 100.0 * sum(r["pass"] for r in sel) / len(sel),
            "wall_med": statistics.median(walls), "wall_mean": statistics.mean(walls),
            "by_med": statistics.median(bys), "by_total": sum(bys),
            "acts_med": statistics.median([r["actions"] for r in sel]),
        }
        summary[(a, c)] = s
        print(f"{a:<10} {c:<8} {s['n']:>3} {s['pass']:>5.0f}% {s['wall_med']:>8.0f}s {s['wall_mean']:>9.1f}s "
              f"{fmt_b(s['by_med']):>10} {fmt_b(s['by_total']):>12} {s['acts_med']:>9.0f}")
    print()

print("=== CHATS plugin vs baselines (per agent; matched-task pairs) ===")
for a in AGENTS:
    for base in ["git-add", "cp-all"]:
        # pair by task so the comparison is apples-to-apples
        p = {r["task"]: r for r in rows if r["agent"] == a and r["cond"] == "plugin"}
        b = {r["task"]: r for r in rows if r["agent"] == a and r["cond"] == base}
        common = sorted(set(p) & set(b))
        if not common:
            continue
        space_ratios = [b[t]["bytes"] / max(p[t]["bytes"], 1) for t in common]
        wall_delta = [p[t]["wall"] - b[t]["wall"] for t in common]
        tot_p = sum(p[t]["bytes"] for t in common)
        tot_b = sum(b[t]["bytes"] for t in common)
        # Storage is paid in sums, not medians: lead with TOTAL ratio and
        # worst case; per-task median is the "typical tiny task" footnote.
        print(f"{a:<10} vs {base:<8} n={len(common):>2}  "
              f"TOTAL baseline/plugin: {tot_b/max(tot_p,1):>8.2f}x  "
              f"worst task: {max(space_ratios):>8.2f}x  "
              f"median: {statistics.median(space_ratios):>5.2f}x  "
              f"wall delta med: {statistics.median(wall_delta):>+5.1f}s")


# ── Storage-mechanism view ───────────────────────────────────────────
# Strips fixed accounting artifacts so the comparison measures the
# snapshot STRATEGY, not packaging:
#   - git empty-init floor (64,830 B: sample hooks + scaffolding) from
#     plugin and git-add alike (both carry one shadow repo)
#   - 4KB directory-block padding for per-action dirs (plugin: action
#     dir + trash dir per action + backups/; cp-all: trash/action_N)
# Function-critical content (metadata.json with recovery commands,
# trash payloads, snapshot objects) stays IN.
GIT_FLOOR = 64830
BLK = 4096
def adjusted(r):
    b = r["bytes"]
    if r["cond"] == "plugin":
        return max(0, b - GIT_FLOOR - (2 * r["actions"] + 1) * BLK)
    if r["cond"] == "git-add":
        return max(0, b - GIT_FLOOR)
    if r["cond"] == "cp-all":
        return max(0, b - (r["actions"] + 1) * BLK)
    return b

print()
print("=== ADJUSTED (storage-mechanism view): plugin vs baselines ===")
for a in AGENTS:
    for base in ["git-add", "cp-all"]:
        p = {r["task"]: r for r in rows if r["agent"] == a and r["cond"] == "plugin"}
        b = {r["task"]: r for r in rows if r["agent"] == a and r["cond"] == base}
        common = sorted(set(p) & set(b))
        if not common:
            continue
        ratios = [adjusted(b[t]) / max(adjusted(p[t]), 1) for t in common]
        print(f"{a:<10} vs {base:<8} n={len(common):>2}  baseline/plugin adjusted space: median {statistics.median(ratios):>7.2f}x")


# ── NET-new-disk comparison (moves excluded) ─────────────────────────
# rm-to-trash relocates bytes (workspace shrinks by what trash grows),
# so net cost excludes them. Only available for rows recorded with the
# net= note; older rows fall back to raw bytes.
print()
print("=== NET space: plugin vs baselines (matched pairs, totals) ===")
for a in AGENTS:
    for base in ["git-add", "cp-all"]:
        p = {r["task"]: r for r in rows if r["agent"] == a and r["cond"] == "plugin"}
        b = {r["task"]: r for r in rows if r["agent"] == a and r["cond"] == base}
        common = sorted(set(p) & set(b))
        if not common:
            continue
        tp = sum(p[t]["net"] for t in common)
        tb = sum(b[t]["net"] for t in common)
        print(f"{a:<10} vs {base:<8} n={len(common):>2}  TOTAL baseline/plugin (net): {tb/max(tp,1):>8.2f}x")
