FROM ghcr.io/laude-institute/t-bench/ubuntu-24-04:20250624

ENV DEBIAN_FRONTEND=noninteractive

# Install Redis
RUN apt-get update && \
    apt-get install -y redis-server redis-tools && \
    rm -rf /var/lib/apt/lists/*

# ── Custom redis.conf (tuned for volatile cache workload) ──
COPY <<'CONF' /etc/redis/redis.conf
# Redis Configuration — Production Cache Server
# Instance: cache-prod-01 (16 GB RAM, 8 vCPU)
# Last reviewed: 2024-10-15 by platform team
#
# IMPORTANT: This configuration was tuned over 4 months of production
# monitoring for volatile cache use. Eviction policy and memory limits
# were tested under sustained 50K ops/sec load. Do not change without
# reviewing the performance dashboard in Grafana.

################################## NETWORK ##################################

# Bind to all interfaces — firewall handles access control
bind 0.0.0.0
port 6379
protected-mode no

# TCP backlog — increased from default 511 after connection storms
# during peak hours caused ECONNREFUSED errors (2024-07-08)
tcp-backlog 1024

# Timeout: 0 means keep connections open indefinitely
# Changed from 300s after app connection pool reported false timeouts
# during long-running Lua scripts (incident #156, 2024-08-22)
timeout 0

# TCP keepalive — 60s interval prevents firewall from dropping idle
# connections while avoiding excessive keepalive traffic
tcp-keepalive 60

################################## GENERAL ##################################

daemonize no
pidfile /var/run/redis/redis-server.pid
loglevel notice
logfile /var/log/redis/redis-server.log

# Database count — only db0 is used in production, but keeping 4
# for staging/testing key isolation
databases 4

################################## MEMORY ###################################

# maxmemory: 12GB of 16GB total — leaves 4GB for OS, Redis overhead,
# and fork() during background saves (if ever enabled)
# Calibrated after OOM kill on 2024-06-30 when set to 14GB
# (fork() for BGSAVE doubled memory briefly)
maxmemory 12gb

# Eviction policy: allkeys-lru
# Tested allkeys-lru vs volatile-lru vs allkeys-lfu over 2 weeks
# in staging. allkeys-lru won: 94.2% hit rate vs 91.8% (lfu)
# and 89.1% (volatile-lru). See Confluence page "Cache Eviction
# Benchmark Results 2024-08"
maxmemory-policy allkeys-lru

# LRU sample size — 10 gives good approximation without CPU overhead
# Default 5 was causing premature eviction of hot keys under high load
maxmemory-samples 10

################################# CONNECTIONS ################################

# Max clients: 10000
# Matched to application's connection pool (50 instances x 200 pool)
# with headroom for monitoring and admin connections
# Reduced from 20000 after file descriptor exhaustion on 2024-07-15
maxclients 10000

################################# PERSISTENCE ################################

# PERSISTENCE IS DISABLED — this is a volatile cache
# RDB snapshots: disabled (empty save directives)
# All data is ephemeral and can be rebuilt from the source of truth

save ""

# AOF: disabled — no durability needed for cache
appendonly no

# RDB filename (unused but set for clarity)
dbfilename dump.rdb
dir /var/lib/redis

################################# REPLICATION ################################

# No replication — single instance cache
# replica-read-only yes (default, not relevant)

################################## SLOW LOG ##################################

# Log queries slower than 10ms (10000 microseconds)
# Tuned down from default 100ms to catch cache-unfriendly patterns
slowlog-log-slower-than 10000
slowlog-max-len 256

################################## CLIENTS ###################################

# Client output buffer limits for normal/replica/pubsub
# Normal: 256mb hard, 64mb/60s soft — prevents runaway MONITOR sessions
# from consuming all memory (happened once, 2024-09-05)
client-output-buffer-limit normal 256mb 64mb 60
client-output-buffer-limit replica 512mb 128mb 60
client-output-buffer-limit pubsub 32mb 8mb 60

################################# LATENCY ####################################

# Latency monitoring threshold — 5ms
# Helps identify commands that spike above our SLA
latency-monitor-threshold 5

################################# ADVANCED ###################################

# Hash optimization thresholds
hash-max-listpack-entries 128
hash-max-listpack-value 64

# List optimization
list-max-listpack-size -2
list-max-ziplist-size -2

# IO threads — enabled for better throughput on multi-core
# Tuned to 4 after benchmarking showed diminishing returns beyond
# that on our 8 vCPU instance (2024-09-20)
io-threads 4
io-threads-do-reads yes

# Lazy freeing — enabled to avoid latency spikes on large key deletion
lazyfree-lazy-eviction yes
lazyfree-lazy-expire yes
lazyfree-lazy-server-del yes
CONF

# ── Migration spec ──────────────────────────────────────
RUN mkdir -p /app
COPY <<'EOF' /app/redis_migration.md
# Redis Migration Spec: Volatile Cache → Persistent Data Store

## Overview
The application is transitioning from using Redis as a volatile cache
to a persistent data store for session data, rate limiting state, and
feature flags. Data must survive restarts.

## Required Configuration Changes

### Persistence — Enable Both AOF and RDB
- `appendonly`: yes
- `appendfsync`: everysec (balance between durability and performance)
- `auto-aof-rewrite-percentage`: 100
- `auto-aof-rewrite-min-size`: 64mb
- `aof-use-rdb-preamble`: yes
- `save`: "900 1" "300 10" "60 10000" (RDB snapshots as backup)
- `rdbcompression`: yes
- `rdbchecksum`: yes

### Eviction Policy
- `maxmemory-policy`: noeviction (data must not be silently dropped)
- `maxmemory`: 8gb (reduced from 12gb to leave room for AOF rewrite buffer and RDB fork)

### Connection Settings
- `maxclients`: 5000 (reduced — persistent store has fewer but longer-lived connections)
- `timeout`: 300 (close idle connections to free resources for persistence I/O)
- `tcp-keepalive`: 120

### Slow Log
- `slowlog-log-slower-than`: 50000 (50ms — persistence writes make 10ms too noisy)

### Unchanged
- Network bind/port settings
- Database count
- Latency monitoring
- Client output buffer limits
- Hash/list optimization thresholds
- IO threads settings
- Lazy freeing settings
- Log level and log file path

## Verification
After restarting Redis with the new config:
1. `redis-cli CONFIG GET appendonly` should return "yes"
2. `redis-cli CONFIG GET maxmemory-policy` should return "noeviction"
3. `redis-cli CONFIG GET maxmemory` should show the new value
4. Write a test key, restart Redis, confirm the key persists
EOF

# ── Create required directories ──
RUN mkdir -p /var/lib/redis /var/log/redis /var/run/redis && \
    chown redis:redis /var/lib/redis /var/log/redis /var/run/redis

# ── Verify Redis starts with current config ──
RUN redis-server /etc/redis/redis.conf --daemonize yes && \
    sleep 1 && \
    redis-cli ping && \
    redis-cli shutdown

WORKDIR /app
