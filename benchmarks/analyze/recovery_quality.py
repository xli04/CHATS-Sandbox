"""
Recovery-quality metric: similarity(S0, S2) in [0,1].

S0 = state BEFORE the action; S2 = state AFTER backup+restore. The score
answers "how close is the recovered state to the original", expressed as
a fraction of state units that match (so it is bounded [0,1] by
construction — no magnitude to normalize).

Two domains:
  - files:  matching paths / union of paths  (exact, or graded per-file)
  - records (DB rows / structured state): two axes —
        content_similarity  = rows whose VALUES match / total
        identity_similarity = rows whose KEY+values match / total
    (content-but-not-identity = scrape-and-recreate restored the data
     under new primary keys; the in-place recipe preserves both.)

Designed to be tested WITHOUT a live DB: the DB probe just produces the
row lists these functions consume.
"""
from __future__ import annotations
import os
import hashlib
import difflib
from dataclasses import dataclass, field


# ── files ────────────────────────────────────────────────────────────

@dataclass
class FileState:
    """path -> (sha256, mode_bits, size, is_text, text_or_None)."""
    files: dict = field(default_factory=dict)


def _is_text(b: bytes) -> bool:
    if b"\x00" in b[:8192]:
        return False
    try:
        b.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def scan_files(root: str, exclude: tuple = (".git", ".chats-sandbox", ".baseline", ".claude", ".hermes")) -> FileState:
    """Snapshot every regular file under root (excluding backup/infra dirs)."""
    st = FileState()
    root = os.path.realpath(root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in exclude]
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            try:
                if os.path.islink(fp) or not os.path.isfile(fp):
                    continue
                with open(fp, "rb") as f:
                    data = f.read()
                rel = os.path.relpath(fp, root)
                istext = _is_text(data)
                st.files[rel] = (
                    hashlib.sha256(data).hexdigest(),
                    os.stat(fp).st_mode & 0o777,
                    len(data),
                    istext,
                    data.decode("utf-8") if istext else None,
                )
            except OSError:
                continue
    return st


def file_similarity(s0: FileState, s2: FileState, graded: bool = True, size_weighted: bool = False) -> float:
    """matching / total over the union of paths, in [0,1].

    exact:  a path scores 1.0 iff (content-hash, mode) match, else 0.
    graded: a path present in BOTH with same mode but different *text*
            content scores its difflib ratio (partial credit); binary or
            only-in-one paths still score 0/1 (no false partial credit).
    size_weighted: weight each path by max(size_s0, size_s2) instead of 1
            (so a 1-byte file and a 1-MB file don't count equally).
    """
    paths = set(s0.files) | set(s2.files)
    if not paths:
        return 1.0  # nothing existed and nothing exists — trivially recovered
    num = 0.0
    den = 0.0
    for p in paths:
        a = s0.files.get(p)
        b = s2.files.get(p)
        w = 1.0
        if size_weighted:
            w = float(max(a[2] if a else 0, b[2] if b else 0, 1))
        den += w
        if a is None or b is None:
            continue  # created or deleted by the (un)recovery → 0
        hash_a, mode_a, _, text_a, ta = a
        hash_b, mode_b, _, text_b, tb = b
        if hash_a == hash_b and mode_a == mode_b:
            num += w
        elif graded and mode_a == mode_b and text_a and text_b:
            # partial content recovery → difflib ratio in [0,1]
            num += w * difflib.SequenceMatcher(None, ta, tb).ratio()
        # else: 0
    return num / den if den else 1.0


# ── records (DB rows / structured state) ─────────────────────────────

def record_similarity(rows0: list, rows2: list, key_idx=(0,)) -> dict:
    """Two-axis similarity over record sets, each in [0,1].

    rows0 / rows2: lists of tuples (one per row).
    key_idx: which tuple positions form the identity (primary key).

    content_similarity:  multiset overlap on the NON-key columns
                         (data is back, regardless of key) =
                         |intersection of value-tuples| / |union|
    identity_similarity: overlap on the FULL tuple (key + values)
                         (same data under the same key) =
                         |intersection of full-tuples| / |union|
    Returns {"content": x, "identity": y, "n0": .., "n2": ..}.
    """
    from collections import Counter

    def value_of(r):
        return tuple(v for i, v in enumerate(r) if i not in key_idx)

    def overlap(a_keys, b_keys):
        ca, cb = Counter(a_keys), Counter(b_keys)
        inter = sum((ca & cb).values())
        union = sum((ca | cb).values())
        return inter / union if union else 1.0

    content = overlap([value_of(r) for r in rows0], [value_of(r) for r in rows2])
    identity = overlap([tuple(r) for r in rows0], [tuple(r) for r in rows2])
    return {"content": content, "identity": identity, "n0": len(rows0), "n2": len(rows2)}


# ── the headline: ONE coverage rate in [0,1] ─────────────────────────

def coverage_rate_files(before_root: str, restored_root: str, **kw) -> float:
    """Single recovery-coverage rate for a file tree, in [0,1]."""
    return file_similarity(scan_files(before_root), scan_files(restored_root), **kw)


def coverage_rate_records(rows0: list, rows2: list, key_idx=(0,)) -> float:
    """Single recovery-coverage rate for records, in [0,1].

    Uses the STRICT axis (identity): a row counts as recovered only when
    the same values come back under the same primary key. (`content`
    alone would credit scrape-and-recreate, which loses identity.)
    """
    return record_similarity(rows0, rows2, key_idx)["identity"]


def manifest_similarity(m0: dict, m2: dict) -> float:
    """Coverage rate from two file MANIFESTS (no file contents needed).

    m: {relpath: [sha256, mode]}. A path counts as recovered only when
    its (hash, mode) match exactly. matching / union — in [0,1]. Used
    when the states live inside a container and only small hash
    manifests are copied out.
    """
    paths = set(m0) | set(m2)
    if not paths:
        return 1.0
    match = sum(1 for p in paths if m0.get(p) == m2.get(p))
    return match / len(paths)


# back-compat alias
recovery_quality_files = coverage_rate_files
