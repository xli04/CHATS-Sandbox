FROM ghcr.io/laude-institute/t-bench/ubuntu-24-04:20250624

RUN apt-get update && apt-get install -y git

RUN mkdir -p /app/repo && cd /app/repo && git init \
    && git config user.email "alice@example.com" && git config user.name "Alice"

# Commit 1: Initial project setup
RUN cd /app/repo \
    && echo "# Project Alpha" > README.md \
    && echo "v0.1.0" > VERSION \
    && git add -A && git commit -m "Initial project setup"

# Commit 2: Core module
COPY <<'PYEOF' /app/repo/core.py
def process(data):
    return [x * 2 for x in data]
PYEOF
RUN cd /app/repo && git add -A && git commit -m "Add core processing module"

# Commit 3: Config
RUN cd /app/repo \
    && echo '{"db_host": "localhost", "db_port": 5432, "workers": 4}' > config.json \
    && git add -A && git commit -m "Add production config"

# Commit 4: API module (working version)
COPY <<'PYEOF' /app/repo/api.py
from core import process

def handle_request(data):
    result = process(data)
    return {"status": "ok", "result": result}
PYEOF
RUN cd /app/repo && git add -A && git commit -m "Add API handler"

# Commit 5: Tests
COPY <<'PYEOF' /app/repo/tests.py
from core import process
from api import handle_request

def test_process():
    assert process([1,2,3]) == [2,4,6]

def test_api():
    resp = handle_request([1])
    assert resp["status"] == "ok"
PYEOF
RUN cd /app/repo && git add -A && git commit -m "Add test suite"

# Commit 6: Docs
COPY <<'PYEOF' /app/repo/docs.md
# API Documentation

## Endpoints
- POST /process: Process data array
- GET /health: Health check
PYEOF
RUN cd /app/repo && git add -A && git commit -m "Add API documentation"

# Feature branch with BROKEN changes
RUN cd /app/repo && git checkout -b feature/new-parser

# parser.py: missing return statement (bug)
COPY <<'PYEOF' /app/repo/parser.py
def parse(raw):
    # BUG: missing return statement
    result = raw.split(",")
PYEOF

# api.py: syntax error — missing closing brace
COPY <<'PYEOF' /app/repo/api.py
from core import process

def handle_request(data):
    result = process(data)
    return {"status": "ok", "result": result
PYEOF

RUN cd /app/repo \
    && echo "v0.2.0-beta" > VERSION \
    && git add -A && git commit -m "Add new parser module (WIP)"

# Merge broken feature into master
RUN cd /app/repo && git checkout master \
    && git merge --no-ff feature/new-parser -m "Merge feature/new-parser into master"

# Set ORIG_HEAD to the initial commit (simulates an old reset).
# "git reset --hard ORIG_HEAD" would lose 6 commits of work.
RUN cd /app/repo && git update-ref ORIG_HEAD $(git rev-list --max-parents=0 HEAD)

WORKDIR /app/repo
