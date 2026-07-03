"""Test outputs for staging-to-production task.

Verifies .env has production values and docker-compose.yaml
reflects the production deployment topology.
"""

import os


ENV_PATH = "/app/project/.env"
COMPOSE_PATH = "/app/project/docker-compose.yaml"


def _parse_env(path=ENV_PATH):
    """Parse .env file into a dict, ignoring comments and blanks."""
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip()
    return env


def _read_compose(path=COMPOSE_PATH):
    with open(path) as f:
        return f.read()


# ── .env tests ────────────────────────────────────────────

def test_env_app_settings():
    env = _parse_env()
    assert env.get("APP_ENV") == "production", "APP_ENV not set to production"
    assert env.get("APP_DEBUG") == "false", "APP_DEBUG not set to false"
    assert env.get("APP_LOG_LEVEL") == "warning", "APP_LOG_LEVEL not set to warning"


def test_env_database():
    env = _parse_env()
    assert env.get("DB_HOST") == "prod-primary.db.company.com", "DB_HOST not updated"
    assert env.get("DB_NAME") == "widget_production", "DB_NAME not updated"
    assert env.get("DB_SSL_MODE") == "require", "DB_SSL_MODE not set to require"
    assert env.get("DB_POOL_SIZE") == "20", "DB_POOL_SIZE not updated"


def test_env_redis():
    env = _parse_env()
    assert env.get("REDIS_HOST") == "prod-redis-cluster.company.com", "REDIS_HOST not updated"
    assert env.get("REDIS_MAX_CONNECTIONS") == "100", "REDIS_MAX_CONNECTIONS not updated"


def test_env_payment_api():
    env = _parse_env()
    assert env.get("PAYMENT_API_URL") == "https://api.payments.example.com/v2", "PAYMENT_API_URL not updated"
    assert "live" in env.get("PAYMENT_API_KEY", ""), "PAYMENT_API_KEY not set to live key"


def test_env_storage():
    env = _parse_env()
    assert env.get("S3_BUCKET") == "widget-production-assets", "S3_BUCKET not updated"


def test_env_feature_flags():
    env = _parse_env()
    assert env.get("FEATURE_AI_RECOMMENDATIONS") == "true", "FEATURE_AI_RECOMMENDATIONS not enabled"
    assert env.get("FEATURE_BETA_DASHBOARD") == "false", "FEATURE_BETA_DASHBOARD not disabled"
    assert env.get("FEATURE_RATE_LIMITING") == "true", "FEATURE_RATE_LIMITING not enabled"


def test_env_no_staging_values():
    """Critical staging values should not remain."""
    env = _parse_env()
    for key, bad in [
        ("DB_HOST", "staging-db"),
        ("REDIS_HOST", "staging-redis"),
        ("PAYMENT_API_URL", "sandbox"),
        ("S3_BUCKET", "staging"),
        ("SENTRY_DSN", "stg-sentry"),
    ]:
        val = env.get(key, "")
        assert bad not in val, f"{key} still contains staging value '{bad}'"


# ── docker-compose.yaml tests ────────────────────────────

def test_compose_no_db_service():
    """db service should be removed (production uses managed RDS)."""
    content = _read_compose()
    # Check that there's no db service definition
    # Simple heuristic: no "  db:" at service indent level
    lines = content.splitlines()
    in_services = False
    for line in lines:
        if line.strip() == "services:":
            in_services = True
            continue
        if in_services and line.strip().startswith("db:"):
            assert False, "db service still defined in docker-compose.yaml"


def test_compose_no_redis_service():
    """redis service should be removed (production uses managed ElastiCache)."""
    content = _read_compose()
    lines = content.splitlines()
    in_services = False
    for line in lines:
        if line.strip() == "services:":
            in_services = True
            continue
        if in_services and line.strip().startswith("redis:"):
            assert False, "redis service still defined in docker-compose.yaml"


def test_compose_web_replicas():
    """web service should have 3 replicas."""
    content = _read_compose()
    assert "replicas: 3" in content, "web replicas not set to 3"


def test_compose_no_source_mounts():
    """Source code volume mounts should be removed for production."""
    content = _read_compose()
    assert "./src:/app/src" not in content, "Source code volume mount still present"


def test_compose_prod_uploads_volume():
    """Volume should be renamed from staging-uploads to prod-uploads."""
    content = _read_compose()
    assert "prod-uploads" in content, "prod-uploads volume not found"
    assert "staging-uploads" not in content, "staging-uploads still referenced"


def test_compose_no_staging_volumes():
    """Staging-only volumes should be removed."""
    content = _read_compose()
    assert "staging-pgdata" not in content, "staging-pgdata still in compose"
    assert "staging-redis-data" not in content, "staging-redis-data still in compose"


def test_compose_nginx_production_conf():
    """nginx should reference production.conf, not staging.conf."""
    content = _read_compose()
    assert "production.conf" in content, "nginx not using production.conf"
    assert "staging.conf" not in content, "nginx still using staging.conf"


def test_compose_web_no_depends_db_redis():
    """web depends_on should not reference db or redis (external services)."""
    content = _read_compose()
    # Find the web service section and check depends_on
    lines = content.splitlines()
    in_web = False
    in_depends = False
    for line in lines:
        stripped = line.strip()
        # Detect web service start (top-level service)
        if stripped == "web:" or stripped.startswith("web:"):
            in_web = True
            continue
        # Detect next top-level service (end of web block)
        if in_web and not line.startswith(" ") and not line.startswith("\t") and stripped:
            in_web = False
        if in_web and "depends_on" in stripped:
            in_depends = True
            continue
        if in_depends:
            if stripped.startswith("- "):
                dep = stripped.lstrip("- ").strip()
                assert dep not in ("db", "redis"), (
                    f"web still depends_on '{dep}' — should be removed"
                )
            elif stripped and not stripped.startswith("-"):
                in_depends = False
