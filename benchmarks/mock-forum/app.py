"""Minimal Reddit-style forum for CHATS-Sandbox benchmarking.

URL shape mirrors Postmill so the existing remote-task prompts work
nearly verbatim:
  /                          → list of all posts (newest first)
  /login                     → login form
  /logout                    → POST: clear session
  /submit                    → form to create a new post
  /post/<id>                 → post detail + comments
  /post/<id>/edit            → form to edit own post
  /post/<id>/delete          → POST: delete own post
  /post/<id>/vote            → POST: toggle upvote / downvote
  /post/<id>/comment         → POST: add comment
  /comment/<id>/delete       → POST: delete own comment
  /user/<name>               → user profile (read)
  /user/<name>/submissions   → user's posts
  /user/<name>/comments      → user's comments
  /account                   → form to edit own bio
  /forums                    → list of forums + subscribe buttons
  /f/<forum>                 → posts in one forum
  /f/<forum>/subscribe       → POST: toggle subscription

No CSRF, no rate limiting, no JS — Playwright drives plain HTML forms.
SQLite via stdlib. State resets on container restart by default.
"""
from __future__ import annotations

import os
import sqlite3
import uuid
from datetime import datetime, timezone

from flask import (
    Flask, request, session, redirect, url_for,
    render_template, flash, abort, g,
)

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("MOCK_FORUM_SECRET", "dev-not-secret")

DB_PATH = os.environ.get("MOCK_FORUM_DB", "/data/forum.db")


# ──────────────────────────────────────────────────────────────────────
# DB helpers
# ──────────────────────────────────────────────────────────────────────

def db() -> sqlite3.Connection:
    if "_db" not in g:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g._db = conn
    return g._db


@app.teardown_appcontext
def _close_db(_exc):
    conn = g.pop("_db", None)
    if conn is not None:
        conn.close()


def init_db():
    """Create schema if missing. Seed if empty. Idempotent."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            username    TEXT UNIQUE NOT NULL,
            password    TEXT NOT NULL,
            bio         TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS forums (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT UNIQUE NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS posts (
            id          TEXT PRIMARY KEY,         -- uuid so re-creates are observable
            forum_id    INTEGER NOT NULL REFERENCES forums(id) ON DELETE CASCADE,
            author_id   INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
            title       TEXT NOT NULL,
            body        TEXT NOT NULL DEFAULT '',
            score       INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            edited_at   TEXT
        );

        CREATE TABLE IF NOT EXISTS comments (
            id          TEXT PRIMARY KEY,
            post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
            author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            body        TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS votes (
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            post_id     TEXT    NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
            value       INTEGER NOT NULL CHECK (value IN (-1, 1)),
            PRIMARY KEY (user_id, post_id)
        );

        CREATE TABLE IF NOT EXISTS subscriptions (
            user_id     INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
            forum_id    INTEGER NOT NULL REFERENCES forums(id)  ON DELETE CASCADE,
            PRIMARY KEY (user_id, forum_id)
        );
    """)
    n_users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    conn.commit()
    conn.close()
    # Seed once if the DB is fresh.
    if n_users == 0:
        import seed
        seed.run(DB_PATH)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def current_user():
    uid = session.get("user_id")
    if uid is None:
        return None
    row = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    return row


def require_user():
    u = current_user()
    if u is None:
        flash("Please log in.", "error")
        abort(redirect(url_for("login")))
    return u


# ──────────────────────────────────────────────────────────────────────
# Template helpers
# ──────────────────────────────────────────────────────────────────────

@app.context_processor
def _ctx():
    return {"user": current_user(), "now": datetime.utcnow}


# ──────────────────────────────────────────────────────────────────────
# Auth
# ──────────────────────────────────────────────────────────────────────

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        u = request.form.get("username", "").strip()
        p = request.form.get("password", "")
        row = db().execute(
            "SELECT * FROM users WHERE username=? AND password=?", (u, p)
        ).fetchone()
        if row is None:
            flash("Invalid username or password.", "error")
            return render_template("login.html"), 401
        session["user_id"] = row["id"]
        flash(f"Logged in as {row['username']}.", "ok")
        return redirect(url_for("index"))
    return render_template("login.html")


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    flash("Logged out.", "ok")
    return redirect(url_for("index"))


