"""Test outputs for sanitize-git-repo task.

Verifies proprietary files are removed from working tree AND git history,
reflog is expired, and cleaned history is force-pushed to the remote.
"""

import subprocess

REPO_DIR = "/app/repo"

# File paths that must not appear in any commit
PROPRIETARY_FILES = [
    "internal/license_check.py",
    "internal/__init__.py",
    "proprietary/telemetry.py",
    "proprietary/pricing.py",
    "proprietary/__init__.py",
]

# Sensitive secrets/keys that must not appear in diffs
PROPRIETARY_SECRETS = [
    "wc_prod_9Kx4mR7vP2nL5qW8tY1bA3cF6hJ0dE",
    "aes256-wc-0x4F7A2B9C1D8E3F6A",
]


def _run(cmd, cwd=REPO_DIR):
    return subprocess.run(
        cmd, shell=True, capture_output=True, text=True, cwd=cwd,
    )


def test_proprietary_dirs_not_in_working_tree():
    """internal/ and proprietary/ must not exist in working tree."""
    result = _run("ls -d internal/ proprietary/ 2>&1")
    assert "internal/" not in result.stdout or "No such file" in result.stderr
    assert "proprietary/" not in result.stdout or "No such file" in result.stderr


def test_proprietary_files_not_in_history():
    """No proprietary file paths should appear in git log."""
    result = _run("git log --all --full-history --name-only")
    output = result.stdout
    for f in PROPRIETARY_FILES:
        assert f not in output, (
            f"Proprietary file '{f}' still appears in git history"
        )


def test_proprietary_secrets_not_in_diffs():
    """Sensitive secrets/keys must not appear in git log -p."""
    result = _run("git log -p --all")
    output = result.stdout
    for secret in PROPRIETARY_SECRETS:
        assert secret not in output, (
            f"Proprietary secret '{secret[:20]}...' still found in git diffs"
        )


def test_reflog_expired():
    """Reflog should be empty after expiration."""
    result = _run("git reflog")
    lines = [l.strip() for l in result.stdout.strip().splitlines() if l.strip()]
    # After expire + gc, reflog should have at most 1 entry (current HEAD)
    assert len(lines) <= 1, (
        f"Reflog still has {len(lines)} entries — expected 0 or 1 after expiration"
    )


def test_public_files_preserved():
    """Public source files must still exist and be functional."""
    for path in ["src/widget.py", "src/chart.py", "src/dashboard.py",
                 "README.md", "LICENSE", "CONTRIBUTING.md", "tests/test_widget.py"]:
        result = _run(f"test -f {path} && echo exists")
        assert "exists" in result.stdout, f"Public file {path} is missing"


def test_widget_is_clean():
    """widget.py must not import from internal modules."""
    result = _run("cat src/widget.py")
    assert "internal" not in result.stdout, (
        "widget.py still references internal modules"
    )
    assert "license_check" not in result.stdout, (
        "widget.py still references license_check"
    )


def test_remote_updated():
    """Cleaned history must be force-pushed to the remote."""
    local = _run("git rev-parse master")
    remote = _run("git rev-parse origin/master")
    assert local.returncode == 0, "Local master not found"
    assert remote.returncode == 0, (
        "origin/master not found — force push may not have happened"
    )
    assert local.stdout.strip() == remote.stdout.strip(), (
        "origin/master does not match local master"
    )


def test_remote_history_clean():
    """Proprietary files and secrets must not appear in the remote repo history."""
    result = _run("git log -p --all", cwd="/app/repo.remote")
    output = result.stdout
    for secret in PROPRIETARY_SECRETS:
        assert secret not in output, (
            f"Proprietary secret '{secret[:20]}...' found in remote history"
        )
    # Check file paths in name-only log
    result2 = _run("git log --all --name-only", cwd="/app/repo.remote")
    for f in PROPRIETARY_FILES:
        assert f not in result2.stdout, (
            f"Proprietary file '{f}' found in remote history"
        )


def test_commit_history_preserved():
    """Repo should still have a reasonable number of commits."""
    result = _run("git rev-list --count HEAD")
    assert result.returncode == 0
    count = int(result.stdout.strip())
    # Original had 8 commits; after filtering proprietary-only commits
    # some may be removed, but public commits should remain
    assert count >= 3, (
        f"Expected at least 3 commits after filtering, got {count}"
    )
