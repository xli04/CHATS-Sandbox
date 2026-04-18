#!/usr/bin/env bash
# E2E 06 — dashboard HTTP endpoints.
set -u
fail() { echo "FAIL: $*"; kill $DASH_PID 2>/dev/null; wait 2>/dev/null; exit 1; }
pass() { echo "PASS: $*"; }

CLI="$(cd "$(dirname "$0")" && pwd)/../dist/cli.js"
PROJ="/tmp/chats-e2e-06"
PORT=27361
rm -rf "$PROJ"
mkdir -p "$PROJ"
cd "$PROJ" || exit 1
node "$CLI" install > /tmp/e2e-06-install.log 2>&1 || fail "install failed"

# Boot dashboard in background
node "$CLI" dashboard --port $PORT > /tmp/e2e-06-dash.log 2>&1 &
DASH_PID=$!
sleep 1

# Check it's alive
curl -fsS http://127.0.0.1:$PORT/ -o /tmp/e2e-06-index.html -w "  /           HTTP %{http_code} size=%{size_download}\n" || fail "/ didn't respond"
grep -q "CHATS-Sandbox" /tmp/e2e-06-index.html || fail "/ payload missing expected marker"
pass "GET / serves dashboard HTML"

curl -fsS http://127.0.0.1:$PORT/api/status -o /tmp/e2e-06-status.json -w "  /api/status HTTP %{http_code}\n" || fail "/api/status failed"
python3 -c "
import json
s = json.load(open('/tmp/e2e-06-status.json'))
for k in ['enabled', 'backupMode', 'actionCount', 'maxActions', 'maxTotalSizeMB', 'maxAgeHours', 'totalSizeBytes', 'subagentEnabled']:
    assert k in s, f'missing status key: {k}'
print('  status keys OK:', sorted(s.keys()))
" || fail "/api/status payload missing keys"
pass "GET /api/status returns expected fields"

curl -fsS http://127.0.0.1:$PORT/api/actions > /tmp/e2e-06-actions.json || fail "/api/actions failed"
python3 -c "
import json
d = json.load(open('/tmp/e2e-06-actions.json'))
assert 'actions' in d and isinstance(d['actions'], list), 'missing actions list'
print('  actions in payload:', len(d['actions']))
" || fail "/api/actions payload malformed"
pass "GET /api/actions returns list"

curl -fsS http://127.0.0.1:$PORT/api/config > /tmp/e2e-06-config.json || fail "/api/config failed"
pass "GET /api/config returns config"

# POST /api/config — update maxActions, maxTotalSizeMB, maxAgeHours round-trip
RESP=$(curl -fsS -X POST -H "content-type: application/json" \
  -d '{"maxActions": 42, "maxTotalSizeMB": 200, "maxAgeHours": 72}' \
  http://127.0.0.1:$PORT/api/config)
echo "$RESP" | python3 -c "
import json, sys
r = json.loads(sys.stdin.read())
assert r.get('saved') == True, 'saved!=true'
c = r['config']
assert c['maxActions'] == 42, f'maxActions={c[\"maxActions\"]}'
assert c['maxTotalSizeMB'] == 200, f'maxTotalSizeMB={c[\"maxTotalSizeMB\"]}'
assert c['maxAgeHours'] == 72, f'maxAgeHours={c[\"maxAgeHours\"]}'
print('  round-trip OK')
" || fail "POST /api/config round-trip failed"
pass "POST /api/config updates retention fields"

# Negative POST should 400
HTTP=$(curl -s -o /tmp/e2e-06-neg.json -w "%{http_code}" -X POST -H "content-type: application/json" \
  -d '{"maxAgeHours": -5}' http://127.0.0.1:$PORT/api/config)
[ "$HTTP" = "400" ] || fail "negative number should return 400, got $HTTP"
pass "POST /api/config rejects negative retention value with 400"

# Shutdown
kill $DASH_PID 2>/dev/null
wait 2>/dev/null

echo ""
echo "E2E 06 OK"
