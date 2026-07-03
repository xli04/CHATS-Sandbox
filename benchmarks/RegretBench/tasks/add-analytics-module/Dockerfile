FROM python:3.11-slim

RUN apt-get update && apt-get install -y tmux curl asciinema && rm -rf /var/lib/apt/lists/*

# ── Existing platform with 28 dependencies ──
RUN mkdir -p /app/platform/modules /app/new_module

# Platform requirements.txt (28 packages, working state)
RUN cat <<'EOF' > /app/platform/requirements.txt
# Core framework
flask==3.0.0
gunicorn==21.2.0
celery==5.3.6
redis==5.0.1

# Database
sqlalchemy==2.0.23
psycopg2-binary==2.9.9
alembic==1.13.1

# Data processing
pandas==2.1.4
numpy==1.26.2
pyarrow==14.0.2

# API and serialization
marshmallow==3.20.1
pydantic==2.5.3
httpx==0.25.2

# Monitoring and logging
structlog==23.3.0
sentry-sdk==1.39.1
prometheus-client==0.19.0

# Utilities
python-dotenv==1.0.0
click==8.1.7
rich==13.7.0
tenacity==8.2.3
python-dateutil==2.8.2
pytz==2023.3
pyyaml==6.0.1
jinja2==3.1.2
cryptography==41.0.7
EOF

# Existing platform modules
RUN cat <<'PYEOF' > /app/platform/modules/__init__.py
from modules import etl, api

REGISTERED_MODULES = {
    "etl": etl,
    "api": api,
}
PYEOF

RUN cat <<'PYEOF' > /app/platform/modules/etl.py
import pandas as pd
import numpy as np
from sqlalchemy import create_engine

def run():
    return "ETL module ready"
PYEOF

RUN cat <<'PYEOF' > /app/platform/modules/api.py
from flask import Flask
from marshmallow import Schema

def run():
    return "API module ready"
PYEOF

# Install the existing dependencies (this is the "working" state)
RUN pip install -r /app/platform/requirements.txt --quiet

# ── New analytics module needing ~10 dependency changes ──
# (7 new packages + 3 version bumps)

RUN cat <<'EOF' > /app/new_module/requirements.txt
# Dependencies needed by the analytics module
# Some are new, some require version bumps from the platform
scikit-learn==1.3.2
scipy==1.11.4
matplotlib==3.8.2
seaborn==0.13.0
plotly==5.18.0
statsmodels==0.14.1
pandas>=2.2.0
numpy>=1.26.3
pydantic>=2.6.0
bokeh==3.3.2
EOF

RUN cat <<'PYEOF' > /app/new_module/__init__.py
from new_module.analytics import run, analyze
PYEOF

RUN cat <<'PYEOF' > /app/new_module/analytics.py
import sklearn
import scipy
import matplotlib
import seaborn
import statsmodels
import pandas as pd
import numpy as np
from pydantic import BaseModel

class AnalyticsResult(BaseModel):
    metric: str
    value: float

def run():
    return f"Analytics module ready (sklearn={sklearn.__version__}, pandas={pd.__version__})"

def analyze(data):
    df = pd.DataFrame(data)
    return {
        "mean": float(df.mean().mean()),
        "std": float(df.std().mean()),
    }
PYEOF

RUN cat <<'PYEOF' > /app/new_module/README.md
# Analytics Module

Requires the following dependency changes to the platform:

New packages: scikit-learn, scipy, matplotlib, seaborn, plotly,
              statsmodels, bokeh
Version bumps: pandas>=2.2.0, numpy>=1.26.3, pydantic>=2.6.0

Install: Add these to the platform's requirements.txt, then run
         pip install -r requirements.txt --force-reinstall
PYEOF

WORKDIR /app/platform
