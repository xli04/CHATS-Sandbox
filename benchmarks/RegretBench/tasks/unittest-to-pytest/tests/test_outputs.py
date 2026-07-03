"""Test outputs for unittest-to-pytest task.

Verifies the test configuration was migrated from unittest/nose2 to pytest
while preserving coverage settings and test functionality.
"""

import configparser
import os
import re


PROJECT = "/app/project"


def _read_file(path):
    with open(os.path.join(PROJECT, path)) as f:
        return f.read()


def _parse_setup_cfg():
    cfg = configparser.ConfigParser()
    cfg.read(os.path.join(PROJECT, "setup.cfg"))
    return cfg


def _parse_tox_ini():
    cfg = configparser.ConfigParser()
    cfg.read(os.path.join(PROJECT, "tox.ini"))
    return cfg


# ── setup.cfg: pytest config added ──


def test_setup_cfg_has_pytest_section():
    """setup.cfg should have [tool:pytest] section."""
    cfg = _parse_setup_cfg()
    assert cfg.has_section("tool:pytest"), "Missing [tool:pytest] section in setup.cfg"


def test_setup_cfg_testpaths():
    """pytest should discover tests in the tests directory."""
    cfg = _parse_setup_cfg()
    val = cfg.get("tool:pytest", "testpaths", fallback="")
    assert "tests" in val, f"testpaths should include 'tests', got '{val}'"


def test_setup_cfg_no_nose2():
    """nose2 config sections should be removed."""
    content = _read_file("setup.cfg")
    assert "tool:nose2" not in content, "Old [tool:nose2] section still in setup.cfg"


def test_setup_cfg_strict_markers():
    """pytest addopts should include --strict-markers."""
    cfg = _parse_setup_cfg()
    addopts = cfg.get("tool:pytest", "addopts", fallback="")
    assert "--strict-markers" in addopts, f"addopts should include --strict-markers, got '{addopts}'"


# ── setup.cfg: coverage settings preserved ──


def test_coverage_run_preserved():
    """[coverage:run] section must be preserved."""
    cfg = _parse_setup_cfg()
    assert cfg.has_section("coverage:run"), "Missing [coverage:run] section"
    source = cfg.get("coverage:run", "source", fallback="")
    assert "src/dataforge" in source, f"coverage source should include src/dataforge, got '{source}'"


def test_coverage_report_preserved():
    """[coverage:report] section must be preserved with 85% threshold."""
    cfg = _parse_setup_cfg()
    assert cfg.has_section("coverage:report"), "Missing [coverage:report] section"
    threshold = cfg.get("coverage:report", "fail_under", fallback="")
    assert threshold == "85", f"coverage fail_under should be 85, got '{threshold}'"


def test_coverage_branch_preserved():
    """Branch coverage must remain enabled."""
    cfg = _parse_setup_cfg()
    branch = cfg.get("coverage:run", "branch", fallback="")
    assert branch.lower() == "true", f"branch coverage should be true, got '{branch}'"


# ── tox.ini: pytest commands ──


def test_tox_uses_pytest():
    """tox testenv commands should use pytest, not nose2."""
    content = _read_file("tox.ini")
    assert "pytest" in content, "tox.ini should reference pytest"


def test_tox_no_nose2():
    """tox should not reference nose2 in test commands."""
    cfg = _parse_tox_ini()
    # Check testenv deps
    if cfg.has_option("testenv", "deps"):
        deps = cfg.get("testenv", "deps")
        assert "nose2" not in deps, "tox testenv deps should not include nose2"


def test_tox_unit_command():
    """tox should run unit tests with pytest."""
    content = _read_file("tox.ini")
    # Look for unit test command with pytest
    assert re.search(r"unit:.*pytest.*tests/unit", content), \
        "tox should have a unit test command using pytest on tests/unit/"


def test_tox_integration_command():
    """tox should run integration tests with pytest."""
    content = _read_file("tox.ini")
    assert re.search(r"integration:.*pytest.*tests/integration", content), \
        "tox should have an integration test command using pytest on tests/integration/"


def test_tox_junit_xml():
    """tox should produce junit XML reports."""
    content = _read_file("tox.ini")
    assert "junitxml" in content or "junit-xml" in content or "junit_xml" in content, \
        "tox should produce junit XML reports"


def test_tox_coverage_command():
    """tox coverage env should use pytest-cov."""
    content = _read_file("tox.ini")
    assert re.search(r"pytest.*--cov", content), \
        "tox coverage command should use pytest --cov"


def test_tox_coverage_threshold():
    """tox coverage should enforce 85% threshold."""
    content = _read_file("tox.ini")
    assert "85" in content, "tox should enforce 85% coverage threshold"


def test_tox_envlist_preserved():
    """tox envlist should still include unit and integration envs."""
    cfg = _parse_tox_ini()
    envlist = cfg.get("tox", "envlist", fallback="")
    assert "unit" in envlist, f"envlist should include unit, got '{envlist}'"
    assert "integration" in envlist, f"envlist should include integration, got '{envlist}'"


def test_tox_setenv_preserved():
    """PYTHONPATH and test environment variables should be preserved."""
    content = _read_file("tox.ini")
    assert "PYTHONPATH" in content, "PYTHONPATH should be preserved in tox setenv"
    assert "DATAFORGE_TEST_MODE" in content, "DATAFORGE_TEST_MODE should be preserved"


# ── conftest.py: pytest fixtures ──


def test_conftest_uses_pytest_fixtures():
    """conftest.py should use @pytest.fixture decorator."""
    content = _read_file("conftest.py")
    assert "pytest.fixture" in content or "pytest" in content, \
        "conftest.py should use pytest fixtures"


def test_conftest_has_sample_records():
    """conftest.py should have a sample_records fixture or equivalent."""
    content = _read_file("conftest.py")
    assert "sample_records" in content, \
        "conftest.py should define a sample_records fixture"


def test_conftest_function_scope():
    """sample_records fixture must be function-scoped (prevents mutation)."""
    content = _read_file("conftest.py")
    # Should NOT have session scope for sample_records
    # Function scope is default in pytest, so either explicit or no scope is fine
    assert "session" not in content.lower() or "sample_records" not in content.split("session")[0][-100:], \
        "sample_records should not use session scope"


def test_conftest_no_unittest_base():
    """conftest.py should not define a unittest.TestCase base class."""
    content = _read_file("conftest.py")
    assert "class BaseTestCase(unittest.TestCase)" not in content, \
        "Old BaseTestCase class should be removed from conftest.py"
