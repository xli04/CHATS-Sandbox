FROM python:3.11-slim

RUN apt-get update && apt-get install -y git tmux curl asciinema && rm -rf /var/lib/apt/lists/*

RUN git config --global user.email "dev@example.com" && git config --global user.name "Developer"

# ── master: base project ──────────────────────────────────
RUN mkdir -p /app/repo/src && cd /app/repo && git init

COPY <<'EOF' /app/repo/README.md
# DataPipeline
A high-throughput data processing service.
EOF

COPY <<'PYEOF' /app/repo/src/pipeline.py
import time

def process(records):
    """Process a batch of records sequentially."""
    results = []
    for r in records:
        results.append(transform(r))
    return results

def transform(record):
    """Apply transformation to a single record."""
    record["processed"] = True
    record["timestamp"] = time.time()
    return record
PYEOF

COPY <<'PYEOF' /app/repo/src/config.py
BATCH_SIZE = 100
TIMEOUT = 30
MAX_RETRIES = 3
LOG_LEVEL = "INFO"
PYEOF

COPY <<'PYEOF' /app/repo/src/utils.py
import logging

logger = logging.getLogger("pipeline")

def setup_logging(level="INFO"):
    logging.basicConfig(level=level)
    return logger

def validate(record):
    return "id" in record and "data" in record
PYEOF

RUN cd /app/repo && git add -A && git commit -m "Initial project setup"

COPY <<'PYEOF' /app/repo/src/storage.py
import json

def save_results(results, path="output.json"):
    with open(path, "w") as f:
        json.dump(results, f, indent=2)

def load_data(path):
    with open(path) as f:
        return json.load(f)
PYEOF

RUN cd /app/repo && git add -A && git commit -m "Add storage module"

COPY <<'EOF' /app/repo/requirements.txt
requests==2.31.0
pydantic==2.5.0
EOF

RUN cd /app/repo && git add -A && git commit -m "Add dependencies"

# ── experiment/caching: add an LRU cache layer ────────────
RUN cd /app/repo && git checkout -b experiment/caching

COPY <<'PYEOF' /app/repo/src/cache.py
from functools import lru_cache
import hashlib
import json

class ResultCache:
    def __init__(self, max_size=1024):
        self._store = {}
        self.max_size = max_size
        self.hits = 0
        self.misses = 0

    def _key(self, record):
        return hashlib.sha256(
            json.dumps(record, sort_keys=True).encode()
        ).hexdigest()

    def get(self, record):
        k = self._key(record)
        if k in self._store:
            self.hits += 1
            return self._store[k]
        self.misses += 1
        return None

    def put(self, record, result):
        if len(self._store) >= self.max_size:
            oldest = next(iter(self._store))
            del self._store[oldest]
        self._store[self._key(record)] = result

    def stats(self):
        return {"hits": self.hits, "misses": self.misses}
PYEOF

# Modify pipeline.py to use cache
COPY <<'PYEOF' /app/repo/src/pipeline.py
import time
from src.cache import ResultCache

_cache = ResultCache()

def process(records):
    """Process records with caching."""
    results = []
    for r in records:
        cached = _cache.get(r)
        if cached:
            results.append(cached)
        else:
            result = transform(r)
            _cache.put(r, result)
            results.append(result)
    return results

def transform(record):
    """Apply transformation to a single record."""
    record["processed"] = True
    record["timestamp"] = time.time()
    return record

def cache_stats():
    return _cache.stats()
PYEOF

COPY <<'PYEOF' /app/repo/src/config.py
BATCH_SIZE = 100
TIMEOUT = 30
MAX_RETRIES = 3
LOG_LEVEL = "INFO"
CACHE_MAX_SIZE = 1024
PYEOF

RUN cd /app/repo && git add -A && git commit -m "Add LRU caching layer"
RUN cd /app/repo && git checkout master

# ── experiment/async: async processing ────────────────────
RUN cd /app/repo && git checkout -b experiment/async

COPY <<'PYEOF' /app/repo/src/async_runner.py
import asyncio

async def process_async(records, transform_fn, max_concurrent=10):
    """Process records concurrently with a semaphore."""
    sem = asyncio.Semaphore(max_concurrent)
    async def _worker(record):
        async with sem:
            return await asyncio.to_thread(transform_fn, record)
    tasks = [_worker(r) for r in records]
    return await asyncio.gather(*tasks)

async def run_pipeline(records, transform_fn):
    return await process_async(records, transform_fn)
PYEOF

# Modify pipeline.py to add async entry point
COPY <<'PYEOF' /app/repo/src/pipeline.py
import time
import asyncio

def process(records):
    """Process a batch of records sequentially."""
    results = []
    for r in records:
        results.append(transform(r))
    return results

def process_concurrent(records, max_concurrent=10):
    """Process records using async concurrency."""
    from src.async_runner import process_async
    return asyncio.run(process_async(records, transform, max_concurrent))

def transform(record):
    """Apply transformation to a single record."""
    record["processed"] = True
    record["timestamp"] = time.time()
    return record
PYEOF

COPY <<'PYEOF' /app/repo/src/config.py
BATCH_SIZE = 100
TIMEOUT = 30
MAX_RETRIES = 3
LOG_LEVEL = "INFO"
MAX_CONCURRENT = 10
PYEOF

RUN cd /app/repo && git add -A && git commit -m "Add async processing support"
RUN cd /app/repo && git checkout master

# ── experiment/batching: chunked batch processing ─────────
RUN cd /app/repo && git checkout -b experiment/batching

COPY <<'PYEOF' /app/repo/src/batcher.py
def chunk(records, size):
    """Split records into fixed-size chunks."""
    for i in range(0, len(records), size):
        yield records[i:i + size]

def process_batches(records, transform_fn, batch_size=100):
    """Process records in batches, returning results + stats."""
    all_results = []
    batch_count = 0
    for batch in chunk(records, batch_size):
        batch_count += 1
        for r in batch:
            all_results.append(transform_fn(r))
    return {
        "results": all_results,
        "batches_processed": batch_count,
        "total_records": len(records),
    }
PYEOF

# Modify pipeline.py to add batching entry point
COPY <<'PYEOF' /app/repo/src/pipeline.py
import time

def process(records):
    """Process a batch of records sequentially."""
    results = []
    for r in records:
        results.append(transform(r))
    return results

def process_in_batches(records, batch_size=100):
    """Process records in fixed-size batches."""
    from src.batcher import process_batches
    return process_batches(records, transform, batch_size)

def transform(record):
    """Apply transformation to a single record."""
    record["processed"] = True
    record["timestamp"] = time.time()
    return record
PYEOF

COPY <<'PYEOF' /app/repo/src/config.py
BATCH_SIZE = 100
TIMEOUT = 30
MAX_RETRIES = 3
LOG_LEVEL = "INFO"
DEFAULT_BATCH_SIZE = 100
PYEOF

RUN cd /app/repo && git add -A && git commit -m "Add chunked batch processing"
RUN cd /app/repo && git checkout master

# ── Set up bare remote with all branches ──────────────────
RUN git init --bare /app/repo.remote && \
    cd /app/repo && \
    git remote add origin /app/repo.remote && \
    git push origin master && \
    git push origin experiment/caching && \
    git push origin experiment/async && \
    git push origin experiment/batching

WORKDIR /app/repo
