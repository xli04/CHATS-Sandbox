FROM ghcr.io/laude-institute/t-bench/ubuntu-24-04:20250624

RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --break-system-packages tox tox-gh-actions coverage nose2 pytest pytest-cov pytest-timeout pytest-xdist

# ── Project source code ──────────────────────────────────
RUN mkdir -p /app/project/src/dataforge /app/project/tests/unit /app/project/tests/integration

# Main package — a data processing library
COPY <<'EOF' /app/project/src/dataforge/__init__.py
"""DataForge — a data processing and validation library."""
__version__ = "2.4.1"
EOF

COPY <<'EOF' /app/project/src/dataforge/pipeline.py
"""Data processing pipeline with validation stages."""

class ValidationError(Exception):
    """Raised when data fails validation."""
    pass


class Pipeline:
    """Multi-stage data processing pipeline."""

    def __init__(self, strict=False):
        self.strict = strict
        self._stages = []
        self._results = []

    def add_stage(self, name, fn):
        self._stages.append({"name": name, "fn": fn})

    def run(self, data):
        self._results = []
        current = data
        for stage in self._stages:
            try:
                current = stage["fn"](current)
                self._results.append({
                    "stage": stage["name"],
                    "status": "ok",
                    "record_count": len(current) if hasattr(current, '__len__') else 1
                })
            except Exception as e:
                if self.strict:
                    raise ValidationError(f"Stage '{stage['name']}' failed: {e}")
                self._results.append({
                    "stage": stage["name"],
                    "status": "error",
                    "error": str(e)
                })
                break
        return current

    @property
    def results(self):
        return list(self._results)

    @property
    def stage_count(self):
        return len(self._stages)
EOF

COPY <<'EOF' /app/project/src/dataforge/transform.py
"""Data transformation utilities."""

def normalize_records(records, key_map=None):
    """Normalize record keys to lowercase with optional remapping."""
    key_map = key_map or {}
    normalized = []
    for record in records:
        new_record = {}
        for k, v in record.items():
            new_key = key_map.get(k, k.lower().replace(" ", "_"))
            new_record[new_key] = v
        normalized.append(new_record)
    return normalized


def filter_records(records, predicate):
    """Filter records using a predicate function."""
    return [r for r in records if predicate(r)]


def aggregate(records, group_key, value_key, fn=sum):
    """Group records by key and aggregate values."""
    groups = {}
    for r in records:
        gk = r.get(group_key)
        if gk not in groups:
            groups[gk] = []
        groups[gk].append(r.get(value_key, 0))
    return {k: fn(v) for k, v in groups.items()}


def deduplicate(records, key):
    """Remove duplicate records based on a key field."""
    seen = set()
    result = []
    for r in records:
        val = r.get(key)
        if val not in seen:
            seen.add(val)
            result.append(r)
    return result
EOF

COPY <<'EOF' /app/project/src/dataforge/cache.py
"""Simple in-memory cache with TTL support."""

import time


class Cache:
    """Thread-unsafe cache for single-process use."""

    def __init__(self, default_ttl=300):
        self.default_ttl = default_ttl
        self._store = {}

    def get(self, key):
        if key in self._store:
            entry = self._store[key]
            if entry["expires"] > time.time():
                return entry["value"]
            else:
                del self._store[key]
        return None

    def set(self, key, value, ttl=None):
        self._store[key] = {
            "value": value,
            "expires": time.time() + (ttl or self.default_ttl)
        }

    def delete(self, key):
        self._store.pop(key, None)

    def clear(self):
        self._store.clear()

    @property
    def size(self):
        # Prune expired entries
        now = time.time()
        self._store = {
            k: v for k, v in self._store.items() if v["expires"] > now
        }
        return len(self._store)
EOF

# ── Unit tests (currently unittest style) ──────────────────

COPY <<'EOF' /app/project/tests/__init__.py
EOF

COPY <<'EOF' /app/project/tests/unit/__init__.py
EOF

COPY <<'EOF' /app/project/tests/unit/test_pipeline.py
"""Tests for the data processing pipeline."""

import unittest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../src'))

from dataforge.pipeline import Pipeline, ValidationError


