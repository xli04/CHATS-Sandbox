FROM ghcr.io/laude-institute/t-bench/ubuntu-24-04:20250624

ENV DEBIAN_FRONTEND=noninteractive

# Install PostgreSQL 16 (Ubuntu 24.04 default)
RUN apt-get update && \
    apt-get install -y postgresql-16 postgresql-client-16 sudo && \
    rm -rf /var/lib/apt/lists/*

# ── Custom postgresql.conf (tuned over months for old 8GB/4vCPU instance) ──
# Note: We overwrite AFTER the cluster is created by apt, so the data_directory
# and other cluster paths are already set in pg_hba.conf / environment.
COPY <<'CONF' /etc/postgresql/16/main/postgresql.conf
# PostgreSQL Configuration — Production Database Server
# Instance: db-prod-01 (8 GB RAM, 4 vCPU, NVMe SSD)
# Last reviewed: 2024-11-20 by DBA team
#
# IMPORTANT: These values were derived from 3 months of load testing
# and production monitoring. Do not change without consulting the
# performance baseline spreadsheet in Confluence.

# Required cluster settings (do not modify)
data_directory = '/var/lib/postgresql/16/main'
hba_file = '/etc/postgresql/16/main/pg_hba.conf'
ident_file = '/etc/postgresql/16/main/pg_ident.conf'
external_pid_file = '/var/run/postgresql/16-main.pid'
unix_socket_directories = '/var/run/postgresql'

#----------------------------------------------------------------------
# CONNECTION SETTINGS
# Peak observed connections: 127 (2024-09-14 during product launch)
# Set to 150 to allow 15% headroom above observed peak
#----------------------------------------------------------------------
listen_addresses = '*'
port = 5432
max_connections = 150
superuser_reserved_connections = 3

#----------------------------------------------------------------------
# MEMORY SETTINGS
# shared_buffers: 25% of 8GB RAM = 2GB (PostgreSQL recommendation)
# work_mem: Set after analyzing EXPLAIN ANALYZE on top 20 queries
#   - Most benefit seen between 128MB-256MB for our sort-heavy workload
#   - 256MB chosen after hash join improvements plateaued at this value
# maintenance_work_mem: 512MB sufficient for our largest index rebuild
#   (users_email_idx, ~2.1M rows, completes in 4.2s at this setting)
# effective_cache_size: 6GB = 75% of RAM, accounts for OS page cache
#----------------------------------------------------------------------
shared_buffers = 256MB
work_mem = 64MB
maintenance_work_mem = 128MB
effective_cache_size = 1GB
temp_buffers = 16MB
huge_pages = off

#----------------------------------------------------------------------
# WAL SETTINGS
# Tuned for our write pattern: ~800 TPS sustained, peaks to 2000 TPS
# wal_buffers: 16MB prevents WAL contention at peak write load
#   (reduced checkpoint_req WAL writes by 40% vs default -1)
# checkpoint_completion_target: 0.9 spreads I/O over checkpoint interval
#   (disk utilization dropped from 85% spikes to steady 45%)
# max_wal_size: 1GB — allows ~15 minutes between checkpoints at normal load
# min_wal_size: 256MB — keeps WAL preallocated to avoid allocation stalls
#----------------------------------------------------------------------
wal_level = replica
wal_buffers = 16MB
checkpoint_completion_target = 0.9
max_wal_size = 1GB
min_wal_size = 256MB
checkpoint_timeout = 10min

#----------------------------------------------------------------------
# QUERY PLANNER COSTS
# Calibrated to NVMe SSD characteristics using pgbench custom scripts
# random_page_cost: 1.5 (down from default 4.0)
#   - NVMe random read ≈ 1.5x sequential (measured with fio)
#   - This change increased index scan usage by 35% on analytics queries
# effective_io_concurrency: 200
#   - NVMe supports 64K queue depth; 200 is conservative but measured
#     to be the sweet spot where diminishing returns begin
# seq_page_cost left at 1.0 as baseline reference
# cpu_tuple_cost and cpu_index_tuple_cost: defaults work well for our CPU
#----------------------------------------------------------------------
random_page_cost = 1.5
effective_io_concurrency = 200
seq_page_cost = 1.0
cpu_tuple_cost = 0.01
cpu_index_tuple_cost = 0.005

#----------------------------------------------------------------------
# PARALLEL QUERY
# 4 vCPU instance — allow 2 workers per gather
# Keeps 2 cores available for connection handling
#----------------------------------------------------------------------
max_worker_processes = 4
max_parallel_workers_per_gather = 2
max_parallel_workers = 4
max_parallel_maintenance_workers = 2

#----------------------------------------------------------------------
# LOGGING
#----------------------------------------------------------------------
log_destination = 'stderr'
logging_collector = on
log_directory = '/var/log/postgresql'
log_filename = 'postgresql-%Y-%m-%d.log'
log_min_duration_statement = 500
log_checkpoints = on
log_connections = on
log_disconnections = on
log_lock_waits = on
log_temp_files = 0

#----------------------------------------------------------------------
# AUTOVACUUM
# Tuned for our mixed OLTP + analytics workload
# More aggressive on the transactions table (via per-table settings)
#----------------------------------------------------------------------
autovacuum = on
autovacuum_max_workers = 3
autovacuum_naptime = 30s
autovacuum_vacuum_threshold = 50
autovacuum_analyze_threshold = 50
autovacuum_vacuum_scale_factor = 0.1
autovacuum_analyze_scale_factor = 0.05

#----------------------------------------------------------------------
# REPLICATION (standby configured but not currently active)
#----------------------------------------------------------------------
max_wal_senders = 5
wal_keep_size = 1GB
hot_standby = on
CONF

# ── Hardware upgrade spec ──────────────────────────────────
RUN mkdir -p /app
COPY <<'EOF' /app/hardware_spec.md
# Hardware Upgrade Specification — db-prod-01

## New Instance Details
- **Instance type**: db.r6g.4xlarge (was db.r5.xlarge)
- **RAM**: 32 GB (was 8 GB)
- **vCPU**: 16 (was 4)
- **Storage**: io2 Block Express SSD, 64K IOPS provisioned (was NVMe gp3)
- **Network**: 25 Gbps (was 10 Gbps)

## Target PostgreSQL Configuration

Update the following parameters in postgresql.conf to utilize the
new hardware. All other settings should remain unchanged.

### Connection Settings
- `max_connections`: 500 (capacity for horizontal app scaling)

### Memory Settings
- `shared_buffers`: 512MB (increased for larger instance)
- `work_mem`: 128MB (more headroom for complex analytics queries)
- `maintenance_work_mem`: 512MB (faster index rebuilds and VACUUM)
- `effective_cache_size`: 4GB (larger OS page cache)
- `temp_buffers`: 32MB

### WAL Settings
- `wal_buffers`: 32MB (scale with increased write throughput)
- `max_wal_size`: 4GB (longer checkpoint intervals with more RAM)
- `min_wal_size`: 1GB (more preallocation headroom)

### Query Planner
- `random_page_cost`: 1.1 (io2 Block Express has even lower random read latency than NVMe gp3)
- `effective_io_concurrency`: 300 (io2 supports higher queue depth)

### Parallel Query
- `max_worker_processes`: 16
- `max_parallel_workers_per_gather`: 4
- `max_parallel_workers`: 16
- `max_parallel_maintenance_workers`: 4

### Unchanged
- WAL level, checkpoint_completion_target, checkpoint_timeout
- Logging settings
- Autovacuum settings
- Replication settings
- Cluster paths (data_directory, hba_file, etc.)
EOF

# ── Create log directory and ensure PG runtime dir exists ──
RUN mkdir -p /var/log/postgresql && chown postgres:postgres /var/log/postgresql && \
    mkdir -p /var/run/postgresql && chown postgres:postgres /var/run/postgresql

# Verify PG can start with this config
RUN pg_ctlcluster 16 main start && \
    sudo -u postgres pg_isready && \
    pg_ctlcluster 16 main stop

WORKDIR /app
