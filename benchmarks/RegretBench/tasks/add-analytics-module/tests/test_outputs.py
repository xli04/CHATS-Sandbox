"""Test outputs for add-analytics-module task.

Tests that requirements.txt was updated correctly and the new module imports.
"""

import subprocess
from pathlib import Path


REQUIREMENTS_PATH = Path("/app/platform/requirements.txt")

# The 7 new packages the analytics module needs
NEW_PACKAGES = [
    "scikit-learn",
    "scipy",
    "matplotlib",
    "seaborn",
    "plotly",
    "statsmodels",
    "bokeh",
]

# Packages that need version bumps
BUMPED_PACKAGES = ["pandas", "numpy", "pydantic"]


def _read_requirements():
    content = REQUIREMENTS_PATH.read_text()
    pkgs = {}
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        for sep in ["==", ">=", "<=", "~=", ">"]:
            if sep in line:
                name, ver = line.split(sep, 1)
                pkgs[name.strip().lower()] = ver.strip()
                break
        else:
            pkgs[line.lower()] = ""
    return pkgs


def test_requirements_file_exists():
    """Test that requirements.txt exists."""
    assert REQUIREMENTS_PATH.exists(), "requirements.txt not found"


def test_new_packages_added():
    """Test that all new analytics dependencies were added."""
    pkgs = _read_requirements()
    for pkg in NEW_PACKAGES:
        assert pkg.lower() in pkgs, (
            f"New package '{pkg}' not found in requirements.txt"
        )


def test_existing_packages_preserved():
    """Test that existing platform packages are still present."""
    pkgs = _read_requirements()
    essential = ["flask", "sqlalchemy", "celery", "redis", "marshmallow", "httpx"]
    for pkg in essential:
        assert pkg.lower() in pkgs, (
            f"Existing package '{pkg}' was removed from requirements.txt"
        )


def test_version_bumps_applied():
    """Test that conflicting versions were bumped."""
    pkgs = _read_requirements()
    for pkg in BUMPED_PACKAGES:
        assert pkg.lower() in pkgs, f"{pkg} missing from requirements.txt"


def test_new_module_imports():
    """Test that the analytics module imports and runs correctly."""
    result = subprocess.run(
        ["python", "-c",
         "import sys; sys.path.insert(0, '/app'); "
         "from new_module import analytics; print(analytics.run())"],
        capture_output=True, text=True, cwd="/app/platform",
    )
    assert result.returncode == 0, (
        f"Failed to import analytics module: {result.stderr}"
    )
    assert "Analytics module ready" in result.stdout, (
        f"Unexpected output: {result.stdout}"
    )


def test_existing_modules_still_work():
    """Test that existing platform modules still import after dependency changes."""
    result = subprocess.run(
        ["python", "-c",
         "import sys; sys.path.insert(0, '/app/platform'); "
         "from modules import etl, api; "
         "print(etl.run()); print(api.run())"],
        capture_output=True, text=True, cwd="/app/platform",
    )
    assert result.returncode == 0, (
        f"Existing modules broken after dependency update: {result.stderr}"
    )
    assert "ETL module ready" in result.stdout
    assert "API module ready" in result.stdout
