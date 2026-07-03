"""Test outputs for webpack-to-vite task.

Verifies the project was migrated from webpack to vite:
- vite.config.js exists with correct aliases and settings
- package.json uses vite scripts and dependencies
- npm run build produces output in dist/
"""

import json
import os
import subprocess


PROJECT_DIR = "/app/project"


def _read(path):
    with open(os.path.join(PROJECT_DIR, path)) as f:
        return f.read()


def _run(cmd):
    return subprocess.run(
        cmd, shell=True, capture_output=True, text=True, cwd=PROJECT_DIR,
    )


# ── vite.config.js tests ─────────────────────────────────

def test_vite_config_exists():
    """vite.config.js must exist."""
    assert os.path.isfile(os.path.join(PROJECT_DIR, "vite.config.js")), (
        "vite.config.js not found"
    )


def test_vite_config_has_aliases():
    """vite.config.js should define path aliases matching the webpack config."""
    content = _read("vite.config.js")
    assert "@components" in content, "Alias @components not found in vite.config.js"
    assert "@utils" in content, "Alias @utils not found in vite.config.js"
    assert "@styles" in content, "Alias @styles not found in vite.config.js"


# ── package.json tests ───────────────────────────────────

def test_package_json_build_script():
    """Build script should use vite, not webpack."""
    pkg = json.loads(_read("package.json"))
    build_cmd = pkg.get("scripts", {}).get("build", "")
    assert "vite" in build_cmd.lower(), (
        f"Build script still uses webpack: {build_cmd}"
    )
    assert "webpack" not in build_cmd.lower(), (
        f"Build script still references webpack: {build_cmd}"
    )


def test_package_json_has_vite_dependency():
    """vite should be in dependencies or devDependencies."""
    pkg = json.loads(_read("package.json"))
    all_deps = {}
    all_deps.update(pkg.get("dependencies", {}))
    all_deps.update(pkg.get("devDependencies", {}))
    assert "vite" in all_deps, "vite not found in package.json dependencies"


def test_package_json_no_webpack():
    """webpack should not be in dependencies."""
    pkg = json.loads(_read("package.json"))
    all_deps = {}
    all_deps.update(pkg.get("dependencies", {}))
    all_deps.update(pkg.get("devDependencies", {}))
    assert "webpack" not in all_deps, "webpack still in package.json dependencies"
    assert "webpack-cli" not in all_deps, "webpack-cli still in package.json dependencies"


def test_package_json_no_babel():
    """babel dependencies should be removed."""
    pkg = json.loads(_read("package.json"))
    all_deps = {}
    all_deps.update(pkg.get("dependencies", {}))
    all_deps.update(pkg.get("devDependencies", {}))
    babel_deps = [k for k in all_deps if "babel" in k.lower()]
    assert len(babel_deps) == 0, (
        f"Babel dependencies still present: {babel_deps}"
    )


# ── Build output tests ───────────────────────────────────

def test_dist_directory_exists():
    """dist/ directory should exist after build."""
    assert os.path.isdir(os.path.join(PROJECT_DIR, "dist")), (
        "dist/ directory not found — build may not have run"
    )


def test_dist_has_html():
    """dist/ should contain an HTML file."""
    dist = os.path.join(PROJECT_DIR, "dist")
    if not os.path.isdir(dist):
        assert False, "dist/ directory not found"
    files = os.listdir(dist)
    html_files = [f for f in files if f.endswith(".html")]
    assert len(html_files) > 0, "No HTML files in dist/"


def test_dist_has_js():
    """dist/ should contain JavaScript output."""
    dist = os.path.join(PROJECT_DIR, "dist")
    if not os.path.isdir(dist):
        assert False, "dist/ directory not found"
    # JS might be in dist/ or dist/assets/
    js_found = False
    for root, dirs, files in os.walk(dist):
        if any(f.endswith(".js") for f in files):
            js_found = True
            break
    assert js_found, "No JS files found in dist/"


def test_dist_has_css():
    """dist/ should contain CSS output."""
    dist = os.path.join(PROJECT_DIR, "dist")
    if not os.path.isdir(dist):
        assert False, "dist/ directory not found"
    css_found = False
    for root, dirs, files in os.walk(dist):
        if any(f.endswith(".css") for f in files):
            css_found = True
            break
    assert css_found, "No CSS files found in dist/"


def test_source_files_intact():
    """Source files should not have been deleted."""
    for path in ["src/index.js", "src/components/dashboard.js",
                 "src/utils/helpers.js", "src/styles/main.css"]:
        assert os.path.isfile(os.path.join(PROJECT_DIR, path)), (
            f"Source file {path} is missing"
        )
