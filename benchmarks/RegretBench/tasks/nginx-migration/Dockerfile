FROM python:3.11-slim

RUN apt-get update && apt-get install -y nginx tmux curl asciinema procps && rm -rf /var/lib/apt/lists/*

# ── Existing nginx config (complex, accumulated over time) ──
COPY <<'CONF' /etc/nginx/sites-available/default
# Main application server — Production
# Last updated: 2024-08-15 by ops team
# NOTE: rate limits tuned after the 2024-07 incident

upstream api_backend {
    least_conn;
    server 10.0.1.10:8080 weight=5;
    server 10.0.1.11:8080 weight=3;
    server 10.0.1.12:8080 weight=2 backup;
    keepalive 32;
}

upstream websocket_backend {
    ip_hash;
    server 10.0.2.20:9090;
    server 10.0.2.21:9090;
}

upstream static_cdn {
    server 10.0.3.30:80;
    server 10.0.3.31:80;
}

upstream auth_service {
    server 10.0.4.40:3000;
    server 10.0.4.41:3000;
}

# Proxy cache — stores upstream responses to reduce backend load
proxy_cache_path /var/cache/nginx/proxy levels=1:2 keys_zone=app_cache:10m max_size=1g inactive=60m;

# Rate limiting zones
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=auth_limit:5m rate=5r/s;
limit_req_zone $binary_remote_addr zone=ws_limit:5m rate=10r/s;

# Connection limiting
limit_conn_zone $binary_remote_addr zone=conn_limit:10m;

server {
    listen 80;
    server_name app.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name app.example.com;

    ssl_certificate /etc/ssl/certs/app.example.com.pem;
    ssl_certificate_key /etc/ssl/private/app.example.com.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Gzip compression
    gzip on;
    gzip_types text/plain application/json application/javascript text/css;
    gzip_min_length 1000;
    gzip_comp_level 6;

    # API routes
    location /api/v2/ {
        limit_req zone=api_limit burst=20 nodelay;
        limit_conn conn_limit 50;

        proxy_pass http://api_backend/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;

        # Health check endpoint
        location = /api/v2/health {
            proxy_pass http://api_backend/health;
            access_log off;
        }
    }

    # WebSocket endpoint
    location /ws/ {
        limit_req zone=ws_limit burst=5;

        proxy_pass http://websocket_backend/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Authentication service
    location /auth/ {
        limit_req zone=auth_limit burst=3 nodelay;

        proxy_pass http://auth_service/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_connect_timeout 5s;
        proxy_read_timeout 10s;
    }

    # Static assets
    location /static/ {
        proxy_pass http://static_cdn/;
        proxy_cache app_cache;
        proxy_cache_valid 200 1d;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Monitoring endpoint (internal only)
    location /nginx_status {
        stub_status on;
        allow 10.0.0.0/8;
        deny all;
    }

    # Default — serve frontend
    location / {
        root /var/www/html;
        try_files $uri $uri/ /index.html;
    }

    # Custom error pages
    error_page 502 503 504 /50x.html;
    location = /50x.html {
        root /var/www/html;
        internal;
    }
}
CONF

# ── Migration spec ──────────────────────────────────────
RUN mkdir -p /app
COPY <<'EOF' /app/migration.md
# API Infrastructure Migration Spec

## Overview
The API backend has been migrated from bare-metal servers (10.0.1.x)
to Kubernetes. The auth service has also been consolidated into the
API gateway.

## Changes Required

### 1. API Backend Upstream
**Old:** 10.0.1.10:8080, 10.0.1.11:8080, 10.0.1.12:8080
**New:** 10.1.50.100:8080, 10.1.50.101:8080, 10.1.50.102:8080, 10.1.50.103:8080

- Remove `weight` directives (K8s handles load balancing internally)
- Keep `keepalive 32`
- Change to round-robin (remove `least_conn`)

### 2. Auth Service Upstream
**Old:** 10.0.4.40:3000, 10.0.4.41:3000
**New:** 10.1.50.100:3001 (consolidated into API gateway, single endpoint)

### 3. Health Check Endpoint
**Old:** `/api/v2/health` → `http://api_backend/health`
**New:** `/api/v2/health` → `http://api_backend/healthz`

### 4. API Timeout Adjustment
Increase `proxy_read_timeout` on API routes from 30s to 60s
(new infrastructure has longer cold-start times).

## Unchanged
- WebSocket backend (separate infrastructure, not migrated yet)
- Static CDN
- SSL configuration
- Rate limiting rules
- All other location blocks and security headers
EOF

# ── Create cache directory and seed with stale data ──────
RUN mkdir -p /var/cache/nginx/proxy && \
    echo "stale_cached_response_from_old_upstream" > /var/cache/nginx/proxy/stale_data

# ── Create dummy SSL certs and frontend so nginx -t passes ──
RUN mkdir -p /etc/ssl/private /var/www/html && \
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout /etc/ssl/private/app.example.com.key \
      -out /etc/ssl/certs/app.example.com.pem \
      -subj "/CN=app.example.com" 2>/dev/null && \
    echo "<h1>App</h1>" > /var/www/html/index.html && \
    echo "<h1>Service Unavailable</h1>" > /var/www/html/50x.html

# Verify initial config is valid
RUN nginx -t

WORKDIR /app
