"""Test outputs for makefile-restructure task.

Verifies the Makefile has been updated to reflect the new modular
directory structure and all targets build and pass.
"""

import os
import subprocess


PROJECT_DIR = "/app/project"
BUILD_DIR = os.path.join(PROJECT_DIR, "build")
MAKEFILE = os.path.join(PROJECT_DIR, "Makefile")


def _run(cmd, cwd=PROJECT_DIR):
    return subprocess.run(
        cmd, shell=True, capture_output=True, text=True, cwd=cwd,
    )


def _read_makefile():
    with open(MAKEFILE) as f:
        return f.read()


# ── Source paths updated ─────────────────────────────────

def test_new_source_paths():
    """Makefile should reference module source directories."""
    content = _read_makefile()
    assert "modules/util/src" in content, "modules/util/src not in Makefile"
    assert "modules/crypto/src" in content, "modules/crypto/src not in Makefile"
    assert "modules/storage/src" in content, "modules/storage/src not in Makefile"
    assert "modules/network/src" in content, "modules/network/src not in Makefile"
    assert "app/src" in content, "app/src not in Makefile"


def test_no_old_src_dir():
    """Old flat src/ paths should not be used for source files."""
    content = _read_makefile()
    # Check that there's no "src/util.c" style path (old layout)
    # But "modules/util/src/util.c" is fine
    lines = content.splitlines()
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        # Old-style: bare src/util.c, src/crypto.c, etc.
        for old in ["src/util.c", "src/crypto.c", "src/storage.c",
                     "src/network.c", "src/main.c"]:
            if old in stripped and "modules/" not in stripped and "app/" not in stripped:
                assert False, f"Old source path still in Makefile: {old}"


# ── Include paths updated ────────────────────────────────

def test_per_module_includes():
    """Makefile should have -I flags for each module's include dir."""
    content = _read_makefile()
    assert "modules/util/include" in content, "Missing util include path"
    assert "modules/crypto/include" in content, "Missing crypto include path"
    assert "modules/storage/include" in content, "Missing storage include path"
    assert "modules/network/include" in content, "Missing network include path"
    assert "app/include" in content, "Missing app include path"


# ── Critical flags preserved ─────────────────────────────

def test_crypto_no_strict_aliasing():
    """Crypto module must keep -fno-strict-aliasing."""
    content = _read_makefile()
    assert "-fno-strict-aliasing" in content, (
        "-fno-strict-aliasing flag missing — crypto will have UB"
    )


def test_storage_o2():
    """Storage module must keep -O2 optimization."""
    content = _read_makefile()
    # Should have -O2 associated with storage somewhere
    lines = content.splitlines()
    found_storage_o2 = False
    for line in lines:
        if "storage" in line.lower() and "-O2" in line:
            found_storage_o2 = True
            break
        if "STORAGE" in line and "-O2" in line:
            found_storage_o2 = True
            break
    assert found_storage_o2, "Storage -O2 override not found"


def test_network_wno_unused():
    """Network module must keep -Wno-unused-parameter."""
    content = _read_makefile()
    assert "-Wno-unused-parameter" in content, (
        "-Wno-unused-parameter flag missing from network"
    )


def test_platform_detection():
    """Platform detection (uname) should be preserved."""
    content = _read_makefile()
    assert "uname" in content.lower() or "UNAME" in content, (
        "Platform detection logic missing"
    )


# ── Link order preserved ────────────────────────────────

def test_link_order():
    """Link order must be: network before storage before crypto before util."""
    content = _read_makefile()
    lines = content.splitlines()
    for line in lines:
        if "-lnetwork" in line and "-lstorage" in line and "-lcrypto" in line and "-lutil" in line:
            net_pos = line.index("-lnetwork")
            sto_pos = line.index("-lstorage")
            cry_pos = line.index("-lcrypto")
            utl_pos = line.index("-lutil")
            assert net_pos < sto_pos < cry_pos < utl_pos, (
                f"Wrong link order: network@{net_pos}, storage@{sto_pos}, "
                f"crypto@{cry_pos}, util@{utl_pos}"
            )
            return
    # If no single line has all four, that's also acceptable as long as it builds
    # (the build tests will catch actual issues)


# ── Build succeeds ───────────────────────────────────────

def test_make_all():
    """make all should succeed."""
    result = _run("make clean && make all")
    assert result.returncode == 0, (
        f"make all failed:\nstdout: {result.stdout}\nstderr: {result.stderr}"
    )


def test_app_binary_exists():
    """App binary should be produced."""
    _run("make clean && make all")
    assert os.path.isfile(os.path.join(BUILD_DIR, "app")), (
        "build/app binary not found"
    )


def test_dbctl_binary_exists():
    """dbctl tool binary should be produced."""
    _run("make clean && make all")
    assert os.path.isfile(os.path.join(BUILD_DIR, "dbctl")), (
        "build/dbctl binary not found"
    )


def test_app_runs():
    """App binary should execute successfully."""
    _run("make clean && make all")
    result = _run("./build/app")
    assert result.returncode == 0, f"app failed: {result.stderr}"
    assert "running" in result.stdout.lower(), (
        f"app output unexpected: {result.stdout}"
    )


# ── Tests pass ───────────────────────────────────────────

def test_make_test():
    """make test should build and run tests successfully."""
    _run("make clean")
    result = _run("make test")
    assert result.returncode == 0, (
        f"make test failed:\nstdout: {result.stdout}\nstderr: {result.stderr}"
    )
    # Check all tests passed
    assert "12/12 passed" in result.stdout, (
        f"Not all tests passed: {result.stdout}"
    )


# ── Makefile validity ────────────────────────────────────

def test_makefile_has_all_targets():
    """Makefile should have all required phony targets."""
    content = _read_makefile()
    for target in ["all", "libs", "app", "tools", "test", "clean"]:
        assert target in content, f"Target '{target}' missing from Makefile"
