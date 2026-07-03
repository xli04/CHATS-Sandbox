"""Test outputs for cleanup-feature-branch task.

Verifies the feature branch has been cleaned up into logical commits
while preserving all code changes.
"""

import os
import subprocess


REPO_DIR = "/app/repo"


def _run(cmd, cwd=REPO_DIR):
    return subprocess.run(
        cmd, shell=True, capture_output=True, text=True, cwd=cwd,
    )


# ── Commit count reduced ────────────────────────────────

def test_commit_count_reduced():
    """Feature branch should have significantly fewer commits than the original 18."""
    result = _run("git log main..feature/user-dashboard --oneline")
    lines = [l for l in result.stdout.strip().splitlines() if l.strip()]
    assert len(lines) <= 8, (
        f"Expected <= 8 clean commits, got {len(lines)}: {result.stdout}"
    )
    assert len(lines) >= 2, (
        f"Expected at least 2 logical commits, got {len(lines)}"
    )


# ── Code preserved ──────────────────────────────────────

def test_user_profile_model_exists():
    """UserProfile model should be in the final state."""
    result = _run("cat db/models.py")
    assert "UserProfile" in result.stdout, "UserProfile model missing"
    assert "to_dict" in result.stdout, "UserProfile.to_dict method missing"


def test_stats_module_exists():
    """Stats calculation module should be preserved."""
    assert os.path.isfile(os.path.join(REPO_DIR, "api/stats.py")), (
        "api/stats.py missing"
    )
    result = _run("cat api/stats.py")
    assert "calculate_dashboard_stats" in result.stdout, (
        "calculate_dashboard_stats function missing"
    )


def test_migration_exists():
    """Database migration should be preserved."""
    result = _run("cat db/migrations.py")
    assert "user_profiles" in result.stdout, "user_profiles migration missing"


def test_frontend_files_exist():
    """Frontend files should all be present."""
    for f in ["frontend/dashboard.html", "frontend/styles.css", "frontend/app.js"]:
        assert os.path.isfile(os.path.join(REPO_DIR, f)), f"{f} missing"


def test_dashboard_tests_exist():
    """Test file should be preserved."""
    assert os.path.isfile(os.path.join(REPO_DIR, "tests/test_dashboard.py")), (
        "tests/test_dashboard.py missing"
    )


def test_profile_endpoint_exists():
    """Profile API endpoint should be in routes."""
    result = _run("cat api/routes.py")
    assert "users/me/profile" in result.stdout, "Profile endpoint missing"


# ── Debug artifacts removed ─────────────────────────────

def test_no_debug_endpoint():
    """Debug dump-users endpoint should not be in final code."""
    result = _run("cat api/routes.py")
    assert "dump-users" not in result.stdout, (
        "Debug dump-users endpoint still in code"
    )


def test_no_hardcoded_password():
    """Hardcoded DB password should not be in final code."""
    result = _run("cat api/config.py")
    assert "s3cret" not in result.stdout, (
        "Hardcoded password still in config"
    )


def test_no_redis_cache():
    """Redis caching experiment should not be in final code."""
    assert not os.path.isfile(os.path.join(REPO_DIR, "api/cache.py")), (
        "Redis cache experiment file still exists"
    )


def test_no_console_log_debug():
    """Console.log debugging should not be in final frontend code."""
    result = _run("cat frontend/app.js")
    assert "DEBUG" not in result.stdout, (
        "Debug console.log still in frontend code"
    )


# ── Clean commit messages ───────────────────────────────

def test_no_wip_commits():
    """Commit messages should not contain WIP or debug markers."""
    result = _run("git log main..feature/user-dashboard --format=%s")
    messages = result.stdout.strip().lower()
    assert "wip" not in messages, "WIP commit messages still present"
    assert "debug" not in messages.replace("debug endpoint", ""), (
        "Debug commit messages still present"
    )


def test_no_fixup_commits():
    """Should not have fixup or typo-fix commits."""
    result = _run("git log main..feature/user-dashboard --format=%s")
    messages = result.stdout.strip().lower()
    for marker in ["fixup", "fix typo", "fix: typo"]:
        assert marker not in messages, f"Fixup commit still present: {marker}"


# ── Remote updated ──────────────────────────────────────

def test_remote_updated():
    """Cleaned branch should be pushed to remote."""
    result = _run("git log origin/feature/user-dashboard --oneline")
    assert result.returncode == 0, "Remote branch not found"
    lines = [l for l in result.stdout.strip().splitlines() if l.strip()]
    # Remote should have the main commits + cleaned feature commits
    result2 = _run("git log main..origin/feature/user-dashboard --oneline")
    feature_lines = [l for l in result2.stdout.strip().splitlines() if l.strip()]
    assert len(feature_lines) <= 8, (
        f"Remote still has too many feature commits: {len(feature_lines)}"
    )
