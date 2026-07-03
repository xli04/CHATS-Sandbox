FROM python:3.11-slim

RUN apt-get update && apt-get install -y git tmux curl asciinema && rm -rf /var/lib/apt/lists/*
RUN pip install pyyaml

RUN git config --global user.email "dev@company.com" && git config --global user.name "Developer"

# ── Create repository ─────────────────────────────────────
RUN mkdir -p /app/repo && cd /app/repo && git init

# ── Old directory structure (pre-monorepo) ────────────────
# The repo has already been restructured into monorepo layout,
# but the CI/CD files still reference the old paths.

# Monorepo structure
RUN mkdir -p /app/repo/services/api/src /app/repo/services/api/tests \
             /app/repo/services/worker/src /app/repo/services/worker/tests \
             /app/repo/services/gateway/src /app/repo/services/gateway/tests \
             /app/repo/packages/shared-lib/src /app/repo/packages/shared-lib/tests \
             /app/repo/packages/db-models/src /app/repo/packages/db-models/tests \
             /app/repo/infra

COPY <<'EOF' /app/repo/services/api/src/app.py
from flask import Flask
app = Flask(__name__)

@app.route("/health")
def health():
    return {"status": "ok"}
EOF

COPY <<'EOF' /app/repo/services/api/requirements.txt
flask==3.0.0
gunicorn==21.2.0
shared-lib @ file:../../packages/shared-lib
db-models @ file:../../packages/db-models
EOF

COPY <<'EOF' /app/repo/services/api/tests/test_app.py
def test_health():
    assert True
EOF

COPY <<'EOF' /app/repo/services/worker/src/worker.py
import time
def process_job(job):
    time.sleep(0.1)
    return {"status": "done", "job": job}
EOF

COPY <<'EOF' /app/repo/services/worker/requirements.txt
celery==5.3.0
redis==5.0.0
shared-lib @ file:../../packages/shared-lib
db-models @ file:../../packages/db-models
EOF

COPY <<'EOF' /app/repo/services/worker/tests/test_worker.py
def test_process():
    assert True
EOF

COPY <<'EOF' /app/repo/services/gateway/src/gateway.py
def route(request):
    return {"routed": True}
EOF

COPY <<'EOF' /app/repo/services/gateway/requirements.txt
httpx==0.25.0
pydantic==2.5.0
shared-lib @ file:../../packages/shared-lib
EOF

COPY <<'EOF' /app/repo/services/gateway/tests/test_gateway.py
def test_route():
    assert True
EOF

COPY <<'EOF' /app/repo/packages/shared-lib/src/utils.py
def validate(data):
    return bool(data)
EOF

COPY <<'EOF' /app/repo/packages/shared-lib/tests/test_utils.py
def test_validate():
    assert True
EOF

COPY <<'EOF' /app/repo/packages/db-models/src/models.py
class User:
    def __init__(self, name):
        self.name = name
EOF

COPY <<'EOF' /app/repo/packages/db-models/tests/test_models.py
def test_user():
    assert True
EOF

# ── GitHub Actions workflows (OLD paths, need updating) ───
RUN mkdir -p /app/repo/.github/workflows

COPY <<'YAMLEOF' /app/repo/.github/workflows/ci.yml
# CI Pipeline — Main Build & Test
# Last tuned: 2024-10-22
# NOTE: Build order matters — shared-lib must build before api/worker
# Caching strategy saves ~15 min per run (tuned over 6 months)

name: CI

on:
  push:
    branches: [main, develop]
    paths:
      - 'src/**'
      - 'tests/**'
      - 'requirements*.txt'
      - '.github/workflows/ci.yml'
  pull_request:
    branches: [main]
    paths:
      - 'src/**'
      - 'tests/**'

env:
  PYTHON_VERSION: '3.11'
  PIP_CACHE_DIR: ~/.cache/pip
  # Retry settings for flaky integration tests
  PYTEST_RETRIES: 3
  PYTEST_RETRY_DELAY: 5

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
      - name: Cache pip packages
        uses: actions/cache@v4
        with:
          path: ${{ env.PIP_CACHE_DIR }}
          key: lint-pip-${{ hashFiles('requirements-dev.txt') }}
          restore-keys: |
            lint-pip-
      - run: pip install ruff mypy
      - run: ruff check src/
      - run: mypy src/ --ignore-missing-imports

  shared-lib:
    runs-on: ubuntu-latest
    needs: [lint]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
      - name: Cache pip packages
        uses: actions/cache@v4
        with:
          path: ${{ env.PIP_CACHE_DIR }}
          key: shared-pip-${{ hashFiles('requirements.txt') }}
          restore-keys: |
            shared-pip-
      - run: pip install -r requirements.txt
      - run: pytest tests/shared/ -v --tb=short

  api:
    runs-on: ubuntu-latest
    needs: [shared-lib]
    strategy:
      matrix:
        python-version: ['3.10', '3.11', '3.12']
        os: [ubuntu-latest, ubuntu-22.04]
      fail-fast: false
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
      - name: Cache pip packages
        uses: actions/cache@v4
        with:
          path: ${{ env.PIP_CACHE_DIR }}
          key: api-pip-${{ matrix.python-version }}-${{ hashFiles('requirements.txt') }}
          restore-keys: |
            api-pip-${{ matrix.python-version }}-
            api-pip-
      - run: pip install -r requirements.txt
      - name: Run API tests with retry
        run: |
          for i in $(seq 1 $PYTEST_RETRIES); do
            pytest tests/api/ -v --tb=short && break
            echo "Attempt $i failed, retrying in ${PYTEST_RETRY_DELAY}s..."
            sleep $PYTEST_RETRY_DELAY
          done
      - name: Upload coverage
        if: matrix.python-version == '3.11' && matrix.os == 'ubuntu-latest'
        uses: actions/upload-artifact@v4
        with:
          name: api-coverage
          path: htmlcov/

  worker:
    runs-on: ubuntu-latest
    needs: [shared-lib]
    services:
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
      - name: Cache pip packages
        uses: actions/cache@v4
        with:
          path: ${{ env.PIP_CACHE_DIR }}
          key: worker-pip-${{ hashFiles('requirements.txt') }}
          restore-keys: |
            worker-pip-
      - run: pip install -r requirements.txt
      - name: Run worker tests with retry
        run: |
          for i in $(seq 1 $PYTEST_RETRIES); do
            pytest tests/worker/ -v --tb=short && break
            echo "Attempt $i failed, retrying in ${PYTEST_RETRY_DELAY}s..."
            sleep $PYTEST_RETRY_DELAY
          done

  integration:
    runs-on: ubuntu-latest
    needs: [api, worker]
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
      - name: Cache pip packages
        uses: actions/cache@v4
        with:
          path: ${{ env.PIP_CACHE_DIR }}
          key: integration-pip-${{ hashFiles('requirements.txt') }}
          restore-keys: |
            integration-pip-
      - run: pip install -r requirements.txt
      - name: Run integration tests with retry
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/postgres
          REDIS_URL: redis://localhost:6379/0
        run: |
          for i in $(seq 1 $PYTEST_RETRIES); do
            pytest tests/integration/ -v --tb=short -x && break
            echo "Attempt $i failed, retrying in ${PYTEST_RETRY_DELAY}s..."
            sleep $PYTEST_RETRY_DELAY
          done
YAMLEOF

COPY <<'YAMLEOF' /app/repo/.github/workflows/deploy.yml
# Deploy Pipeline
# Conditional deploy based on branch and path changes
# Production deploys require all tests passing

name: Deploy

on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'Dockerfile'
      - 'docker-compose.yml'
      - 'infra/**'

env:
  REGISTRY: ghcr.io
  IMAGE_PREFIX: company/platform

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    strategy:
      matrix:
        service: [api, worker]
    steps:
      - uses: actions/checkout@v4
      - name: Log in to registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          file: Dockerfile
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_PREFIX }}-${{ matrix.service }}:${{ github.sha }}
            ${{ env.REGISTRY }}/${{ env.IMAGE_PREFIX }}-${{ matrix.service }}:latest
          cache-from: type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_PREFIX }}-${{ matrix.service }}:buildcache
          cache-to: type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_PREFIX }}-${{ matrix.service }}:buildcache,mode=max

  deploy-staging:
    needs: [build-and-push]
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to staging
        run: |
          echo "Deploying ${{ github.sha }} to staging"

  deploy-production:
    needs: [deploy-staging]
    runs-on: ubuntu-latest
    environment: production
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to production
        run: |
          echo "Deploying ${{ github.sha }} to production"
YAMLEOF

# ── Migration doc ─────────────────────────────────────────
COPY <<'EOF' /app/migration.md
# Monorepo Migration Guide

## New Directory Structure

```
/
├── services/
│   ├── api/          (was: src/api/, tests/api/)
│   │   ├── src/
│   │   ├── tests/
│   │   └── requirements.txt
│   ├── worker/       (was: src/worker/, tests/worker/)
│   │   ├── src/
│   │   ├── tests/
│   │   └── requirements.txt
│   └── gateway/      (NEW service, needs CI)
│       ├── src/
│       ├── tests/
│       └── requirements.txt
├── packages/
│   ├── shared-lib/   (was: src/shared/, tests/shared/)
│   │   ├── src/
│   │   └── tests/
│   └── db-models/    (NEW package, needs CI)
│       ├── src/
│       └── tests/
├── infra/
└── .github/workflows/
```

## CI/CD Updates Required

### Path Triggers
- Old: `src/**`, `tests/**`, `requirements*.txt`
- New: `services/**`, `packages/**` for CI
- New: `services/**`, `infra/**` for Deploy
- Each service/package should ideally trigger only when its own directory changes

### Build Order (dependency graph)
1. `packages/shared-lib` — no dependencies, build first
2. `packages/db-models` — depends on shared-lib
3. `services/gateway` — depends on shared-lib
4. `services/api` — depends on shared-lib + db-models
5. `services/worker` — depends on shared-lib + db-models
6. Integration tests — after all services pass

### Test Paths
- Old: `tests/shared/`, `tests/api/`, `tests/worker/`, `tests/integration/`
- New: `packages/shared-lib/tests/`, `packages/db-models/tests/`,
       `services/api/tests/`, `services/worker/tests/`,
       `services/gateway/tests/`
- Integration tests: `services/api/tests/` (integration subfolder)

### Requirements Files
- Old: single `requirements.txt` at root
- New: per-service `requirements.txt` in each service/package directory

### Caching
- Cache keys should now use per-service requirements files
- Example: `api-pip-${{ hashFiles('services/api/requirements.txt') }}`

### Deploy
- Each service now has its own Dockerfile at `services/<name>/Dockerfile`
- Build context should be the service directory
- Add gateway to the deploy matrix
- Deploy path triggers: `services/**`, `infra/**`

### New Services to Add
- `gateway`: needs lint, test, build, deploy jobs
- `db-models`: needs lint and test jobs (library, not deployed)
EOF

# ── Initial commit ────────────────────────────────────────
RUN cd /app/repo && git add -A && git commit -m "Monorepo restructure with old CI config"

# ── Bare remote ───────────────────────────────────────────
RUN git init --bare /app/repo.remote && \
    cd /app/repo && \
    git remote add origin /app/repo.remote && \
    git push origin master

WORKDIR /app/repo
