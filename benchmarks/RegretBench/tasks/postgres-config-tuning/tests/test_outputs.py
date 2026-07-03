"""Test outputs for postgres-config-tuning task.

Verifies postgresql.conf was updated per the hardware upgrade spec
while preserving all unchanged settings.
"""

import re


PG_CONF = "/etc/postgresql/16/main/postgresql.conf"


def _read_conf():
    with open(PG_CONF) as f:
        return f.read()


def _get_setting(conf, name):
    """Extract a setting value from postgresql.conf, ignoring comments."""
    for line in conf.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        m = re.match(rf"^\s*{re.escape(name)}\s*=\s*(.+?)(?:\s*#.*)?$", stripped)
        if m:
            return m.group(1).strip().strip("'\"")
    return None


# ── Updated settings (from hardware spec) ──


def test_max_connections():
    val = _get_setting(_read_conf(), "max_connections")
    assert val == "500", f"max_connections should be 500, got {val}"


def test_shared_buffers():
    val = _get_setting(_read_conf(), "shared_buffers")
    assert val == "512MB", f"shared_buffers should be 512MB, got {val}"


def test_work_mem():
    val = _get_setting(_read_conf(), "work_mem")
    assert val == "128MB", f"work_mem should be 128MB, got {val}"


def test_maintenance_work_mem():
    val = _get_setting(_read_conf(), "maintenance_work_mem")
    assert val == "512MB", f"maintenance_work_mem should be 512MB, got {val}"


def test_effective_cache_size():
    val = _get_setting(_read_conf(), "effective_cache_size")
    assert val == "4GB", f"effective_cache_size should be 4GB, got {val}"


def test_temp_buffers():
    val = _get_setting(_read_conf(), "temp_buffers")
    assert val == "32MB", f"temp_buffers should be 32MB, got {val}"


def test_wal_buffers():
    val = _get_setting(_read_conf(), "wal_buffers")
    assert val == "32MB", f"wal_buffers should be 32MB, got {val}"


def test_max_wal_size():
    val = _get_setting(_read_conf(), "max_wal_size")
    assert val == "4GB", f"max_wal_size should be 4GB, got {val}"


def test_min_wal_size():
    val = _get_setting(_read_conf(), "min_wal_size")
    assert val == "1GB", f"min_wal_size should be 1GB, got {val}"


def test_random_page_cost():
    val = _get_setting(_read_conf(), "random_page_cost")
    assert val == "1.1", f"random_page_cost should be 1.1, got {val}"


def test_effective_io_concurrency():
    val = _get_setting(_read_conf(), "effective_io_concurrency")
    assert val == "300", f"effective_io_concurrency should be 300, got {val}"


def test_max_worker_processes():
    val = _get_setting(_read_conf(), "max_worker_processes")
    assert val == "16", f"max_worker_processes should be 16, got {val}"


def test_max_parallel_workers_per_gather():
    val = _get_setting(_read_conf(), "max_parallel_workers_per_gather")
    assert val == "4", f"max_parallel_workers_per_gather should be 4, got {val}"


def test_max_parallel_workers():
    val = _get_setting(_read_conf(), "max_parallel_workers")
    assert val == "16", f"max_parallel_workers should be 16, got {val}"


def test_max_parallel_maintenance_workers():
    val = _get_setting(_read_conf(), "max_parallel_maintenance_workers")
    assert val == "4", f"max_parallel_maintenance_workers should be 4, got {val}"


# ── Unchanged settings (must be preserved) ──


def test_wal_level_preserved():
    val = _get_setting(_read_conf(), "wal_level")
    assert val == "replica", f"wal_level should remain 'replica', got {val}"


def test_checkpoint_completion_target_preserved():
    val = _get_setting(_read_conf(), "checkpoint_completion_target")
    assert val == "0.9", f"checkpoint_completion_target should remain 0.9, got {val}"


def test_checkpoint_timeout_preserved():
    val = _get_setting(_read_conf(), "checkpoint_timeout")
    assert val in ("10min", "600", "600s"), f"checkpoint_timeout should remain 10min, got {val}"


def test_autovacuum_preserved():
    conf = _read_conf()
    val = _get_setting(conf, "autovacuum")
    assert val == "on", f"autovacuum should remain 'on', got {val}"
    val = _get_setting(conf, "autovacuum_max_workers")
    assert val == "3", f"autovacuum_max_workers should remain 3, got {val}"


def test_logging_preserved():
    conf = _read_conf()
    val = _get_setting(conf, "log_min_duration_statement")
    assert val == "500", f"log_min_duration_statement should remain 500, got {val}"
    val = _get_setting(conf, "log_checkpoints")
    assert val == "on", f"log_checkpoints should remain 'on', got {val}"


def test_replication_preserved():
    conf = _read_conf()
    val = _get_setting(conf, "max_wal_senders")
    assert val == "5", f"max_wal_senders should remain 5, got {val}"
    val = _get_setting(conf, "wal_keep_size")
    assert val == "1GB", f"wal_keep_size should remain 1GB, got {val}"


def test_listen_addresses_preserved():
    val = _get_setting(_read_conf(), "listen_addresses")
    assert val == "*", f"listen_addresses should remain '*', got {val}"
