"""
Stress test: does recovery_quality actually REFLECT recovery quality?

Each case builds a known before-state and a known recovered-state where
the *true* answer is obvious, then asserts the metric matches. The point
is to catch metrics that score high when recovery was bad (false high =
dangerous) or low when recovery was perfect (false low).
"""
import os, shutil, tempfile, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from recovery_quality import scan_files, file_similarity, record_similarity

PASS, FAIL = 0, 0

def check(name, got, lo, hi):
    global PASS, FAIL
    ok = lo <= got <= hi
    print(f"{'PASS' if ok else 'FAIL'}  {name:<52} got={got:.3f}  expect[{lo:.2f},{hi:.2f}]")
    PASS += ok; FAIL += not ok

def mk(d, files):
    """files: {relpath: (content_str_or_bytes, mode)}"""
    for rel, spec in files.items():
        content, mode = spec
        fp = os.path.join(d, rel)
        os.makedirs(os.path.dirname(fp) or d, exist_ok=True)
        data = content if isinstance(content, bytes) else content.encode()
        with open(fp, "wb") as f:
            f.write(data)
        os.chmod(fp, mode)

def sim(before_files, after_files, **kw):
    b = tempfile.mkdtemp(); a = tempfile.mkdtemp()
    try:
        mk(b, before_files); mk(a, after_files)
        return file_similarity(scan_files(b), scan_files(a), **kw)
    finally:
        shutil.rmtree(b, True); shutil.rmtree(a, True)

# ── FILE cases ───────────────────────────────────────────────────────
F = {"a.txt": ("hello world\nline2\n", 0o644),
     "b.py":  ("def f():\n    return 1\n", 0o644),
     "c.csv": ("x,y\n1,2\n3,4\n", 0o644)}

# 1. perfect recovery: identical → 1.0
check("perfect recovery (S2==S0)", sim(F, F), 0.999, 1.0)

# 2. no recovery: one file still fully mutated (exact mode) → 2/3
F_dmg = dict(F); F_dmg["a.txt"] = ("TOTALLY DIFFERENT GARBAGE\n", 0o644)
check("1 of 3 files unrecovered (exact)", sim(F, F_dmg, graded=False), 0.66, 0.67)

# 3. same case graded: a.txt gets partial credit (very different → low ratio)
check("1 of 3 unrecovered (graded, low partial)", sim(F, F_dmg, graded=True), 0.66, 0.85)

# 4. partial content recovery: a.txt restored 90% (one line off)
F_part = dict(F); F_part["a.txt"] = ("hello world\nCHANGED\n", 0o644)
g = sim(F, F_part, graded=True)
e = sim(F, F_part, graded=False)
check("partial file recovery graded > exact", g - e, 0.10, 0.34)  # graded gives credit
check("partial file recovery exact = 2/3", e, 0.66, 0.67)

# 5. file deleted and NOT restored → counts as 0 for that path → 2/3
F_del = {k: v for k, v in F.items() if k != "c.csv"}
check("deleted file not restored", sim(F, F_del), 0.66, 0.67)

# 6. mode changed (content same) → exact mismatch → 2/3
F_mode = dict(F); F_mode["b.py"] = ("def f():\n    return 1\n", 0o600)
check("mode change counts as mismatch", sim(F, F_mode, graded=False), 0.66, 0.67)

# 7. over-recovery: an EXTRA file appeared after restore → union grows → 3/4
F_extra = dict(F); F_extra["leftover.tmp"] = ("junk\n", 0o644)
check("over-recovery (extra file) penalized", sim(F, F_extra), 0.74, 0.76)

# 8. binary partial: graded must NOT give false partial credit on binary
B0 = {"img.bin": (bytes(range(256)) * 10, 0o644)}
B2 = {"img.bin": (bytes(range(255, -1, -1)) * 10, 0o644)}  # different binary
check("binary mismatch no false partial credit", sim(B0, B2, graded=True), 0.0, 0.01)

# 9. empty → empty: trivially 1.0
check("empty workspace recovered", sim({}, {}), 0.999, 1.0)

# 10. the DANGEROUS false-high check: recovery did NOTHING on a big file,
#     but workspace has many untouched files. Un-normalized similarity is
#     high BUT must still drop proportionally, not report ~1.0.
many = {f"f{i}.txt": (f"content {i}\n", 0o644) for i in range(20)}
many_dmg = dict(many); many_dmg["f0.txt"] = ("WIPED\n", 0o644)
check("1/20 unrecovered → ~0.95 (not falsely 1.0)", sim(many, many_dmg, graded=False), 0.94, 0.96)

# ── RECORD (DB) cases ────────────────────────────────────────────────
# rows: (id, name, amount); key = id
R0 = [(1, "alice", 100), (2, "bob", 200), (3, "carol", 300)]

# 11. perfect DB restore (same rows, same keys) → content=1, identity=1
r = record_similarity(R0, list(R0))
check("DB perfect restore content", r["content"], 0.999, 1.0)
check("DB perfect restore identity", r["identity"], 0.999, 1.0)

# 12. scrape-and-recreate: same DATA, NEW primary keys (id shifted +10)
R_recreate = [(11, "alice", 100), (12, "bob", 200), (13, "carol", 300)]
r = record_similarity(R0, R_recreate)
check("DB recreate: content high", r["content"], 0.999, 1.0)
check("DB recreate: identity LOW (new PKs)", r["identity"], 0.0, 0.01)

# 13. no restore: one row still missing (deleted, not back) → 2/3 both axes
R_missing = [(1, "alice", 100), (2, "bob", 200)]
r = record_similarity(R0, R_missing)
check("DB 1 row unrecovered content", r["content"], 0.66, 0.67)
check("DB 1 row unrecovered identity", r["identity"], 0.66, 0.67)

# 14. value corrupted on restore (right key, wrong amount) → identity drops
R_corrupt = [(1, "alice", 100), (2, "bob", 999), (3, "carol", 300)]
r = record_similarity(R0, R_corrupt)
check("DB corrupted value identity", r["identity"], 0.49, 0.51)  # 2 full matches /4 union

# 15. table emptied and not restored → 0
r = record_similarity(R0, [])
check("DB table emptied not restored", r["content"], 0.0, 0.01)

print(f"\n{PASS}/{PASS+FAIL} cases passed")
sys.exit(1 if FAIL else 0)