class TestPipelineBasic(unittest.TestCase):
    """Basic pipeline functionality tests."""

    def setUp(self):
        self.pipeline = Pipeline()

    def test_empty_pipeline(self):
        result = self.pipeline.run([1, 2, 3])
        self.assertEqual(result, [1, 2, 3])

    def test_single_stage(self):
        self.pipeline.add_stage("double", lambda x: [i * 2 for i in x])
        result = self.pipeline.run([1, 2, 3])
        self.assertEqual(result, [2, 4, 6])

    def test_multiple_stages(self):
        self.pipeline.add_stage("double", lambda x: [i * 2 for i in x])
        self.pipeline.add_stage("filter", lambda x: [i for i in x if i > 3])
        result = self.pipeline.run([1, 2, 3])
        self.assertEqual(result, [4, 6])

    def test_results_tracking(self):
        self.pipeline.add_stage("pass", lambda x: x)
        self.pipeline.run([1, 2, 3])
        self.assertEqual(len(self.pipeline.results), 1)
        self.assertEqual(self.pipeline.results[0]["status"], "ok")

    def test_stage_count(self):
        self.pipeline.add_stage("a", lambda x: x)
        self.pipeline.add_stage("b", lambda x: x)
        self.assertEqual(self.pipeline.stage_count, 2)


class TestPipelineStrict(unittest.TestCase):
    """Tests for strict mode error handling."""

    def setUp(self):
        self.pipeline = Pipeline(strict=True)

    def test_strict_raises_on_error(self):
        self.pipeline.add_stage("bad", lambda x: 1/0)
        with self.assertRaises(ValidationError):
            self.pipeline.run([1])

    def test_non_strict_continues(self):
        p = Pipeline(strict=False)
        p.add_stage("bad", lambda x: 1/0)
        p.run([1])
        self.assertEqual(p.results[0]["status"], "error")


if __name__ == '__main__':
    unittest.main()
EOF

COPY <<'EOF' /app/project/tests/unit/test_transform.py
"""Tests for data transformation utilities."""

import unittest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../src'))

from dataforge.transform import (
    normalize_records, filter_records, aggregate, deduplicate
)


class TestNormalize(unittest.TestCase):

    def setUp(self):
        self.records = [
            {"First Name": "Alice", "Last Name": "Smith", "Age": 30},
            {"First Name": "Bob", "Last Name": "Jones", "Age": 25},
        ]

    def test_default_normalization(self):
        result = normalize_records(self.records)
        self.assertIn("first_name", result[0])
        self.assertIn("last_name", result[0])

    def test_custom_key_map(self):
        key_map = {"First Name": "given_name"}
        result = normalize_records(self.records, key_map=key_map)
        self.assertIn("given_name", result[0])

    def test_preserves_values(self):
        result = normalize_records(self.records)
        self.assertEqual(result[0]["first_name"], "Alice")
        self.assertEqual(result[1]["age"], 25)


class TestFilter(unittest.TestCase):

    def test_basic_filter(self):
        records = [{"val": 1}, {"val": 2}, {"val": 3}]
        result = filter_records(records, lambda r: r["val"] > 1)
        self.assertEqual(len(result), 2)

    def test_empty_result(self):
        records = [{"val": 1}]
        result = filter_records(records, lambda r: r["val"] > 10)
        self.assertEqual(result, [])


class TestAggregate(unittest.TestCase):

    def setUp(self):
        self.records = [
            {"dept": "eng", "salary": 100},
            {"dept": "eng", "salary": 120},
            {"dept": "sales", "salary": 80},
        ]

    def test_sum_aggregation(self):
        result = aggregate(self.records, "dept", "salary")
        self.assertEqual(result["eng"], 220)
        self.assertEqual(result["sales"], 80)

    def test_custom_aggregation(self):
        result = aggregate(self.records, "dept", "salary", fn=max)
        self.assertEqual(result["eng"], 120)


class TestDeduplicate(unittest.TestCase):

    def test_removes_duplicates(self):
        records = [
            {"id": 1, "name": "a"},
            {"id": 2, "name": "b"},
            {"id": 1, "name": "c"},
        ]
        result = deduplicate(records, "id")
        self.assertEqual(len(result), 2)

    def test_keeps_first(self):
        records = [
            {"id": 1, "name": "first"},
            {"id": 1, "name": "second"},
        ]
        result = deduplicate(records, "id")
        self.assertEqual(result[0]["name"], "first")


