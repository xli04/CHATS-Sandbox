"""Seed initial users, forums, and a handful of posts.

Runs once on container start if the DB is empty. Idempotent across
container restarts (only runs when users table has 0 rows).
"""
from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timezone, timedelta


def now_iso(offset_seconds: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)) \
        .strftime("%Y-%m-%dT%H:%M:%SZ")


USERS = [
    # (username, password, bio)
    ("MarvelsGrantMan136", "test1234",
     "Bench test user — the one chats-sandbox benchmark prompts target."),
    ("alex_dev",        "test1234", "Software engineer interested in databases."),
    ("rita_writes",     "test1234", "Writing about distributed systems."),
]

FORUMS = [
    # (name, description)
    ("general",     "General discussion."),
    ("tech",        "Technology, software, and tools."),
    ("news",        "Recent news and current events."),
    ("books",       "Reading, recommendations, criticism."),
    ("test",        "Sandbox forum for testing automation."),
]

POSTS = [
    # (author_username, forum_name, title, body)
    ("alex_dev",    "tech",    "Choosing a database for a small SaaS",
     "Looking at Postgres vs SQLite vs Mongo for a 100-user app. Thoughts?"),
    ("rita_writes", "books",   "What are you reading this month?",
     "I'm halfway through 'Computing: A Concise History'. Curious what others picked up."),
    ("alex_dev",    "tech",    "Vim or Helix?",
     "Tried Helix for two weeks. It's nice but I miss telescope. Any converts?"),
    ("rita_writes", "general", "Mid-week catch-up",
     "Just saying hi. What's everyone working on today?"),
    ("MarvelsGrantMan136", "general", "Hello from the bench",
     "This user exists for automated testing — feel free to ignore."),
    ("alex_dev",    "news",    "New JIT compiler announced for Python 3.14",
     "Has anyone benchmarked the prerelease yet?"),
    ("rita_writes", "tech",    "Markdown editors that don't show side-by-side preview",
     "Looking for a clean writing experience. Recommendations welcome."),
    ("alex_dev",    "books",   "Recommendation: 'Working in Public' by Nadia Eghbal",
     "Excellent take on the economics of open source."),
]


def run(db_path: str) -> None:
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Users
    for i, (u, p, bio) in enumerate(USERS):
        cur.execute(
            "INSERT INTO users(username, password, bio, created_at) VALUES (?,?,?,?)",
            (u, p, bio, now_iso(-86400 * (len(USERS) - i))),
        )

    # Forums
    for i, (name, desc) in enumerate(FORUMS):
        cur.execute(
            "INSERT INTO forums(name, description, created_at) VALUES (?,?,?)",
            (name, desc, now_iso(-86400 * (len(FORUMS) - i))),
        )

    # Posts
    user_id = {u: r[0] for u, r in zip(
        [x[0] for x in USERS],
        cur.execute("SELECT id FROM users ORDER BY id").fetchall(),
    )}
    forum_id = {f: r[0] for f, r in zip(
        [x[0] for x in FORUMS],
        cur.execute("SELECT id FROM forums ORDER BY id").fetchall(),
    )}
    for i, (author, forum, title, body) in enumerate(POSTS):
        pid = uuid.uuid4().hex[:12]
        cur.execute(
            "INSERT INTO posts(id, forum_id, author_id, title, body, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (pid, forum_id[forum], user_id[author], title, body,
             now_iso(-3600 * (len(POSTS) - i))),
        )

    conn.commit()
    conn.close()
    print(f"seeded {len(USERS)} users, {len(FORUMS)} forums, {len(POSTS)} posts")
