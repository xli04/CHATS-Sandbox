FROM python:3.11-slim

RUN apt-get update && apt-get install -y cron tmux curl asciinema && rm -rf /var/lib/apt/lists/*

# Create the scripts referenced by crontab entries
RUN mkdir -p /opt/scripts /var/log/maintenance /backups /app

COPY <<'EOF' /opt/scripts/db_backup_full.sh
#!/bin/bash
echo "Full database backup started at $(date)" >> /var/log/maintenance/db_backup.log
EOF

COPY <<'EOF' /opt/scripts/db_backup_incremental.sh
#!/bin/bash
echo "Incremental backup at $(date)" >> /var/log/maintenance/db_backup.log
EOF

COPY <<'EOF' /opt/scripts/rotate_app_logs.sh
#!/bin/bash
echo "Rotating application logs at $(date)" >> /var/log/maintenance/log_rotation.log
EOF

COPY <<'EOF' /opt/scripts/rotate_access_logs.sh
#!/bin/bash
echo "Rotating access logs at $(date)" >> /var/log/maintenance/log_rotation.log
EOF

COPY <<'EOF' /opt/scripts/compress_old_logs.sh
#!/bin/bash
echo "Compressing logs older than 7 days at $(date)" >> /var/log/maintenance/log_rotation.log
EOF

COPY <<'EOF' /opt/scripts/cleanup_temp.sh
#!/bin/bash
echo "Cleaning temp files at $(date)" >> /var/log/maintenance/cleanup.log
EOF

COPY <<'EOF' /opt/scripts/cleanup_build_artifacts.sh
#!/bin/bash
echo "Cleaning build artifacts at $(date)" >> /var/log/maintenance/cleanup.log
EOF

COPY <<'EOF' /opt/scripts/cleanup_docker.sh
#!/bin/bash
echo "Docker system prune at $(date)" >> /var/log/maintenance/cleanup.log
EOF

COPY <<'EOF' /opt/scripts/health_check.sh
#!/bin/bash
echo "Health check at $(date)" >> /var/log/maintenance/health.log
EOF

COPY <<'EOF' /opt/scripts/check_disk_usage.sh
#!/bin/bash
echo "Disk usage check at $(date)" >> /var/log/maintenance/health.log
EOF

COPY <<'EOF' /opt/scripts/check_ssl_certs.sh
#!/bin/bash
echo "SSL cert expiry check at $(date)" >> /var/log/maintenance/health.log
EOF

COPY <<'EOF' /opt/scripts/generate_daily_report.sh
#!/bin/bash
echo "Daily report generated at $(date)" >> /var/log/maintenance/reports.log
EOF

COPY <<'EOF' /opt/scripts/generate_usage_stats.sh
#!/bin/bash
echo "Usage stats generated at $(date)" >> /var/log/maintenance/reports.log
EOF

COPY <<'EOF' /opt/scripts/sync_cdn_assets.sh
#!/bin/bash
echo "CDN sync at $(date)" >> /var/log/maintenance/sync.log
EOF

COPY <<'EOF' /opt/scripts/sync_offsite_backup.sh
#!/bin/bash
echo "Offsite backup sync at $(date)" >> /var/log/maintenance/sync.log
EOF

COPY <<'EOF' /opt/scripts/warm_cache.sh
#!/bin/bash
echo "Cache warming at $(date)" >> /var/log/maintenance/cache.log
EOF

COPY <<'EOF' /opt/scripts/invalidate_stale_cache.sh
#!/bin/bash
echo "Stale cache invalidation at $(date)" >> /var/log/maintenance/cache.log
EOF

COPY <<'EOF' /opt/scripts/reindex_search.sh
#!/bin/bash
echo "Search reindex at $(date)" >> /var/log/maintenance/search.log
EOF

COPY <<'EOF' /opt/scripts/vacuum_db.sh
#!/bin/bash
echo "Database vacuum at $(date)" >> /var/log/maintenance/db_maintenance.log
EOF

COPY <<'EOF' /opt/scripts/update_geoip.sh
#!/bin/bash
echo "GeoIP database updated at $(date)" >> /var/log/maintenance/updates.log
EOF

COPY <<'EOF' /opt/scripts/rotate_api_keys.sh
#!/bin/bash
echo "API key rotation check at $(date)" >> /var/log/maintenance/security.log
EOF

COPY <<'EOF' /opt/scripts/audit_permissions.sh
#!/bin/bash
echo "Permission audit at $(date)" >> /var/log/maintenance/security.log
EOF

COPY <<'EOF' /opt/scripts/cleanup_sessions.sh
#!/bin/bash
echo "Expired sessions cleaned at $(date)" >> /var/log/maintenance/cleanup.log
EOF

COPY <<'EOF' /opt/scripts/optimize_images.sh
#!/bin/bash
echo "Image optimization at $(date)" >> /var/log/maintenance/optimization.log
EOF

COPY <<'EOF' /opt/scripts/defrag_tables.sh
#!/bin/bash
echo "Table defragmentation at $(date)" >> /var/log/maintenance/db_maintenance.log
EOF

RUN chmod +x /opt/scripts/*.sh

# ── Install the crontab (overnight schedule, carefully tuned) ──
COPY <<'CRONTAB' /tmp/maintenance_crontab
# ============================================================
# Server Maintenance Schedule — Overnight Window (1:00–6:00 AM)
# Last reviewed: 2024-11-15
# IMPORTANT: Timing was refined over 18 months to avoid I/O
# and CPU conflicts. Do NOT change without understanding the
# dependencies noted below.
# ============================================================

# --- DATABASE BACKUPS (1:00–1:45 AM) ---
# Full backup first — takes ~30 min, heavy I/O
0 1 * * * /opt/scripts/db_backup_full.sh
# Incremental starts after full completes (staggered by 40 min)
40 1 * * * /opt/scripts/db_backup_incremental.sh

# --- LOG ROTATION (2:00–2:30 AM) ---
# App logs first — lightweight, finishes in 5 min
0 2 * * * /opt/scripts/rotate_app_logs.sh
# Access logs at :07 — after app log rotation frees disk I/O
7 2 * * * /opt/scripts/rotate_access_logs.sh
# Compress old logs at :17 — after both rotations done
# Moved from :15 to :17 to avoid overlap with access log tail
17 2 * * * /opt/scripts/compress_old_logs.sh

# --- CLEANUP (2:30–3:00 AM) ---
# Temp files first — frees disk for subsequent jobs
30 2 * * * /opt/scripts/cleanup_temp.sh
# Build artifacts at :37 — after temp cleanup frees inodes
37 2 * * * /opt/scripts/cleanup_build_artifacts.sh
# Docker prune at :45 — heavy I/O, runs alone
45 2 * * * /opt/scripts/cleanup_docker.sh
# Session cleanup at :52 — lightweight DB operation
52 2 * * * /opt/scripts/cleanup_sessions.sh

# --- HEALTH CHECKS (3:00–3:15 AM) ---
# General health check — quick, low resource
0 3 * * * /opt/scripts/health_check.sh
# Disk usage check at :05 — after cleanup jobs free space
5 3 * * * /opt/scripts/check_disk_usage.sh
# SSL cert expiry — runs weekly on Monday only
10 3 * * 1 /opt/scripts/check_ssl_certs.sh

# --- REPORTS (3:15–3:30 AM) ---
# Daily report — reads from DB, needs backup to be done
17 3 * * * /opt/scripts/generate_daily_report.sh
# Usage stats at :25 — CPU intensive aggregation
25 3 * * * /opt/scripts/generate_usage_stats.sh

# --- SYNC JOBS (3:30–4:00 AM) ---
# CDN asset sync — moderate bandwidth, 10-15 min
33 3 * * * /opt/scripts/sync_cdn_assets.sh
# Offsite backup sync at :47 — large transfer, runs alone
# Deliberately spaced from CDN sync to avoid bandwidth contention
47 3 * * * /opt/scripts/sync_offsite_backup.sh

# --- CACHE OPERATIONS (4:00–4:20 AM) ---
# Invalidate stale cache first — must finish before warming
0 4 * * * /opt/scripts/invalidate_stale_cache.sh
# Cache warming at :12 — depends on invalidation completing
# Was at :10, moved to :12 after invalidation started taking longer
12 4 * * * /opt/scripts/warm_cache.sh

# --- DATABASE MAINTENANCE (4:30–5:15 AM) ---
# Search reindex — CPU heavy, needs quiet DB
30 4 * * * /opt/scripts/reindex_search.sh
# Vacuum at :47 — after reindex, heavy I/O
# Runs only on Sundays to minimize impact
47 4 * * 0 /opt/scripts/vacuum_db.sh
# Table defrag at :55 — after vacuum, complementary operation
# Runs only on Sundays with vacuum
55 4 * * 0 /opt/scripts/defrag_tables.sh

# --- SECURITY & UPDATES (5:00–5:30 AM) ---
# GeoIP update — weekly on Wednesday, downloads ~50MB
0 5 * * 3 /opt/scripts/update_geoip.sh
# API key rotation check — daily, lightweight
8 5 * * * /opt/scripts/rotate_api_keys.sh
# Permission audit at :15 — scans filesystem, moderate I/O
15 5 * * * /opt/scripts/audit_permissions.sh

# --- OPTIMIZATION (5:30 AM) ---
# Image optimization — CPU heavy, runs last before business hours
30 5 * * * /opt/scripts/optimize_images.sh
CRONTAB

RUN crontab /tmp/maintenance_crontab && rm /tmp/maintenance_crontab

WORKDIR /app