if __name__ == '__main__':
    unittest.main()
EOF

COPY <<'EOF' /app/project/tests/unit/test_cache.py
"""Tests for the caching module."""

import unittest
import time
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../src'))

from dataforge.cache import Cache


class TestCacheBasic(unittest.TestCase):

    def setUp(self):
        self.cache = Cache(default_ttl=10)

    def test_set_and_get(self):
        self.cache.set("key1", "value1")
        self.assertEqual(self.cache.get("key1"), "value1")

    def test_get_missing_key(self):
        self.assertIsNone(self.cache.get("nonexistent"))

    def test_delete(self):
        self.cache.set("key1", "value1")
        self.cache.delete("key1")
        self.assertIsNone(self.cache.get("key1"))

    def test_clear(self):
        self.cache.set("a", 1)
        self.cache.set("b", 2)
        self.cache.clear()
        self.assertEqual(self.cache.size, 0)

    def test_size(self):
        self.cache.set("a", 1)
        self.cache.set("b", 2)
        self.assertEqual(self.cache.size, 2)


class TestCacheTTL(unittest.TestCase):
    """Tests for TTL expiration — these are slow integration-style tests."""

    def setUp(self):
        self.cache = Cache(default_ttl=1)

    def test_expired_entry_returns_none(self):
        self.cache.set("key", "val", ttl=0.1)
        time.sleep(0.2)
        self.assertIsNone(self.cache.get("key"))

    def test_custom_ttl(self):
        self.cache.set("key", "val", ttl=10)
        self.assertIsNotNone(self.cache.get("key"))


if __name__ == '__main__':
    unittest.main()
EOF

# ── Integration tests ──────────────────────────────────────

COPY <<'EOF' /app/project/tests/integration/__init__.py
EOF

COPY <<'EOF' /app/project/tests/integration/test_pipeline_integration.py
"""Integration tests for end-to-end pipeline processing."""

import unittest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../src'))

from dataforge.pipeline import Pipeline
from dataforge.transform import normalize_records, filter_records, aggregate
from dataforge.cache import Cache


class TestPipelineWithTransforms(unittest.TestCase):
    """End-to-end pipeline tests with real transforms."""

    def setUp(self):
        self.data = [
            {"Name": "Alice", "Dept": "eng", "Salary": 100},
            {"Name": "Bob", "Dept": "eng", "Salary": 120},
            {"Name": "Carol", "Dept": "sales", "Salary": 80},
            {"Name": "Dave", "Dept": "sales", "Salary": 90},
        ]

    def test_normalize_and_filter(self):
        p = Pipeline()
        p.add_stage("normalize", normalize_records)
        p.add_stage("filter_eng", lambda recs: filter_records(
            recs, lambda r: r.get("dept") == "eng"
        ))
        result = p.run(self.data)
        self.assertEqual(len(result), 2)
        self.assertTrue(all(r["dept"] == "eng" for r in result))

    def test_full_pipeline(self):
        p = Pipeline()
        p.add_stage("normalize", normalize_records)
        p.add_stage("filter", lambda recs: filter_records(
            recs, lambda r: r.get("salary", 0) > 85
        ))
        result = p.run(self.data)
        self.assertEqual(len(result), 3)
        self.assertEqual(len(p.results), 2)


class TestPipelineWithCache(unittest.TestCase):
    """Tests that pipeline results can be cached."""

    def setUp(self):
        self.cache = Cache(default_ttl=60)

    def test_cache_pipeline_results(self):
        p = Pipeline()
        p.add_stage("identity", lambda x: x)
        result = p.run([1, 2, 3])
        self.cache.set("pipeline_result", result)
        self.assertEqual(self.cache.get("pipeline_result"), [1, 2, 3])


if __name__ == '__main__':
    unittest.main()
EOF

# ── Current test config files (unittest/nose2 based, refined over months) ──

COPY <<'CONF' /app/project/setup.cfg
[metadata]
name = dataforge
version = 2.4.1
description = Data processing and validation library

[options]
package_dir =
    = src
packages = find:
python_requires = >=3.9

[options.packages.find]
where = src

