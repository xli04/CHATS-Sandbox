"""Test outputs for supervisor-to-systemd task.

Verifies systemd unit files were created correctly from supervisord config,
supervisord is stopped, and unit files contain proper translations of
restart policies, env vars, dependencies, and user settings.
"""

import os
import subprocess
import configparser


SYSTEMD_DIR = "/etc/systemd/system"


def _read_unit(name):
    path = os.path.join(SYSTEMD_DIR, name)
    with open(path) as f:
        return f.read()


def _parse_unit(name):
    """Parse a systemd unit file."""
    cfg = configparser.ConfigParser(interpolation=None)
    cfg.optionxform = str  # preserve case
    path = os.path.join(SYSTEMD_DIR, name)
    cfg.read(path)
    return cfg


def _unit_exists(name):
    return os.path.isfile(os.path.join(SYSTEMD_DIR, name))


# ── Unit files exist ──


def test_api_unit_exists():
    assert _unit_exists("myapp-api.service"), "myapp-api.service not found"


def test_worker_template_exists():
    """Worker should be a template unit for numprocs=3."""
    assert _unit_exists("myapp-worker@.service"), "myapp-worker@.service template not found"


def test_scheduler_unit_exists():
    assert _unit_exists("myapp-scheduler.service"), "myapp-scheduler.service not found"


def test_websocket_unit_exists():
    assert _unit_exists("myapp-websocket.service"), "myapp-websocket.service not found"


# ── API service ──


def test_api_exec_start():
    content = _read_unit("myapp-api.service")
    assert "server.py" in content, "API ExecStart should reference server.py"
    assert "python3" in content or "python" in content, "API should run with python"


def test_api_restart_always():
    """API had autorestart=true → Restart=always."""
    content = _read_unit("myapp-api.service")
    assert "Restart=always" in content, "API should have Restart=always"


def test_api_user():
    content = _read_unit("myapp-api.service")
    assert "User=myapp-api" in content, "API should run as myapp-api user"


def test_api_environment():
    content = _read_unit("myapp-api.service")
    assert "DATABASE_URL" in content, "API must have DATABASE_URL"
    assert "REDIS_URL" in content, "API must have REDIS_URL"
    assert "API_PORT" in content or "8080" in content, "API must have port config"


def test_api_stop_timeout():
    """API stopwaitsecs=30 → TimeoutStopSec=30."""
    content = _read_unit("myapp-api.service")
    assert "TimeoutStopSec=30" in content, "API should have TimeoutStopSec=30"


def test_api_log_routing():
    """API should route logs to /var/log/myapp/api/."""
    content = _read_unit("myapp-api.service")
    assert "/var/log/myapp/api" in content, "API should log to /var/log/myapp/api/"


# ── Worker service ──


def test_worker_restart_on_failure():
    """Worker had autorestart=unexpected → Restart=on-failure."""
    content = _read_unit("myapp-worker@.service")
    assert "Restart=on-failure" in content, "Worker should have Restart=on-failure"


def test_worker_user():
    content = _read_unit("myapp-worker@.service")
    assert "User=myapp-worker" in content, "Worker should run as myapp-worker user"


def test_worker_stop_timeout():
    """Worker stopwaitsecs=120 → TimeoutStopSec=120."""
    content = _read_unit("myapp-worker@.service")
    assert "TimeoutStopSec=120" in content, "Worker should have TimeoutStopSec=120"


def test_worker_environment():
    content = _read_unit("myapp-worker@.service")
    assert "WORKER_CONCURRENCY" in content, "Worker must have WORKER_CONCURRENCY"
    assert "WORKER_QUEUE" in content, "Worker must have WORKER_QUEUE"


def test_worker_after_api():
    """Worker (priority 30) should start after API (priority 20)."""
    content = _read_unit("myapp-worker@.service")
    assert "myapp-api.service" in content, "Worker should depend on myapp-api.service"


# ── Scheduler service ──


def test_scheduler_restart_always():
    content = _read_unit("myapp-scheduler.service")
    assert "Restart=always" in content, "Scheduler should have Restart=always"


def test_scheduler_user():
    content = _read_unit("myapp-scheduler.service")
    assert "User=myapp-scheduler" in content, "Scheduler should run as myapp-scheduler"


def test_scheduler_after_worker():
    """Scheduler (priority 40) should start after worker (priority 30)."""
    content = _read_unit("myapp-scheduler.service")
    assert "myapp-worker" in content or "myapp-api" in content, \
        "Scheduler should depend on API and/or worker services"


def test_scheduler_environment():
    content = _read_unit("myapp-scheduler.service")
    assert "SCHEDULE_INTERVAL" in content, "Scheduler must have SCHEDULE_INTERVAL"


# ── WebSocket service ──


def test_websocket_restart_always():
    content = _read_unit("myapp-websocket.service")
    assert "Restart=always" in content, "WebSocket should have Restart=always"


def test_websocket_exec_start():
    content = _read_unit("myapp-websocket.service")
    assert "gateway.js" in content, "WebSocket ExecStart should reference gateway.js"
    assert "node" in content, "WebSocket should run with node"


def test_websocket_environment():
    content = _read_unit("myapp-websocket.service")
    assert "WS_PORT" in content, "WebSocket must have WS_PORT"
    assert "WS_MAX_CONN" in content, "WebSocket must have WS_MAX_CONN"


# ── Supervisord is stopped ──


def test_supervisord_not_running():
    """supervisord should not be running after migration."""
    result = subprocess.run(
        ["pgrep", "-f", "supervisord"],
        capture_output=True, text=True
    )
    assert result.returncode != 0, "supervisord is still running"
