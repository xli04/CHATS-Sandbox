#!/usr/bin/env bash
# Canonical environment for the WebArena/SafeArena reddit REMOTE test.
# SOURCE this (it does not run anything): `source remote_test/env.sh`.
#
# Everything the remote test needs to start lives HERE (permanent), not in /tmp:
#   - the logged-in Playwright profile  -> remote_test/wa-pw-profile  (source of truth)
#   - the learned reddit experience     -> remote_test/experiences/reddit.json
#   - the isolated docker daemon socket + forum URL  (env defaults below)
#
# The browser still RUNS against a scratch copy at /tmp/wa-pw-profile (chromium
# locks/mutates its profile dir); rt_seed_profile re-seeds that scratch copy
# from the permanent one, so a reboot or /tmp wipe never loses the login.

RT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RT_REPO="$(cd "$RT_DIR/.." && pwd)"          # benchmarks/

# --- isolated docker daemon + forum (SafeArena site containers) -------------
# SafeArena forums run on a SECOND dockerd, NOT the default socket.
export DOCKER_HOST="${DOCKER_HOST:-unix:///mnt/data/sa-docker-run/docker.sock}"
export FORUM="${FORUM:-sa_forum_aa_0}"
export FORUM_URL="${FORUM_URL:-http://reddit.149-28-225-133.sslip.io}"

# --- permanent assets -------------------------------------------------------
export RT_PROFILE_SRC="${RT_PROFILE_SRC:-$RT_DIR/wa-pw-profile}"   # logged-in, permanent
export PW_PROFILE="${PW_PROFILE:-/tmp/wa-pw-profile}"              # runtime scratch (seeded from SRC)
# learned reddit experience (permanent home). WEBARENA_EXP is what the dataset
# adapter reads; default it here instead of the old empty /tmp pointer.
export WEBARENA_EXP="${WEBARENA_EXP:-$RT_DIR/experiences/reddit.json}"

# Re-seed the scratch profile from the permanent logged-in copy. Idempotent:
# pass `force` to overwrite an existing scratch profile.
rt_seed_profile() {
  local force="${1:-}"
  pkill -9 -f "wa-pw-profile" 2>/dev/null
  if [ ! -d "$RT_PROFILE_SRC" ]; then
    echo "rt_seed_profile: permanent profile missing: $RT_PROFILE_SRC" >&2; return 1
  fi
  if [ "$force" = "force" ] || [ ! -d "$PW_PROFILE" ]; then
    rm -rf "$PW_PROFILE"; cp -a "$RT_PROFILE_SRC" "$PW_PROFILE"
  fi
  rm -f "$PW_PROFILE"/Singleton* 2>/dev/null
}

# Verify the forum container is up on the isolated daemon.
rt_check_forum() {
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$FORUM"; then
    echo "forum up: $FORUM ($FORUM_URL)"; return 0
  fi
  echo "forum NOT up: $FORUM on $DOCKER_HOST — start it via OpenAgentSafety/servers (make up)" >&2
  return 1
}