[tool:nose2]
# Test discovery refined after CI failures with conftest import collisions
# Do NOT change test-file-pattern — the integration tests rely on this
# to avoid picking up helper modules in tests/integration/helpers/
test-file-pattern = test_*.py
test-method-prefix = test
# Explicitly list test directories to prevent cross-contamination
# between unit and integration test fixtures (learned the hard way
# after 3 days debugging shared state issues in CI, 2024-06)
start-dir = tests
# Plugin settings tuned for our CI environment
plugins = nose2.plugins.junitxml
          nose2.plugins.attribs

[tool:nose2:junit-xml]
# CI dashboard reads this file — path must match Jenkins config
path = test-results/junit.xml
always-on = true

[tool:nose2:coverage]
# Coverage threshold negotiated with team — 85% was agreed upon in
# sprint retro 2024-08-15 after discussion about diminishing returns
# of chasing 90%+ on integration tests
always-on = true
coverage = src/dataforge
coverage-report = term-missing
coverage-config = .coveragerc

[coverage:run]
source = src/dataforge
branch = true
# Omit cache module from branch coverage — TTL-dependent branches
# are non-deterministic in CI and caused 12 flaky builds before
# we added this exclusion (issue #247)
omit =
    src/dataforge/cache.py

[coverage:report]
# 85% threshold — see team agreement in sprint retro notes
fail_under = 85
show_missing = true
exclude_lines =
    pragma: no cover
    def __repr__
    if __name__ == .__main__
    raise NotImplementedError
CONF

COPY <<'CONF' /app/project/tox.ini
# Tox configuration — last major update 2024-09
# WARNING: Test ordering matters! Unit tests must run before integration
# to avoid database fixture teardown issues (see incident #189)

[tox]
envlist = py{39,310,311,312,313}-{unit,integration}, lint, coverage
isolated_build = True
# Skip missing interpreters in local dev — CI has all versions
skip_missing_interpreters = True

[testenv]
deps =
    nose2
    coverage
    nose2[coverage_plugin]
commands =
    # Run nose2 with unittest discovery
    unit: nose2 --start-dir tests/unit --plugin nose2.plugins.junitxml --junit-xml {toxworkdir}/results/unit-{basepython}.xml -v
    integration: nose2 --start-dir tests/integration --plugin nose2.plugins.junitxml --junit-xml {toxworkdir}/results/integration-{basepython}.xml -v

# Timeout settings — integration tests hit external services
# Default 300s was too short for the database fixture setup on
# underpowered CI runners (m5.large). Bumped to 600s after
# timeout failures on 2024-07-22
setenv =
    PYTHONPATH = {toxinidir}/src
    DATAFORGE_TEST_MODE = 1
    unit: TEST_TIMEOUT = 30
    integration: TEST_TIMEOUT = 600

[testenv:lint]
deps =
    ruff
commands =
    ruff check src/ tests/

[testenv:coverage]
deps =
    nose2
    coverage
    nose2[coverage_plugin]
commands =
    # Combined coverage from both test suites
    # The --with-coverage flag was added after we realized nose2
    # wasn't collecting branch coverage by default (issue #203)
    coverage run -m nose2 --start-dir tests -v
    coverage report --fail-under=85
    coverage html -d {toxworkdir}/htmlcov
setenv =
    PYTHONPATH = {toxinidir}/src
    DATAFORGE_TEST_MODE = 1
CONF

COPY <<'CONF' /app/project/conftest.py
"""
Root conftest — shared test fixtures and configuration.

IMPORTANT NOTES (from debugging sessions):
- The sample_records fixture MUST use function scope, not session scope.
  Session scope caused test pollution when test_transform modified records
  in-place (took 2 days to debug, 2024-06-14).
- The pipeline_factory fixture creates fresh Pipeline instances to avoid
  shared state between tests. Do NOT change to session scope.
- The cache fixture uses a short TTL (1s) for tests — the default 300s
  caused integration tests to pass locally but fail in CI because
  cached values leaked between test classes.
"""

import unittest
import sys
import os

# Ensure src is on path for all test discovery methods
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))


