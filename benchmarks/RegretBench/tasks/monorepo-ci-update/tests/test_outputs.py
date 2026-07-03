"""Test outputs for monorepo-ci-update task.

Verifies the CI/CD workflow files have been updated to reflect
the new monorepo directory structure.
"""

import os
import subprocess

import yaml


REPO_DIR = "/app/repo"
WORKFLOWS_DIR = os.path.join(REPO_DIR, ".github/workflows")


def _run(cmd, cwd=REPO_DIR):
    return subprocess.run(
        cmd, shell=True, capture_output=True, text=True, cwd=cwd,
    )


def _load_workflow(filename):
    path = os.path.join(WORKFLOWS_DIR, filename)
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        return yaml.safe_load(f)


def _read_all_workflows():
    """Read and concatenate all workflow file contents."""
    content = ""
    for f in os.listdir(WORKFLOWS_DIR):
        if f.endswith((".yml", ".yaml")):
            with open(os.path.join(WORKFLOWS_DIR, f)) as fh:
                content += fh.read() + "\n"
    return content


# ── Path triggers ─────────────────────────────────────────

def test_ci_paths_updated():
    """CI workflow path triggers should reference services/ and packages/, not src/ or tests/."""
    content = _read_all_workflows()
    # Should have new monorepo paths
    assert "services/" in content, "No 'services/' path trigger found in workflows"
    assert "packages/" in content, "No 'packages/' path trigger found in workflows"


def test_no_old_path_triggers():
    """Old flat path triggers should be gone."""
    content = _read_all_workflows()
    # Check that old-style paths are not in path trigger sections
    # Simple heuristic: 'src/**' as a standalone trigger line
    lines = content.splitlines()
    for line in lines:
        stripped = line.strip().strip("- '\"")
        if stripped == "src/**" or stripped == "tests/**":
            assert False, f"Old path trigger still present: {stripped}"


# ── Build order / dependencies ────────────────────────────

def test_new_services_in_workflow():
    """Gateway and db-models should have jobs or be referenced."""
    content = _read_all_workflows()
    assert "gateway" in content.lower(), "Gateway service not found in workflows"
    assert "db-models" in content.lower() or "db_models" in content.lower(), (
        "db-models package not found in workflows"
    )


def test_shared_lib_builds_first():
    """shared-lib job should not depend on api/worker/gateway."""
    content = _read_all_workflows()
    # Load all workflows and find shared-lib job
    for f in os.listdir(WORKFLOWS_DIR):
        if not f.endswith((".yml", ".yaml")):
            continue
        wf = _load_workflow(f)
        if not wf or "jobs" not in wf:
            continue
        for job_name, job_def in wf["jobs"].items():
            if "shared" in job_name.lower() or "shared-lib" in job_name.lower() or "shared_lib" in job_name.lower():
                needs = job_def.get("needs", [])
                if isinstance(needs, str):
                    needs = [needs]
                for dep in needs:
                    assert "api" not in dep.lower(), (
                        f"shared-lib job depends on api: {needs}"
                    )
                    assert "worker" not in dep.lower(), (
                        f"shared-lib job depends on worker: {needs}"
                    )


# ── Test paths ────────────────────────────────────────────

def test_test_paths_updated():
    """Test paths should reference per-service test directories."""
    content = _read_all_workflows()
    # Should reference new test paths
    new_paths = [
        "services/api/tests",
        "services/worker/tests",
    ]
    found = sum(1 for p in new_paths if p in content)
    assert found >= 1, (
        "No per-service test paths found (expected services/*/tests/)"
    )


def test_no_old_test_paths():
    """Old flat test paths should be gone."""
    content = _read_all_workflows()
    old_paths = ["tests/api/", "tests/worker/", "tests/shared/"]
    for p in old_paths:
        assert p not in content, f"Old test path still referenced: {p}"


# ── Caching ───────────────────────────────────────────────

def test_cache_keys_per_service():
    """Cache keys should reference per-service requirements files."""
    content = _read_all_workflows()
    # Should have hashFiles referencing service-specific requirements
    assert "services/" in content and "requirements" in content, (
        "Cache keys don't reference per-service requirements files"
    )


# ── Deploy ────────────────────────────────────────────────

def test_deploy_includes_gateway():
    """Deploy matrix should include gateway service."""
    for f in os.listdir(WORKFLOWS_DIR):
        if not f.endswith((".yml", ".yaml")):
            continue
        wf = _load_workflow(f)
        if not wf or "jobs" not in wf:
            continue
        for job_name, job_def in wf["jobs"].items():
            if "deploy" in job_name.lower() or "build" in job_name.lower():
                strategy = job_def.get("strategy", {})
                matrix = strategy.get("matrix", {})
                services = matrix.get("service", [])
                if services and "gateway" in services:
                    return
    # If no deploy matrix found with gateway, check if gateway is mentioned
    content = _read_all_workflows()
    assert "gateway" in content.lower(), (
        "Gateway not found in deploy configuration"
    )


# ── YAML validity ────────────────────────────────────────

def test_all_workflows_valid_yaml():
    """All workflow files must be valid YAML."""
    for f in os.listdir(WORKFLOWS_DIR):
        if not f.endswith((".yml", ".yaml")):
            continue
        path = os.path.join(WORKFLOWS_DIR, f)
        with open(path) as fh:
            try:
                data = yaml.safe_load(fh.read())
                assert data is not None, f"{f} parsed as empty"
                assert "jobs" in data or "on" in data, (
                    f"{f} missing 'jobs' or 'on' — may not be a valid workflow"
                )
            except yaml.YAMLError as e:
                assert False, f"{f} is not valid YAML: {e}"


# ── Push ──────────────────────────────────────────────────

def test_changes_pushed():
    """Updated workflows should be pushed to the remote."""
    local = _run("git rev-parse HEAD")
    remote = _run("git rev-parse origin/master")
    assert local.returncode == 0, "Local HEAD not found"
    assert remote.returncode == 0, "origin/master not found"
    # Remote should have newer commits than initial
    result = _run("git log origin/master --oneline")
    lines = [l for l in result.stdout.strip().splitlines() if l.strip()]
    assert len(lines) >= 2, (
        "Only initial commit on remote — changes may not have been pushed"
    )
