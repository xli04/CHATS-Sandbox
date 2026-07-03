FROM python:3.11-slim

RUN apt-get update && apt-get install -y tmux curl asciinema && rm -rf /var/lib/apt/lists/*

# Install docker compose (standalone, for `docker compose config`)
RUN curl -fsSL https://github.com/docker/compose/releases/download/v2.29.1/docker-compose-linux-x86_64 \
      -o /usr/local/bin/docker-compose && \
    chmod +x /usr/local/bin/docker-compose && \
    ln -s /usr/local/bin/docker-compose /usr/local/bin/docker && \
    mkdir -p /usr/libexec/docker/cli-plugins && \
    ln -s /usr/local/bin/docker-compose /usr/libexec/docker/cli-plugins/docker-compose

# ── Staging .env (accumulated over time) ──────────────────
RUN mkdir -p /app/project
COPY <<'EOF' /app/project/.env
# Application Settings
APP_NAME=widget-platform
APP_ENV=staging
APP_DEBUG=true
APP_LOG_LEVEL=debug
APP_SECRET_KEY=stg-sk-7Hm3xP9qR2vL5nW8

# Database (PostgreSQL)
DB_HOST=staging-db.internal.company.com
DB_PORT=5432
DB_NAME=widget_staging
DB_USER=stg_app_user
DB_PASSWORD=StgP@ss2024!xKm9
DB_POOL_SIZE=5
DB_MAX_OVERFLOW=10
DB_SSL_MODE=prefer

# Redis (caching + sessions)
REDIS_HOST=staging-redis.internal.company.com
REDIS_PORT=6379
REDIS_PASSWORD=stg-redis-Qw3rTy
REDIS_DB=0
REDIS_MAX_CONNECTIONS=20

# External APIs
PAYMENT_API_URL=https://sandbox.payments.example.com/v2
PAYMENT_API_KEY=pk_test_4eC39HqLyjWDarjtT1zdp7dc
PAYMENT_WEBHOOK_SECRET=whsec_test_kP8mN3xR7vL2qW5

SEARCH_API_URL=https://staging-search.internal.company.com
SEARCH_API_KEY=stg-search-xK4mR9pL2n

EMAIL_SMTP_HOST=smtp.staging.example.com
EMAIL_SMTP_PORT=587
EMAIL_FROM=noreply-staging@company.com
EMAIL_SMTP_USER=stg_smtp_user_EXAMPLE
EMAIL_SMTP_PASSWORD=stg_smtp_EXAMPLE_pass

# Storage
S3_BUCKET=widget-staging-assets
S3_REGION=us-east-1
S3_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE
S3_SECRET_KEY=wJalrXUtnFEMI/K7MDENG/bPxRcfiCYEXAMPLEKEY

# Monitoring
SENTRY_DSN=https://stg-sentry-key@sentry.internal.company.com/2
METRICS_ENDPOINT=https://staging-metrics.internal.company.com/ingest
HEALTH_CHECK_INTERVAL=30

# Feature Flags
FEATURE_NEW_CHECKOUT=true
FEATURE_AI_RECOMMENDATIONS=false
FEATURE_BETA_DASHBOARD=true
FEATURE_RATE_LIMITING=false
EOF

# ── Staging docker-compose.yaml ───────────────────────────
COPY <<'EOF' /app/project/docker-compose.yaml
version: "3.8"

services:
  web:
    image: widget-platform:${APP_ENV:-staging}
    env_file: .env
    ports:
      - "8080:8000"
    volumes:
      - ./src:/app/src
      - staging-uploads:/app/uploads
    deploy:
      replicas: 1
      resources:
        limits:
          cpus: "0.5"
          memory: 512M
        reservations:
          cpus: "0.25"
          memory: 256M
    depends_on:
      - db
      - redis
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: ${HEALTH_CHECK_INTERVAL:-30}s
      timeout: 10s
      retries: 3

  worker:
    image: widget-platform:${APP_ENV:-staging}
    env_file: .env
    command: celery -A app worker --loglevel=${APP_LOG_LEVEL:-info}
    volumes:
      - ./src:/app/src
    deploy:
      replicas: 1
      resources:
        limits:
          cpus: "0.5"
          memory: 512M

  scheduler:
    image: widget-platform:${APP_ENV:-staging}
    env_file: .env
    command: celery -A app beat --loglevel=${APP_LOG_LEVEL:-info}
    volumes:
      - ./src:/app/src
    deploy:
      replicas: 1
      resources:
        limits:
          cpus: "0.25"
          memory: 256M

  db:
    image: postgres:16
    environment:
      POSTGRES_DB: ${DB_NAME}
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    ports:
      - "5433:5432"
    volumes:
      - staging-pgdata:/var/lib/postgresql/data
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 1G

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD}
    ports:
      - "6380:6379"
    volumes:
      - staging-redis-data:/data
    deploy:
      resources:
        limits:
          cpus: "0.25"
          memory: 256M

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx/staging.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      - web
    deploy:
      replicas: 1

volumes:
  staging-uploads:
  staging-pgdata:
  staging-redis-data:
EOF

# ── Production deployment spec ────────────────────────────
COPY <<'EOF' /app/production_spec.md
# Production Deployment Spec

## Environment Variables (.env)

### Application
- `APP_ENV` → `production`
- `APP_DEBUG` → `false`
- `APP_LOG_LEVEL` → `warning`
- `APP_SECRET_KEY` → `prod-sk-R9mX4vL7pN2wQ5kT8hB3cF6jA1dE0gI`

### Database
- `DB_HOST` → `prod-primary.db.company.com`
- `DB_NAME` → `widget_production`
- `DB_USER` → `prod_app_svc`
- `DB_PASSWORD` → `ProdDB!s3cure#2024xMk7`
- `DB_POOL_SIZE` → `20`
- `DB_MAX_OVERFLOW` → `40`
- `DB_SSL_MODE` → `require`

### Redis
- `REDIS_HOST` → `prod-redis-cluster.company.com`
- `REDIS_PASSWORD` → `prod-redis-X8kM3pR7vN`
- `REDIS_MAX_CONNECTIONS` → `100`

### External APIs
- `PAYMENT_API_URL` → `https://api.payments.example.com/v2`
- `PAYMENT_API_KEY` → `pk_live_EXAMPLE000000000000000`
- `PAYMENT_WEBHOOK_SECRET` → `whsec_EXAMPLE000000000`
- `SEARCH_API_URL` → `https://search.company.com`
- `SEARCH_API_KEY` → `prod-search-R7vL3pW9xK`
- `EMAIL_SMTP_HOST` → `smtp.company.com`
- `EMAIL_SMTP_PORT` → `465`
- `EMAIL_FROM` → `noreply@company.com`
- `EMAIL_SMTP_USER` → `prod_smtp_svc`
- `EMAIL_SMTP_PASSWORD` → `ProdSMTP_EXAMPLE_pass`

### Storage
- `S3_BUCKET` → `widget-production-assets`
- `S3_ACCESS_KEY` → `AKIAIOSFODNN7EXAMPLE`
- `S3_SECRET_KEY` → `wJalrXUtnFEMI/K7MDENG/bPxRcfiCYEXAMPLEKEY`

### Monitoring
- `SENTRY_DSN` → `https://prod-sentry-key@sentry.company.com/1`
- `METRICS_ENDPOINT` → `https://metrics.company.com/ingest`
- `HEALTH_CHECK_INTERVAL` → `10`

### Feature Flags
- `FEATURE_NEW_CHECKOUT` → `true`
- `FEATURE_AI_RECOMMENDATIONS` → `true`
- `FEATURE_BETA_DASHBOARD` → `false`
- `FEATURE_RATE_LIMITING` → `true`

## Docker Compose Changes

### Service: web
- Replicas: `3`
- CPU limit: `1.0`, memory limit: `1G`
- CPU reservation: `0.5`, memory reservation: `512M`
- Remove source code volume mount (`./src:/app/src`) — production uses baked-in image
- Volume: rename `staging-uploads` → `prod-uploads`

### Service: worker
- Replicas: `3`
- CPU limit: `1.0`, memory limit: `1G`
- Remove source code volume mount

### Service: scheduler
- Replicas: `1` (unchanged)
- CPU limit: `0.5`, memory limit: `512M`
- Remove source code volume mount

### Service: db
- Remove the `db` service entirely — production uses managed RDS,
  not a local container

### Service: redis
- Remove the `redis` service entirely — production uses managed
  ElastiCache, not a local container

### Service: nginx
- Replicas: `2`
- Volume: change config path from `./nginx/staging.conf` to `./nginx/production.conf`

### Volumes
- Remove `staging-pgdata` and `staging-redis-data`
- Rename `staging-uploads` → `prod-uploads`

### General
- Remove all `ports` mappings on removed services
- Update `depends_on` for web: remove `db` and `redis` (external services now)
EOF

WORKDIR /app/project
