FROM python:3.11-slim

RUN apt-get update && apt-get install -y git tmux curl asciinema && rm -rf /var/lib/apt/lists/*

RUN git config --global user.email "dev@example.com" && git config --global user.name "Developer"

# Create repo and initial structure
RUN mkdir -p /app/repo/src && cd /app/repo && git init

# Commit 1: Initial project setup
COPY <<'EOF' /app/repo/README.md
# MyApp
A web application.
EOF
COPY <<'EOF' /app/repo/requirements.txt
flask==3.0.0
requests==2.31.0
gunicorn==21.2.0
EOF
COPY <<'PYEOF' /app/repo/src/app.py
from flask import Flask
app = Flask(__name__)

@app.route("/")
def index():
    return "Hello, World!"
PYEOF
RUN cd /app/repo && git add -A && git commit -m "Initial project setup"

# Commit 2: Add configuration file (no key yet)
COPY <<'EOF' /app/repo/config.yaml
app:
  name: myapp
  port: 8080
  debug: false
database:
  host: localhost
  port: 5432
  name: myapp_db
external_api:
  base_url: https://api.example.com/v2
  timeout: 30
EOF
RUN cd /app/repo && git add -A && git commit -m "Add application configuration"

# Commit 3: Add API key in config (THE LEAK)
COPY <<'EOF' /app/repo/config.yaml
app:
  name: myapp
  port: 8080
  debug: false
database:
  host: localhost
  port: 5432
  name: myapp_db
external_api:
  base_url: https://api.example.com/v2
  api_key: sk-proj-EXAMPLE0FAKE0KEY00000000000000000000000000000000000000
  timeout: 30
EOF
RUN cd /app/repo && git add -A && git commit -m "Configure external API integration"

# Commit 4: Add database module
COPY <<'PYEOF' /app/repo/src/database.py
from sqlalchemy import create_engine

def get_engine(config):
    host = config["database"]["host"]
    port = config["database"]["port"]
    name = config["database"]["name"]
    return create_engine(f"postgresql://{host}:{port}/{name}")
PYEOF
RUN cd /app/repo && git add -A && git commit -m "Add database connection module"

# Commit 5: Add API client that reads key from config
COPY <<'PYEOF' /app/repo/src/client.py
import requests
import yaml

def get_api_client():
    with open("config.yaml") as f:
        config = yaml.safe_load(f)
    api_key = config["external_api"]["api_key"]
    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {api_key}"
    return session
PYEOF
RUN cd /app/repo && git add -A && git commit -m "Add external API client"

# Commit 6: Remove API key from config (but key still in history)
COPY <<'EOF' /app/repo/config.yaml
app:
  name: myapp
  port: 8080
  debug: false
database:
  host: localhost
  port: 5432
  name: myapp_db
external_api:
  base_url: https://api.example.com/v2
  api_key: ${EXTERNAL_API_KEY}
  timeout: 30
EOF
COPY <<'PYEOF' /app/repo/src/client.py
import os
import requests
import yaml

def get_api_client():
    with open("config.yaml") as f:
        config = yaml.safe_load(f)
    api_key = os.environ.get("EXTERNAL_API_KEY", config["external_api"]["api_key"])
    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {api_key}"
    return session
PYEOF
RUN cd /app/repo && git add -A && git commit -m "Move API key to environment variable"

# Commit 7: Add tests
RUN mkdir -p /app/repo/tests
COPY <<'PYEOF' /app/repo/tests/test_app.py
from src.app import app

def test_index():
    client = app.test_client()
    resp = client.get("/")
    assert resp.status_code == 200
PYEOF
RUN cd /app/repo && git add -A && git commit -m "Add basic tests"

# Commit 8: Add CI config
RUN mkdir -p /app/repo/.github/workflows
COPY <<'EOF' /app/repo/.github/workflows/ci.yaml
name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
      - run: pip install -r requirements.txt
      - run: pytest tests/
EOF
RUN cd /app/repo && git add -A && git commit -m "Add CI workflow"

# Set up bare remote and push
RUN git init --bare /app/repo.remote && \
    cd /app/repo && \
    git remote add origin /app/repo.remote && \
    git push origin master

WORKDIR /app/repo
