"""Test outputs for scrub-api-key task.

Verifies the API key has been completely scrubbed from git history
and the rewritten history was force-pushed to the remote.
"""

import subprocess

API_KEY = "sk-proj-EXAMPLE0FAKE0KEY00000000000000000000000000000000000000"
REPO_DIR = "/app/repo"


def _run(cmd, cwd=REPO_DIR):
    result = subprocess.run(
        cmd, shell=True, capture_output=True, text=True, cwd=cwd,
    )
    return result


def test_key_not_in_git_log():
    """API key must not appear anywhere in git log -p."""
    result = _run("git log -p --all")
    assert API_KEY not in result.stdout, (
        "API key still visible in git log output"
    )


def test_key_not_in_git_grep():
    """API key must not appear in any revision via git grep."""
    result = _run(f"git grep '{API_KEY}' $(git rev-list --all)")
    assert result.returncode != 0, (
        "API key found in historical revisions via git grep"
    )


def test_key_not_in_working_tree():
    """API key must not appear in the current working tree."""
    result = _run(f"grep -r '{API_KEY}' .")
    assert result.returncode != 0, (
        "API key still present in working tree files"
    )


def test_config_has_placeholder():
    """config.yaml should have a placeholder instead of the real key."""
    result = _run("cat config.yaml")
    assert result.returncode == 0, "config.yaml not found"
    assert API_KEY not in result.stdout, (
        "API key still in config.yaml"
    )
    # The file should still have an api_key field with some placeholder
    assert "api_key" in result.stdout, (
        "api_key field missing from config.yaml"
    )


def test_remote_updated():
    """The rewritten history must have been force-pushed to origin/master."""
    # Check that origin/master exists and matches local master
    local = _run("git rev-parse master")
    remote = _run("git rev-parse origin/master")
    assert local.returncode == 0, "Local master branch not found"
    assert remote.returncode == 0, "origin/master not found — force push may not have happened"
    assert local.stdout.strip() == remote.stdout.strip(), (
        "origin/master does not match local master — force push may not have happened"
    )


def test_key_not_in_remote_history():
    """API key must not appear in the remote repo's history either."""
    result = _run(
        f"git log -p --all | grep -c '{API_KEY}'",
        cwd="/app/repo.remote",
    )
    # In a bare repo, git log -p works but we pipe through grep -c
    # If key is absent, grep returns 1 (no matches) and count is 0
    count = int(result.stdout.strip()) if result.stdout.strip().isdigit() else 0
    assert count == 0, (
        f"API key found {count} times in remote repository history"
    )


def test_commit_history_preserved():
    """The repo should still have a reasonable number of commits."""
    result = _run("git rev-list --count HEAD")
    assert result.returncode == 0
    count = int(result.stdout.strip())
    assert count >= 5, (
        f"Expected at least 5 commits after rebase, got {count}"
    )
