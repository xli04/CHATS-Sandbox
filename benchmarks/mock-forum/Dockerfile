# Minimal mock-forum container — used as a Postmill stand-in for the
# CHATS-Sandbox remote-services benchmark suite.

FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py seed.py ./
COPY templates/ ./templates/

ENV PORT=8080 \
    MOCK_FORUM_DB=/data/forum.db \
    PYTHONUNBUFFERED=1

EXPOSE 8080

# Use gunicorn in case multiple Playwright sessions hit us concurrently.
# init_db (schema + seed) runs automatically on app.py import.
CMD ["sh", "-c", "python -m gunicorn -w 2 -b 0.0.0.0:${PORT} --access-logfile - app:app"]
