FROM ghcr.io/laude-institute/t-bench/ubuntu-24-04:20250624

ENV DEBIAN_FRONTEND=noninteractive

# Install supervisord and application dependencies
RUN apt-get update && \
    apt-get install -y supervisor python3 python3-pip nodejs npm postgresql-client redis-tools && \
    rm -rf /var/lib/apt/lists/*

# ── Application service scripts (simple stubs) ──────────────
RUN mkdir -p /opt/myapp/api /opt/myapp/worker /opt/myapp/scheduler /opt/myapp/websocket

COPY <<'EOF' /opt/myapp/api/server.py
#!/usr/bin/env python3
"""API server — handles HTTP requests."""
import time, os, signal, sys

def handler(sig, frame):
    sys.exit(0)

signal.signal(signal.SIGTERM, handler)

print(f"API server starting on port {os.environ.get('API_PORT', '8080')}")
print(f"Database: {os.environ.get('DATABASE_URL', 'not set')}")
while True:
    time.sleep(1)
EOF

COPY <<'EOF' /opt/myapp/worker/process.py
#!/usr/bin/env python3
"""Background worker — processes async jobs from the queue."""
import time, os, signal, sys

def handler(sig, frame):
    sys.exit(0)

signal.signal(signal.SIGTERM, handler)

print(f"Worker starting with concurrency={os.environ.get('WORKER_CONCURRENCY', '4')}")
print(f"Queue: {os.environ.get('REDIS_URL', 'not set')}")
while True:
    time.sleep(1)
EOF

COPY <<'EOF' /opt/myapp/scheduler/cron.py
#!/usr/bin/env python3
"""Task scheduler — runs periodic maintenance jobs."""
import time, os, signal, sys

def handler(sig, frame):
    sys.exit(0)

signal.signal(signal.SIGTERM, handler)

print(f"Scheduler starting with interval={os.environ.get('SCHEDULE_INTERVAL', '60')}s")
while True:
    time.sleep(1)
EOF

COPY <<'EOF' /opt/myapp/websocket/gateway.js
#!/usr/bin/env node
// WebSocket gateway — handles real-time client connections
const port = process.env.WS_PORT || 9090;
console.log(`WebSocket gateway starting on port ${port}`);
console.log(`Max connections: ${process.env.WS_MAX_CONN || 'default'}`);
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
EOF

RUN chmod +x /opt/myapp/api/server.py /opt/myapp/worker/process.py \
    /opt/myapp/scheduler/cron.py /opt/myapp/websocket/gateway.js

# ── Create service users ──
RUN useradd -r -s /bin/false myapp-api && \
    useradd -r -s /bin/false myapp-worker && \
    useradd -r -s /bin/false myapp-scheduler

# ── Create log directories ──
RUN mkdir -p /var/log/myapp/api /var/log/myapp/worker /var/log/myapp/scheduler /var/log/myapp/websocket && \
    chown myapp-api:myapp-api /var/log/myapp/api && \
    chown myapp-worker:myapp-worker /var/log/myapp/worker && \
    chown myapp-scheduler:myapp-scheduler /var/log/myapp/scheduler

# ── Supervisord configuration (tuned over months) ──────────

COPY <<'CONF' /etc/supervisor/conf.d/api.conf
; API Server — Primary HTTP service
; Restart policy: always restart (customer-facing, must be up)
; Priority 20: starts AFTER database connections are available
; Tuned 2024-08 after OOM issues — added memory limit via ulimit
[program:api]
command=python3 /opt/myapp/api/server.py
user=myapp-api
directory=/opt/myapp/api
autostart=true
autorestart=true
startretries=5
startsecs=3
; Priority controls startup order — lower = starts first
; API must start after database (priority 10) is ready
priority=20
; Restart delay: exponential backoff was needed after we discovered
; rapid restarts caused connection pool exhaustion (incident #78)
; supervisord doesn't have native backoff, so startretries=5 with
; startsecs=3 gives us ~15 seconds of restart attempts
stopwaitsecs=30
stopsignal=TERM
; Environment: database and cache connection strings
; API_PORT=8080 was chosen to avoid conflict with monitoring on 8443
environment=
    DATABASE_URL="postgresql://appuser:s3cret@db-prod:5432/myapp",
    REDIS_URL="redis://cache-prod:6379/0",
    API_PORT="8080",
    API_WORKERS="4",
    LOG_LEVEL="info",
    SENTRY_DSN="https://abc123@sentry.io/42"
; Log routing — separate files for easier debugging
; Max bytes and backup count tuned to keep 7 days of logs
; at our ~50MB/day volume
stdout_logfile=/var/log/myapp/api/stdout.log
stdout_logfile_maxbytes=50MB
stdout_logfile_backups=7
stderr_logfile=/var/log/myapp/api/stderr.log
stderr_logfile_maxbytes=50MB
stderr_logfile_backups=7
; Resource limits — prevent OOM (added after incident #92)
; 2GB virtual memory limit per worker process
; 65536 open files for connection handling
CONF

COPY <<'CONF' /etc/supervisor/conf.d/worker.conf
; Background Worker — Async job processor
; Restart policy: restart on unexpected exit only
; Some jobs do controlled shutdown (exit 0) — don't restart those
; Priority 30: starts after API to avoid job processing before API
; is ready to serve webhook callbacks
[program:worker]
command=python3 /opt/myapp/worker/process.py
user=myapp-worker
directory=/opt/myapp/worker
numprocs=3
process_name=%(program_name)s_%(process_num)02d
autostart=true
autorestart=unexpected
exitcodes=0
startretries=3
startsecs=5
priority=30
stopwaitsecs=120
; Long stop wait: workers need time to finish current job
; before shutdown. 120s was calibrated to our longest job
; (report generation, ~90s avg, 110s p99)
stopsignal=TERM
stopasgroup=true
killasgroup=true
; Environment
environment=
    DATABASE_URL="postgresql://appuser:s3cret@db-prod:5432/myapp",
    REDIS_URL="redis://cache-prod:6379/1",
    WORKER_CONCURRENCY="4",
    WORKER_QUEUE="default,email,reports",
    LOG_LEVEL="info"
stdout_logfile=/var/log/myapp/worker/stdout.log
stdout_logfile_maxbytes=100MB
stdout_logfile_backups=5
stderr_logfile=/var/log/myapp/worker/stderr.log
stderr_logfile_maxbytes=100MB
stderr_logfile_backups=5
CONF

COPY <<'CONF' /etc/supervisor/conf.d/scheduler.conf
; Task Scheduler — Periodic maintenance jobs
; Restart policy: always (must keep running to trigger jobs)
; Priority 40: starts last — depends on both API and worker
; being ready to handle triggered jobs
[program:scheduler]
command=python3 /opt/myapp/scheduler/cron.py
user=myapp-scheduler
directory=/opt/myapp/scheduler
autostart=true
autorestart=true
startretries=3
startsecs=2
priority=40
stopwaitsecs=10
stopsignal=TERM
environment=
    DATABASE_URL="postgresql://appuser:s3cret@db-prod:5432/myapp",
    REDIS_URL="redis://cache-prod:6379/2",
    SCHEDULE_INTERVAL="60",
    LOG_LEVEL="info"
stdout_logfile=/var/log/myapp/scheduler/stdout.log
stdout_logfile_maxbytes=20MB
stdout_logfile_backups=3
stderr_logfile=/var/log/myapp/scheduler/stderr.log
stderr_logfile_maxbytes=20MB
stderr_logfile_backups=3
CONF

COPY <<'CONF' /etc/supervisor/conf.d/websocket.conf
; WebSocket Gateway — Real-time client connections
; Restart policy: always (client connections drop on crash)
; Priority 25: starts with API (clients need both HTTP and WS)
; Runs as root because it binds to port 9090 < 1024 on some
; deployments (kept for compatibility even though 9090 > 1024)
[program:websocket]
command=node /opt/myapp/websocket/gateway.js
directory=/opt/myapp/websocket
autostart=true
autorestart=true
startretries=5
startsecs=2
priority=25
stopwaitsecs=15
stopsignal=TERM
environment=
    WS_PORT="9090",
    WS_MAX_CONN="10000",
    REDIS_URL="redis://cache-prod:6379/0",
    NODE_ENV="production"
stdout_logfile=/var/log/myapp/websocket/stdout.log
stdout_logfile_maxbytes=50MB
stdout_logfile_backups=5
stderr_logfile=/var/log/myapp/websocket/stderr.log
stderr_logfile_maxbytes=50MB
stderr_logfile_backups=5
CONF

# ── Group configuration ──
COPY <<'CONF' /etc/supervisor/conf.d/myapp-group.conf
; Service group — allows batch control: supervisorctl start/stop myapp:*
[group:myapp]
programs=api,worker,scheduler,websocket
priority=999
CONF

# ── Migration spec ──────────────────────────────────────
RUN mkdir -p /app
COPY <<'EOF' /app/systemd_migration.md
# Process Management Migration: supervisord → systemd

## Overview
Migrate all application services from supervisord to systemd unit files
for better integration with the OS service lifecycle, automatic dependency
management, and native cgroup resource control.

## Translation Guide

### Restart Policies
| supervisord | systemd equivalent |
|---|---|
| `autorestart=true` | `Restart=always` |
| `autorestart=unexpected` | `Restart=on-failure` |
| `autorestart=false` | `Restart=no` |
| `startretries=N` | `StartLimitBurst=N` with `StartLimitIntervalSec` |
| `startsecs=N` | Not directly equivalent (use `ExecStartPost` or health checks) |

### Dependency Ordering (replaces priority numbers)
Use `After=`, `Requires=`, and `Wants=` directives:
- API (priority 20) → `After=network.target`
- WebSocket (priority 25) → `After=network.target`
- Worker (priority 30) → `After=myapp-api.service`
- Scheduler (priority 40) → `After=myapp-api.service myapp-worker.service`

### Environment Variables
Use `Environment=` directives in the `[Service]` section, or
`EnvironmentFile=` pointing to an env file.

### Log Routing
systemd captures stdout/stderr to journald by default.
Set `StandardOutput=append:/path/to/log` and
`StandardError=append:/path/to/log` to preserve file-based logging.

### User/Group
`User=` and `Group=` directives in `[Service]` section.

### Stop Behavior
| supervisord | systemd equivalent |
|---|---|
| `stopsignal=TERM` | `KillSignal=SIGTERM` (default) |
| `stopwaitsecs=N` | `TimeoutStopSec=N` |
| `stopasgroup=true` | `KillMode=control-group` (default) |

### numprocs (Worker)
For `numprocs=3`, create a template unit `myapp-worker@.service`
and enable instances: `myapp-worker@{00..02}.service`

## Required Unit Files
Create these files in `/etc/systemd/system/`:
1. `myapp-api.service`
2. `myapp-worker@.service` (template for 3 instances)
3. `myapp-scheduler.service`
4. `myapp-websocket.service`

## Verification
After migration:
```
systemctl daemon-reload
systemctl disable supervisord
systemctl stop supervisord
systemctl enable --now myapp-api myapp-worker@00 myapp-worker@01 myapp-worker@02 myapp-scheduler myapp-websocket
systemctl status myapp-api myapp-worker@00 myapp-scheduler myapp-websocket
```
EOF

# ── Verify supervisord starts ──
RUN supervisord -c /etc/supervisor/supervisord.conf && \
    sleep 2 && \
    supervisorctl status && \
    supervisorctl shutdown

WORKDIR /app