# ──────────────────────────────────────────────────────────────────────
# Posts
# ──────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    rows = db().execute("""
        SELECT p.*, u.username AS author, f.name AS forum
        FROM posts p
        JOIN users  u ON u.id = p.author_id
        JOIN forums f ON f.id = p.forum_id
        ORDER BY p.created_at DESC
        LIMIT 50
    """).fetchall()
    return render_template("index.html", posts=rows, scope="all")


@app.route("/all")
def all_posts():
    return index()


@app.route("/submit", methods=["GET", "POST"])
def submit():
    u = require_user()
    forums = db().execute("SELECT * FROM forums ORDER BY name").fetchall()
    if request.method == "POST":
        title = request.form.get("title", "").strip()
        body  = request.form.get("body", "").strip()
        forum_name = request.form.get("forum", "").strip()
        if not title or not forum_name:
            flash("Title and forum are required.", "error")
            return render_template("submit.html", forums=forums), 400
        forum = db().execute("SELECT * FROM forums WHERE name=?", (forum_name,)).fetchone()
        if forum is None:
            flash(f"Forum '{forum_name}' not found.", "error")
            return render_template("submit.html", forums=forums), 400
        pid = uuid.uuid4().hex[:12]
        db().execute(
            "INSERT INTO posts(id, forum_id, author_id, title, body, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (pid, forum["id"], u["id"], title, body, now_iso()),
        )
        db().commit()
        flash("Post created.", "ok")
        return redirect(url_for("post_detail", post_id=pid))
    return render_template("submit.html", forums=forums)


@app.route("/post/<post_id>")
def post_detail(post_id: str):
    row = db().execute("""
        SELECT p.*, u.username AS author, f.name AS forum
        FROM posts p
        JOIN users  u ON u.id = p.author_id
        JOIN forums f ON f.id = p.forum_id
        WHERE p.id = ?
    """, (post_id,)).fetchone()
    if row is None:
        abort(404)
    comments = db().execute("""
        SELECT c.*, u.username AS author
        FROM comments c JOIN users u ON u.id = c.author_id
        WHERE c.post_id = ? ORDER BY c.created_at ASC
    """, (post_id,)).fetchall()
    return render_template("post.html", post=row, comments=comments)


@app.route("/post/<post_id>/edit", methods=["GET", "POST"])
def post_edit(post_id: str):
    u = require_user()
    row = db().execute("SELECT * FROM posts WHERE id=?", (post_id,)).fetchone()
    if row is None: abort(404)
    if row["author_id"] != u["id"]:
        flash("You can only edit your own posts.", "error")
        abort(403)
    if request.method == "POST":
        new_body = request.form.get("body", "").strip()
        db().execute(
            "UPDATE posts SET body=?, edited_at=? WHERE id=?",
            (new_body, now_iso(), post_id),
        )
        db().commit()
        flash("Post edited.", "ok")
        return redirect(url_for("post_detail", post_id=post_id))
    return render_template("post_edit.html", post=row)


@app.route("/post/<post_id>/delete", methods=["POST"])
def post_delete(post_id: str):
    u = require_user()
    row = db().execute("SELECT * FROM posts WHERE id=?", (post_id,)).fetchone()
    if row is None: abort(404)
    if row["author_id"] != u["id"]:
        flash("You can only delete your own posts.", "error")
        abort(403)
    db().execute("DELETE FROM posts WHERE id=?", (post_id,))
    db().commit()
    flash("Post deleted.", "ok")
    return redirect(url_for("user_submissions", username=u["username"]))


@app.route("/post/<post_id>/vote", methods=["POST"])
def post_vote(post_id: str):
    u = require_user()
    direction = request.form.get("direction", "up")
    new_value = 1 if direction == "up" else -1
    existing = db().execute(
        "SELECT value FROM votes WHERE user_id=? AND post_id=?",
        (u["id"], post_id),
    ).fetchone()
    if existing is None:
        db().execute(
            "INSERT INTO votes(user_id, post_id, value) VALUES (?,?,?)",
            (u["id"], post_id, new_value),
        )
        delta = new_value
    elif existing["value"] == new_value:
        # Toggle off
        db().execute("DELETE FROM votes WHERE user_id=? AND post_id=?",
                     (u["id"], post_id))
        delta = -new_value
    else:
        # Flip direction
        db().execute("UPDATE votes SET value=? WHERE user_id=? AND post_id=?",
                     (new_value, u["id"], post_id))
        delta = 2 * new_value
    db().execute("UPDATE posts SET score = score + ? WHERE id=?", (delta, post_id))
    db().commit()
    return redirect(request.referrer or url_for("post_detail", post_id=post_id))


# ──────────────────────────────────────────────────────────────────────
# Comments
# ──────────────────────────────────────────────────────────────────────

@app.route("/post/<post_id>/comment", methods=["POST"])
def comment_create(post_id: str):
    u = require_user()
    body = request.form.get("body", "").strip()
    if not body:
        flash("Comment cannot be empty.", "error")
        return redirect(url_for("post_detail", post_id=post_id))
    cid = uuid.uuid4().hex[:12]
    db().execute(
        "INSERT INTO comments(id, post_id, author_id, body, created_at) "
        "VALUES (?,?,?,?,?)",
        (cid, post_id, u["id"], body, now_iso()),
    )
    db().commit()
    flash("Comment posted.", "ok")
    return redirect(url_for("post_detail", post_id=post_id))


@app.route("/comment/<comment_id>/delete", methods=["POST"])
def comment_delete(comment_id: str):
    u = require_user()
    row = db().execute("SELECT * FROM comments WHERE id=?", (comment_id,)).fetchone()
    if row is None: abort(404)
    if row["author_id"] != u["id"]:
        flash("You can only delete your own comments.", "error")
        abort(403)
    post_id = row["post_id"]
    db().execute("DELETE FROM comments WHERE id=?", (comment_id,))
    db().commit()
    flash("Comment deleted.", "ok")
    return redirect(url_for("post_detail", post_id=post_id))


# ──────────────────────────────────────────────────────────────────────
# Users
# ──────────────────────────────────────────────────────────────────────

@app.route("/user/<username>")
def user_profile(username: str):
    return user_submissions(username)


@app.route("/user/<username>/submissions")
def user_submissions(username: str):
    row = db().execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if row is None: abort(404)
    posts = db().execute("""
        SELECT p.*, u.username AS author, f.name AS forum
        FROM posts p
        JOIN users  u ON u.id = p.author_id
        JOIN forums f ON f.id = p.forum_id
        WHERE p.author_id = ?
        ORDER BY p.created_at DESC
    """, (row["id"],)).fetchall()
    return render_template("user.html", profile=row, posts=posts, scope="submissions")


@app.route("/user/<username>/comments")
def user_comments(username: str):
    row = db().execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if row is None: abort(404)
    comments = db().execute("""
        SELECT c.*, u.username AS author, p.title AS post_title
        FROM comments c
        JOIN users u ON u.id = c.author_id
        JOIN posts p ON p.id = c.post_id
        WHERE c.author_id = ?
        ORDER BY c.created_at DESC
    """, (row["id"],)).fetchall()
    return render_template("user_comments.html", profile=row, comments=comments)


@app.route("/account", methods=["GET", "POST"])
def account():
    u = require_user()
    if request.method == "POST":
        new_bio = request.form.get("bio", "").strip()
        db().execute("UPDATE users SET bio=? WHERE id=?", (new_bio, u["id"]))
        db().commit()
        flash("Profile updated.", "ok")
        return redirect(url_for("account"))
    return render_template("account.html", profile=u)


# ──────────────────────────────────────────────────────────────────────
# Forums
# ──────────────────────────────────────────────────────────────────────

@app.route("/forums")
def forums_index():
    u = current_user()
    rows = db().execute("SELECT * FROM forums ORDER BY name").fetchall()
    subs = set()
    if u is not None:
        subs = {r["forum_id"] for r in db().execute(
            "SELECT forum_id FROM subscriptions WHERE user_id=?", (u["id"],),
        ).fetchall()}
    return render_template("forums.html", forums=rows, subs=subs)


@app.route("/f/<forum_name>")
def forum_view(forum_name: str):
    row = db().execute("SELECT * FROM forums WHERE name=?", (forum_name,)).fetchone()
    if row is None: abort(404)
    posts = db().execute("""
        SELECT p.*, u.username AS author, f.name AS forum
        FROM posts p
        JOIN users  u ON u.id = p.author_id
        JOIN forums f ON f.id = p.forum_id
        WHERE p.forum_id = ?
        ORDER BY p.created_at DESC
    """, (row["id"],)).fetchall()
    return render_template("forum.html", forum=row, posts=posts)


@app.route("/f/<forum_name>/subscribe", methods=["POST"])
def forum_subscribe(forum_name: str):
    u = require_user()
    forum = db().execute("SELECT * FROM forums WHERE name=?", (forum_name,)).fetchone()
    if forum is None: abort(404)
    existing = db().execute(
        "SELECT 1 FROM subscriptions WHERE user_id=? AND forum_id=?",
        (u["id"], forum["id"]),
    ).fetchone()
    if existing:
        db().execute("DELETE FROM subscriptions WHERE user_id=? AND forum_id=?",
                     (u["id"], forum["id"]))
        flash(f"Unsubscribed from {forum_name}.", "ok")
    else:
        db().execute("INSERT INTO subscriptions(user_id, forum_id) VALUES (?,?)",
                     (u["id"], forum["id"]))
        flash(f"Subscribed to {forum_name}.", "ok")
    db().commit()
    return redirect(request.referrer or url_for("forums_index"))


# ──────────────────────────────────────────────────────────────────────
# Boot
# ──────────────────────────────────────────────────────────────────────

# Run schema + seed at import time so gunicorn workers see a ready DB
# without each worker racing to init. Safe because init_db is idempotent.
init_db()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), debug=False)
