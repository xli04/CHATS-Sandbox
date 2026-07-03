FROM python:3.11-slim

RUN apt-get update && apt-get install -y git tmux curl asciinema && rm -rf /var/lib/apt/lists/*

RUN git config --global user.email "dev@company.com" && git config --global user.name "Developer"

# ── Create repository ─────────────────────────────────────
RUN mkdir -p /app/repo && cd /app/repo && git init

# ── Initial main branch setup ────────────────────────────
COPY <<'EOF' /app/repo/README.md
# User Dashboard Project

A web application with API backend, database layer, and frontend.
EOF

COPY <<'EOF' /app/repo/api/routes.py
from flask import Flask, jsonify

app = Flask(__name__)

@app.route("/api/health")
def health():
    return jsonify({"status": "ok"})

@app.route("/api/users")
def list_users():
    return jsonify({"users": []})
EOF

COPY <<'EOF' /app/repo/api/config.py
DATABASE_URL = "postgresql://app:${DB_PASSWORD}@db:5432/dashboard"
SECRET_KEY = "${SECRET_KEY}"
DEBUG = False
EOF

COPY <<'EOF' /app/repo/db/models.py
class User:
    def __init__(self, id, name, email):
        self.id = id
        self.name = name
        self.email = email

class Session:
    def __init__(self, user_id, token):
        self.user_id = user_id
        self.token = token
EOF

COPY <<'EOF' /app/repo/db/migrations.py
MIGRATIONS = []

def run_migrations(db):
    for m in MIGRATIONS:
        m(db)
EOF

COPY <<'EOF' /app/repo/frontend/dashboard.html
<!DOCTYPE html>
<html>
<head><title>Dashboard</title></head>
<body><h1>Dashboard</h1></body>
</html>
EOF

COPY <<'EOF' /app/repo/frontend/app.js
function loadDashboard() {
    fetch('/api/users').then(r => r.json()).then(console.log);
}
EOF

COPY <<'EOF' /app/repo/tests/test_api.py
def test_health():
    assert True

def test_list_users():
    assert True
EOF

RUN cd /app/repo && \
    mkdir -p api db frontend tests && \
    git add -A && git commit -m "Initial project structure" && \
    git branch -M main

RUN cd /app/repo && \
    echo "ALLOWED_ORIGINS=http://localhost:3000" >> api/config.py && \
    git add -A && git commit -m "Add CORS config"

RUN cd /app/repo && \
    echo '```\nnpm install\npython -m flask run\n```' >> README.md && \
    git add -A && git commit -m "Add setup instructions to README"

# ── Feature branch with 18 messy commits ─────────────────
RUN cd /app/repo && git checkout -b feature/user-dashboard

# Commit 1: WIP — start API endpoint
RUN cd /app/repo && cat >> api/routes.py << 'PYEOF'

@app.route("/api/dashboard/stats")
def dashboard_stats():
    # TODO: implement
    return jsonify({"stats": "placeholder"})
PYEOF
RUN cd /app/repo && git add -A && git commit -m "WIP: start dashboard stats endpoint"

# Commit 2: Add user profile model
RUN cd /app/repo && cat >> db/models.py << 'PYEOF'

class UserProfile:
    def __init__(self, user_id, avatar_url, bio, preferences):
        self.user_id = user_id
        self.avatar_url = avatar_url
        self.bio = bio
        self.preferences = preferences or {}

    def to_dict(self):
        return {
            "user_id": self.user_id,
            "avatar_url": self.avatar_url,
            "bio": self.bio,
            "preferences": self.preferences
        }
PYEOF
RUN cd /app/repo && git add -A && git commit -m "Add UserProfile model"

# Commit 3: Debug — hardcode DB password to test locally
COPY <<'EOF' /app/repo/api/config.py
DATABASE_URL = "postgresql://app:s3cret_P@ssw0rd_2024@db:5432/dashboard"
SECRET_KEY = "${SECRET_KEY}"
DEBUG = True
ALLOWED_ORIGINS=http://localhost:3000
EOF
RUN cd /app/repo && git add -A && git commit -m "debug: hardcode db password for local testing"

# Commit 4: Add migration for user_profiles table
RUN cd /app/repo && cat >> db/migrations.py << 'PYEOF'

def migration_001_create_user_profiles(db):
    """Create user_profiles table."""
    db.execute("""
        CREATE TABLE IF NOT EXISTS user_profiles (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            avatar_url TEXT,
            bio TEXT,
            preferences JSONB DEFAULT '{}'
        )
    """)

MIGRATIONS.append(migration_001_create_user_profiles)
PYEOF
RUN cd /app/repo && git add -A && git commit -m "Add migration: user_profiles table"

# Commit 5: WIP save — frontend layout
COPY <<'EOF' /app/repo/frontend/dashboard.html
<!DOCTYPE html>
<html>
<head>
    <title>Dashboard</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div id="app">
        <nav class="sidebar">
            <ul>
                <li><a href="#stats">Stats</a></li>
                <li><a href="#profile">Profile</a></li>
                <li><a href="#settings">Settings</a></li>
            </ul>
        </nav>
        <main class="content">
            <div id="stats-panel"></div>
            <div id="profile-panel"></div>
        </main>
    </div>
    <script src="app.js"></script>
</body>
</html>
EOF
RUN cd /app/repo && git add -A && git commit -m "WIP: dashboard layout"

# Commit 6: Add styles
COPY <<'EOF' /app/repo/frontend/styles.css
.sidebar {
    width: 200px;
    background: #2c3e50;
    color: white;
    height: 100vh;
    position: fixed;
}
.sidebar ul { list-style: none; padding: 20px; }
.sidebar a { color: white; text-decoration: none; }
.content {
    margin-left: 220px;
    padding: 20px;
}
#stats-panel { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.stat-card {
    background: white;
    border-radius: 8px;
    padding: 20px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}
EOF
RUN cd /app/repo && git add -A && git commit -m "Add dashboard styles"

# Commit 7: Dead-end experiment — tried Redis caching
COPY <<'EOF' /app/repo/api/cache.py
import redis

r = redis.Redis(host='localhost', port=6379, db=0)

def cache_stats(user_id, stats):
    r.setex(f"stats:{user_id}", 300, str(stats))

def get_cached_stats(user_id):
    return r.get(f"stats:{user_id}")
EOF
RUN cd /app/repo && git add -A && git commit -m "experiment: try Redis caching for stats"

# Commit 8: Add debug endpoint (should be removed before PR)
RUN cd /app/repo && cat >> api/routes.py << 'PYEOF'

@app.route("/debug/dump-users")
def debug_dump_users():
    """TEMPORARY: dump all user data for debugging."""
    import json
    # This dumps everything including emails and hashed passwords
    return jsonify({"debug": True, "all_data": "would dump here"})
PYEOF
RUN cd /app/repo && git add -A && git commit -m "add debug endpoint for testing"

# Commit 9: Fix typo in model
RUN cd /app/repo && sed -i 's/preferences or {}/preferences if preferences else {}/' db/models.py
RUN cd /app/repo && git add -A && git commit -m "fix: typo in UserProfile preferences"

# Commit 10: Implement actual stats endpoint
COPY <<'EOF' /app/repo/api/stats.py
from datetime import datetime, timedelta

def calculate_dashboard_stats(db, user_id):
    """Calculate user dashboard statistics."""
    now = datetime.utcnow()
    week_ago = now - timedelta(days=7)
    month_ago = now - timedelta(days=30)

    return {
        "total_sessions": db.count("sessions", user_id=user_id),
        "active_days_week": db.count_distinct("sessions", "date",
                                               user_id=user_id,
                                               after=week_ago),
        "active_days_month": db.count_distinct("sessions", "date",
                                                user_id=user_id,
                                                after=month_ago),
        "last_login": db.get_latest("sessions", user_id=user_id),
        "profile_completeness": _calc_completeness(db, user_id),
    }

def _calc_completeness(db, user_id):
    profile = db.get("user_profiles", user_id=user_id)
    if not profile:
        return 0
    fields = ["avatar_url", "bio", "preferences"]
    filled = sum(1 for f in fields if getattr(profile, f, None))
    return int(filled / len(fields) * 100)
EOF
RUN cd /app/repo && git add -A && git commit -m "Implement dashboard stats calculation"

# Commit 11: Update routes to use stats module
RUN cd /app/repo && sed -i 's/return jsonify({"stats": "placeholder"})/from api.stats import calculate_dashboard_stats\n    stats = calculate_dashboard_stats(None, 1)\n    return jsonify(stats)/' api/routes.py
RUN cd /app/repo && git add -A && git commit -m "Wire up stats endpoint to stats module"

# Commit 12: Revert Redis experiment — too complex for now
RUN cd /app/repo && rm api/cache.py
RUN cd /app/repo && git add -A && git commit -m "Revert: remove Redis caching experiment (too complex for v1)"

# Commit 13: Add frontend JavaScript
COPY <<'EOF' /app/repo/frontend/app.js
async function loadDashboard() {
    const resp = await fetch('/api/dashboard/stats');
    const data = await resp.json();
    renderStats(data);
}

function renderStats(stats) {
    const panel = document.getElementById('stats-panel');
    panel.innerHTML = `
        <div class="stat-card">
            <h3>Sessions</h3>
            <p>${stats.total_sessions}</p>
        </div>
        <div class="stat-card">
            <h3>Active Days (Week)</h3>
            <p>${stats.active_days_week}/7</p>
        </div>
        <div class="stat-card">
            <h3>Profile</h3>
            <p>${stats.profile_completeness}%</p>
        </div>
    `;
}

async function loadProfile() {
    const resp = await fetch('/api/users/me/profile');
    const data = await resp.json();
    renderProfile(data);
}

function renderProfile(profile) {
    const panel = document.getElementById('profile-panel');
    panel.innerHTML = `
        <h2>Profile</h2>
        <img src="${profile.avatar_url || '/default-avatar.png'}" />
        <p>${profile.bio || 'No bio set'}</p>
    `;
}

document.addEventListener('DOMContentLoaded', () => {
    loadDashboard();
    loadProfile();
});
EOF
RUN cd /app/repo && git add -A && git commit -m "Update frontend JS for dashboard"

# Commit 14: Add console.log debugging (should be cleaned)
RUN cd /app/repo && sed -i 's/const data = await resp.json();/const data = await resp.json();\n    console.log("DEBUG stats response:", JSON.stringify(data));/' frontend/app.js
RUN cd /app/repo && git add -A && git commit -m "add console.log for debugging stats"

# Commit 15: Remove hardcoded DB password
COPY <<'EOF' /app/repo/api/config.py
DATABASE_URL = "postgresql://app:${DB_PASSWORD}@db:5432/dashboard"
SECRET_KEY = "${SECRET_KEY}"
DEBUG = False
ALLOWED_ORIGINS = "http://localhost:3000"
EOF
RUN cd /app/repo && git add -A && git commit -m "fix: remove hardcoded db password"

# Commit 16: Add profile API endpoint
RUN cd /app/repo && cat >> api/routes.py << 'PYEOF'

@app.route("/api/users/me/profile")
def get_my_profile():
    # TODO: get actual user from session
    return jsonify({
        "user_id": 1,
        "avatar_url": None,
        "bio": "Hello world",
        "preferences": {"theme": "dark"}
    })
PYEOF
RUN cd /app/repo && git add -A && git commit -m "Add profile API endpoint"

# Commit 17: Add tests
COPY <<'EOF' /app/repo/tests/test_dashboard.py
def test_stats_endpoint():
    """Test dashboard stats returns expected fields."""
    expected_keys = ["total_sessions", "active_days_week",
                     "active_days_month", "last_login",
                     "profile_completeness"]
    # Would test against actual API
    assert len(expected_keys) == 5

def test_profile_endpoint():
    """Test profile endpoint returns user data."""
    expected_keys = ["user_id", "avatar_url", "bio", "preferences"]
    assert len(expected_keys) == 4

def test_stats_calculation():
    """Test stats calculation logic."""
    from api.stats import _calc_completeness
    # Would need mock db
    assert True

def test_user_profile_model():
    """Test UserProfile model."""
    from db.models import UserProfile
    p = UserProfile(1, "http://img.com/a.png", "Hello", {"theme": "dark"})
    d = p.to_dict()
    assert d["user_id"] == 1
    assert d["bio"] == "Hello"
EOF
RUN cd /app/repo && git add -A && git commit -m "Add dashboard and profile tests"

# Commit 18: Remove debug endpoint and console.log
RUN cd /app/repo && \
    sed -i '/debug\/dump-users/,/return jsonify/d' api/routes.py && \
    sed -i '/TEMPORARY/d' api/routes.py && \
    sed -i '/console.log.*DEBUG/d' frontend/app.js
RUN cd /app/repo && git add -A && git commit -m "cleanup: remove debug endpoint and console.logs"

# ── PR guidelines ────────────────────────────────────────
COPY <<'EOF' /app/pr_guidelines.md
# Pull Request Guidelines

## Commit Structure

PRs should have clean, logical commits grouped by feature area.
Each commit should be self-contained and pass tests independently.

### Expected grouping for this feature branch:

1. **Database changes** — model additions and migrations together
   - UserProfile model + migration in one commit

2. **API changes** — new endpoints and business logic
   - Stats calculation + stats endpoint + profile endpoint

3. **Frontend changes** — UI updates as one logical unit
   - Dashboard layout + styles + JavaScript all together

4. **Tests** — all test additions in one commit

### Commits to drop:
- WIP saves with no meaningful content
- Debug/experiment commits that were later reverted
- Commits that only add then remove debug code

### Commit message format:
```
feat(area): concise description

Optional longer explanation.
```

Examples:
- `feat(db): add UserProfile model and migration`
- `feat(api): implement dashboard stats and profile endpoints`
- `feat(frontend): add dashboard UI with stats and profile panels`
- `test: add dashboard and profile test suite`
EOF

# ── Bare remote ───────────────────────────────────────────
RUN git init --bare /app/repo.remote && \
    cd /app/repo && \
    git remote add origin /app/repo.remote && \
    git push origin main && \
    git push origin feature/user-dashboard

WORKDIR /app/repo
