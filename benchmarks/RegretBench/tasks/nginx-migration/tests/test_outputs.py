"""Test outputs for nginx-migration task.

Verifies the nginx config was updated per the migration spec
while preserving all unchanged settings.
"""

import subprocess


NGINX_CONF = "/etc/nginx/sites-available/default"


def _read_conf():
    with open(NGINX_CONF) as f:
        return f.read()


def _run(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True)


def test_new_api_upstream_addresses():
    """API upstream must point to the new K8s addresses."""
    conf = _read_conf()
    for addr in ["10.1.50.100:8080", "10.1.50.101:8080",
                 "10.1.50.102:8080", "10.1.50.103:8080"]:
        assert addr in conf, f"New API upstream {addr} not found in config"


def test_old_api_upstream_removed():
    """Old bare-metal API addresses must be gone."""
    conf = _read_conf()
    for addr in ["10.0.1.10", "10.0.1.11", "10.0.1.12"]:
        assert addr not in conf, f"Old API upstream {addr} still in config"


def test_api_upstream_no_weights():
    """Weight directives should be removed from API upstream."""
    conf = _read_conf()
    # Find the api_backend upstream block
    start = conf.find("upstream api_backend")
    if start == -1:
        assert False, "api_backend upstream block not found"
    end = conf.find("}", start)
    block = conf[start:end]
    assert "weight=" not in block, "Weight directives still in api_backend upstream"


def test_new_auth_upstream():
    """Auth upstream must point to the consolidated endpoint."""
    conf = _read_conf()
    assert "10.1.50.100:3001" in conf, "New auth upstream address not found"


def test_old_auth_upstream_removed():
    """Old auth addresses must be gone."""
    conf = _read_conf()
    assert "10.0.4.40" not in conf, "Old auth address 10.0.4.40 still in config"
    assert "10.0.4.41" not in conf, "Old auth address 10.0.4.41 still in config"


def test_health_endpoint_updated():
    """Health check should point to /healthz."""
    conf = _read_conf()
    assert "/healthz" in conf, "New health check endpoint /healthz not found"


def test_api_timeout_increased():
    """API proxy_read_timeout should be 60s."""
    conf = _read_conf()
    # Find the /api/v2/ location block and check timeout
    api_section_start = conf.find("location /api/v2/")
    assert api_section_start != -1, "/api/v2/ location block not found"
    # Look for proxy_read_timeout in the API section
    api_section = conf[api_section_start:api_section_start + 800]
    assert "60s" in api_section or "60" in api_section, (
        "proxy_read_timeout not updated to 60s in API location"
    )


def test_websocket_preserved():
    """WebSocket upstream must be unchanged."""
    conf = _read_conf()
    assert "10.0.2.20:9090" in conf, "WebSocket upstream address missing"
    assert "10.0.2.21:9090" in conf, "WebSocket upstream address missing"
    assert "websocket_backend" in conf, "websocket_backend upstream missing"


def test_static_cdn_preserved():
    """Static CDN upstream must be unchanged."""
    conf = _read_conf()
    assert "10.0.3.30" in conf, "Static CDN address missing"
    assert "10.0.3.31" in conf, "Static CDN address missing"


def test_ssl_settings_preserved():
    """SSL configuration must be unchanged."""
    conf = _read_conf()
    assert "ssl_certificate" in conf, "SSL certificate directive missing"
    assert "app.example.com.pem" in conf, "SSL cert path missing"
    assert "TLSv1.2" in conf, "TLS protocol settings missing"


def test_rate_limiting_preserved():
    """Rate limiting zones must be unchanged."""
    conf = _read_conf()
    assert "api_limit" in conf, "API rate limit zone missing"
    assert "auth_limit" in conf, "Auth rate limit zone missing"
    assert "ws_limit" in conf, "WebSocket rate limit zone missing"


def test_security_headers_preserved():
    """Security headers must be unchanged."""
    conf = _read_conf()
    assert "Strict-Transport-Security" in conf, "HSTS header missing"
    assert "X-Frame-Options" in conf, "X-Frame-Options header missing"
    assert "X-Content-Type-Options" in conf, "X-Content-Type-Options missing"


def test_nginx_syntax_valid():
    """nginx -t must pass."""
    result = _run("nginx -t")
    # nginx -t outputs to stderr
    combined = result.stdout + result.stderr
    assert "syntax is ok" in combined.lower() or result.returncode == 0, (
        f"nginx -t failed: {combined}"
    )
