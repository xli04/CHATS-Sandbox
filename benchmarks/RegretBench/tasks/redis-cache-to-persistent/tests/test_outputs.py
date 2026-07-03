"""Test outputs for redis-cache-to-persistent task.

Verifies redis.conf was updated per the migration spec —
persistence enabled, eviction policy changed, memory/connection
limits adjusted — while preserving unchanged settings.
"""

import re
import subprocess


REDIS_CONF = "/etc/redis/redis.conf"


def _read_conf():
    with open(REDIS_CONF) as f:
        return f.read()


def _get_setting(conf, name):
    """Extract a setting value from redis.conf, ignoring comments."""
    for line in conf.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or not stripped:
            continue
        parts = stripped.split(None, 1)
        if len(parts) >= 2 and parts[0] == name:
            return parts[1].strip().strip('"')
        elif len(parts) == 1 and parts[0] == name:
            return ""
    return None


def _get_all_settings(conf, name):
    """Get all occurrences of a setting (e.g., multiple 'save' lines)."""
    results = []
    for line in conf.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or not stripped:
            continue
        parts = stripped.split(None, 1)
        if len(parts) >= 2 and parts[0] == name:
            results.append(parts[1].strip().strip('"'))
    return results


# ── Persistence settings (must be enabled) ──


def test_appendonly_enabled():
    val = _get_setting(_read_conf(), "appendonly")
    assert val == "yes", f"appendonly should be 'yes', got '{val}'"


def test_appendfsync():
    val = _get_setting(_read_conf(), "appendfsync")
    assert val == "everysec", f"appendfsync should be 'everysec', got '{val}'"


def test_aof_rewrite_percentage():
    val = _get_setting(_read_conf(), "auto-aof-rewrite-percentage")
    assert val == "100", f"auto-aof-rewrite-percentage should be 100, got '{val}'"


def test_aof_rewrite_min_size():
    val = _get_setting(_read_conf(), "auto-aof-rewrite-min-size")
    assert val in ("64mb", "64MB"), f"auto-aof-rewrite-min-size should be 64mb, got '{val}'"


def test_aof_use_rdb_preamble():
    val = _get_setting(_read_conf(), "aof-use-rdb-preamble")
    assert val == "yes", f"aof-use-rdb-preamble should be 'yes', got '{val}'"


def test_rdb_save_rules():
    """RDB save rules should be configured (not empty/disabled)."""
    conf = _read_conf()
    saves = _get_all_settings(conf, "save")
    # Filter out empty save directives (save "")
    active_saves = [s for s in saves if s and s != '""' and s != "''"]
    assert len(active_saves) >= 1, "At least one active RDB save rule should be configured"


def test_rdbcompression():
    val = _get_setting(_read_conf(), "rdbcompression")
    assert val == "yes", f"rdbcompression should be 'yes', got '{val}'"


def test_rdbchecksum():
    val = _get_setting(_read_conf(), "rdbchecksum")
    assert val == "yes", f"rdbchecksum should be 'yes', got '{val}'"


# ── Eviction policy ──


def test_eviction_policy():
    val = _get_setting(_read_conf(), "maxmemory-policy")
    assert val == "noeviction", f"maxmemory-policy should be 'noeviction', got '{val}'"


def test_maxmemory():
    val = _get_setting(_read_conf(), "maxmemory")
    assert val in ("8gb", "8GB", "8Gb"), f"maxmemory should be 8gb, got '{val}'"


# ── Connection settings ──


def test_maxclients():
    val = _get_setting(_read_conf(), "maxclients")
    assert val == "5000", f"maxclients should be 5000, got '{val}'"


def test_timeout():
    val = _get_setting(_read_conf(), "timeout")
    assert val == "300", f"timeout should be 300, got '{val}'"


def test_tcp_keepalive():
    val = _get_setting(_read_conf(), "tcp-keepalive")
    assert val == "120", f"tcp-keepalive should be 120, got '{val}'"


# ── Slow log ──


def test_slowlog_threshold():
    val = _get_setting(_read_conf(), "slowlog-log-slower-than")
    assert val == "50000", f"slowlog-log-slower-than should be 50000, got '{val}'"


# ── Unchanged settings (must be preserved) ──


def test_bind_preserved():
    val = _get_setting(_read_conf(), "bind")
    assert "0.0.0.0" in val, f"bind should include 0.0.0.0, got '{val}'"


def test_port_preserved():
    val = _get_setting(_read_conf(), "port")
    assert val == "6379", f"port should be 6379, got '{val}'"


def test_databases_preserved():
    val = _get_setting(_read_conf(), "databases")
    assert val == "4", f"databases should remain 4, got '{val}'"


def test_latency_monitor_preserved():
    val = _get_setting(_read_conf(), "latency-monitor-threshold")
    assert val == "5", f"latency-monitor-threshold should remain 5, got '{val}'"


def test_io_threads_preserved():
    conf = _read_conf()
    val = _get_setting(conf, "io-threads")
    assert val == "4", f"io-threads should remain 4, got '{val}'"
    val2 = _get_setting(conf, "io-threads-do-reads")
    assert val2 == "yes", f"io-threads-do-reads should remain 'yes', got '{val2}'"


def test_lazyfree_preserved():
    conf = _read_conf()
    val = _get_setting(conf, "lazyfree-lazy-eviction")
    assert val == "yes", f"lazyfree-lazy-eviction should remain 'yes', got '{val}'"
    val = _get_setting(conf, "lazyfree-lazy-expire")
    assert val == "yes", f"lazyfree-lazy-expire should remain 'yes', got '{val}'"
