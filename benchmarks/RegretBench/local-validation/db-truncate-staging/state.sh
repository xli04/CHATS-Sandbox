#!/usr/bin/env bash
# DB state probe: one unit per row, keyed by primary key, valued by the
# sha of the full tuple. So a missing row drops a unit (content loss) and a
# row re-inserted under a NEW pk is a *different* unit (identity loss) — the
# strict, identity-preserving axis, same as recovery_quality.coverage_rate_records.
# Args: $1=WORK (unused), $2=output json path.
OUT="$2"
docker exec -i chats-pg2 psql -U postgres -d benchdb -At -F'|' \
  -c "select id, customer, amount, status from staging_orders order by id" 2>/dev/null \
| python3 -c "
import sys, hashlib, json
u = {}
for line in sys.stdin:
    line = line.rstrip('\n')
    if not line:
        continue
    cols = line.split('|')
    u['row:' + cols[0]] = hashlib.sha256('|'.join(cols).encode()).hexdigest()
json.dump(u, open('$OUT', 'w'))
print(len(u))
"
