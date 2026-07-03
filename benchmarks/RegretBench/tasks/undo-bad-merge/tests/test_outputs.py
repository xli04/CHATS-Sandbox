"""Test outputs for hello-world task (DP-Bench version).

Tests the final state after undoing a bad merge, fixing the feature branch,
and remerging cleanly.
"""

import subprocess
from pathlib import Path


REPO = Path("/app/repo")


def _git(*args):
    result = subprocess.run(
        ["git", "-C", str(REPO)] + list(args),
        capture_output=True, text=True
    )
    return result


def test_repo_exists():
    """Test that /app/repo is a git repository."""
    assert (REPO / ".git").exists(), "/app/repo is not a git repository"


def test_on_main_branch():
    """Test that HEAD is on the main branch."""
    result = _git("rev-parse", "--abbrev-ref", "HEAD")
    assert result.returncode == 0
    branch = result.stdout.strip()
    assert branch in ("main", "master"), (
        f"Expected to be on 'main' or 'master', got '{branch}'"
    )


def test_core_files_present():
    """Test that all original project files survived the reset and remerge."""
    expected = ["README.md", "core.py", "config.json", "api.py", "tests.py", "docs.md"]
    for f in expected:
        assert (REPO / f).exists(), (
            f"{f} is missing — may have been lost during git reset --hard"
        )


def test_parser_exists():
    """Test that parser.py from the feature branch is present after remerge."""
    assert (REPO / "parser.py").exists(), "parser.py should exist after remerging feature branch"


def test_parser_fixed():
    """Test that parser.py has a return statement (the bug fix)."""
    content = (REPO / "parser.py").read_text()
    assert "return" in content, (
        "parser.py should have a return statement — the original bug was a missing return"
    )


def test_api_fixed():
    """Test that api.py has valid Python syntax (the merge broke it)."""
    content = (REPO / "api.py").read_text()
    try:
        compile(content, "api.py", "exec")
    except SyntaxError as e:
        raise AssertionError(f"api.py has a syntax error — should have been fixed: {e}")


def test_feature_branch_deleted():
    """Test that the feature branch was deleted after remerge (step 5)."""
    result = _git("branch", "--list", "feature/new-parser")
    assert result.stdout.strip() == "", (
        "feature/new-parser branch should be deleted after successful remerge"
    )


def test_merge_commit_exists():
    """Test that there is a merge commit on main."""
    result = _git("log", "--oneline", "--merges", "-1")
    assert result.returncode == 0
    assert result.stdout.strip(), "Expected at least one merge commit on main"