# ── Shared test data ──
# Used by both unit and integration tests
SAMPLE_RECORDS = [
    {"Name": "Alice", "Dept": "engineering", "Salary": 95000, "Active": True},
    {"Name": "Bob", "Dept": "engineering", "Salary": 102000, "Active": True},
    {"Name": "Carol", "Dept": "sales", "Salary": 78000, "Active": False},
    {"Name": "Dave", "Dept": "sales", "Salary": 85000, "Active": True},
    {"Name": "Eve", "Dept": "engineering", "Salary": 115000, "Active": True},
]


class BaseTestCase(unittest.TestCase):
    """Base test class with common setup for all DataForge tests.

    All test classes should inherit from this instead of unittest.TestCase
    to get consistent fixture behavior. This was introduced after
    discovering that setUp/tearDown ordering differed between nose2
    and raw unittest when using class-level fixtures (2024-07-01).
    """

    @classmethod
    def setUpClass(cls):
        """Class-level setup — runs once per test class."""
        cls._original_path = sys.path.copy()

    @classmethod
    def tearDownClass(cls):
        """Restore sys.path to prevent test pollution."""
        sys.path = cls._original_path

    def get_sample_records(self):
        """Return a fresh copy of sample records (prevents mutation issues)."""
        import copy
        return copy.deepcopy(SAMPLE_RECORDS)

    def get_fresh_pipeline(self, strict=False):
        """Create a fresh Pipeline instance."""
        from dataforge.pipeline import Pipeline
        return Pipeline(strict=strict)

    def get_fresh_cache(self, ttl=1):
        """Create a fresh Cache with short TTL for testing.

        TTL=1s prevents leaked cache entries between tests.
        The default 300s caused 8 flaky test failures in CI
        before this was changed (issue #234).
        """
        from dataforge.cache import Cache
        return Cache(default_ttl=ttl)
CONF

# ── Migration spec ──────────────────────────────────────
COPY <<'EOF' /app/pytest_migration.md
# Test Framework Migration: unittest/nose2 → pytest

## Overview
Migrate from unittest + nose2 test runner to pytest for better
fixture management, plugin ecosystem, and cleaner test syntax.

## Changes Required

### 1. setup.cfg
Remove all `[tool:nose2]` sections and replace with pytest configuration:

```ini
[tool:pytest]
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
addopts = --strict-markers --tb=short -v
markers =
    slow: marks tests as slow (deselect with '-m "not slow"')
    integration: marks integration tests
```

Keep the `[coverage:run]` and `[coverage:report]` sections unchanged —
pytest-cov reads the same coverage config format.

### 2. tox.ini
Replace nose2 commands with pytest:

```ini
[testenv]
deps =
    pytest
    pytest-cov
    pytest-timeout
    pytest-xdist
commands =
    unit: pytest tests/unit/ --junitxml={toxworkdir}/results/unit-{basepython}.xml --timeout=30 -v
    integration: pytest tests/integration/ --junitxml={toxworkdir}/results/integration-{basepython}.xml --timeout=600 -v

[testenv:coverage]
deps =
    pytest
    pytest-cov
commands =
    pytest tests/ --cov=src/dataforge --cov-branch --cov-report=term-missing --cov-report=html:{toxworkdir}/htmlcov --cov-fail-under=85 -v
```

Keep the `envlist`, `isolated_build`, `skip_missing_interpreters`,
and all `setenv` blocks unchanged.

### 3. conftest.py
Convert to pytest fixture style:

- Replace `BaseTestCase` class and `get_*` helper methods with
  pytest fixtures using `@pytest.fixture`
- `sample_records` → function-scoped fixture returning deep copy
  (MUST remain function scope — see original comment about mutation)
- `pipeline_factory` → function-scoped fixture returning a factory function
- `fresh_cache` → function-scoped fixture with ttl=1

The test files themselves (test_pipeline.py, test_transform.py, etc.)
do NOT need to be rewritten — pytest natively runs unittest.TestCase
classes. Only the configuration and conftest need to change.

### 4. Verification
After updating, run:
```
tox -e py313-unit
tox -e py313-integration
tox -e coverage
```
All tests should pass and coverage should meet the 85% threshold.
EOF

# ── Create tox working directory structure ──
RUN mkdir -p /app/project/test-results

# ── Verify tests pass with current unittest setup ──
WORKDIR /app/project
RUN PYTHONPATH=src python -m pytest tests/ -v --tb=short 2>&1 | tail -5 || true

WORKDIR /app/project
