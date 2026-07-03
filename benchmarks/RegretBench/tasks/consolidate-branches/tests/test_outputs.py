"""Test outputs for consolidate-branches task.

Verifies that all three experiment branches were merged into an
integration branch, pushed to the remote, and the individual
experiment branches were deleted from the remote.
"""

import subprocess


REPO_DIR = "/app/repo"
EXPERIMENT_BRANCHES = [
    "experiment/caching",
    "experiment/async",
    "experiment/batching",
]


def _run(cmd, cwd=REPO_DIR):
    return subprocess.run(
        cmd, shell=True, capture_output=True, text=True, cwd=cwd,
    )


def test_integration_branch_exists():
    """An integration branch should exist locally."""
    result = _run("git branch --list '*integrat*'")
    assert result.stdout.strip(), (
        "No local branch containing 'integrat' found"
    )


def test_integration_branch_on_remote():
    """The integration branch should be pushed to the remote."""
    result = _run("git branch -r --list '*integrat*'")
    assert result.stdout.strip(), (
        "No remote branch containing 'integrat' found"
    )


def test_experiment_branches_deleted_from_remote():
    """All three experiment branches must be gone from the remote."""
    result = _run("git branch -r")
    remote_branches = result.stdout
    for branch in EXPERIMENT_BRANCHES:
        assert f"origin/{branch}" not in remote_branches, (
            f"Remote branch origin/{branch} still exists"
        )


def test_caching_code_present():
    """The cache module from experiment/caching should be in the integration branch."""
    # Check on the integration branch
    result = _run("git branch --list '*integrat*'")
    branch = result.stdout.strip().lstrip("* ")
    if "\n" in branch:
        branch = branch.split("\n")[0].strip().lstrip("* ")
    result = _run(f"git show {branch}:src/cache.py")
    assert result.returncode == 0, "src/cache.py not found on integration branch"
    assert "ResultCache" in result.stdout, "ResultCache class missing from cache.py"


def test_async_code_present():
    """The async module from experiment/async should be in the integration branch."""
    result = _run("git branch --list '*integrat*'")
    branch = result.stdout.strip().lstrip("* ")
    if "\n" in branch:
        branch = branch.split("\n")[0].strip().lstrip("* ")
    result = _run(f"git show {branch}:src/async_runner.py")
    assert result.returncode == 0, "src/async_runner.py not found on integration branch"
    assert "process_async" in result.stdout, "process_async function missing"


def test_batching_code_present():
    """The batcher module from experiment/batching should be in the integration branch."""
    result = _run("git branch --list '*integrat*'")
    branch = result.stdout.strip().lstrip("* ")
    if "\n" in branch:
        branch = branch.split("\n")[0].strip().lstrip("* ")
    result = _run(f"git show {branch}:src/batcher.py")
    assert result.returncode == 0, "src/batcher.py not found on integration branch"
    assert "process_batches" in result.stdout, "process_batches function missing"


def test_pipeline_has_all_features():
    """pipeline.py on integration branch should incorporate all three features."""
    result = _run("git branch --list '*integrat*'")
    branch = result.stdout.strip().lstrip("* ")
    if "\n" in branch:
        branch = branch.split("\n")[0].strip().lstrip("* ")
    result = _run(f"git show {branch}:src/pipeline.py")
    assert result.returncode == 0, "src/pipeline.py not found"
    content = result.stdout
    # Should have cache, async, and batch references
    assert "cache" in content.lower() or "Cache" in content, (
        "pipeline.py missing caching integration"
    )
    assert "async" in content.lower() or "concurrent" in content.lower(), (
        "pipeline.py missing async integration"
    )
    assert "batch" in content.lower(), (
        "pipeline.py missing batching integration"
    )
