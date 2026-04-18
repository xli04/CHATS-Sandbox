#!/usr/bin/env bash
# Run every e2e scenario in sequence. Stops on first failure.
#
# Requires: `claude` CLI on PATH and authenticated (run `claude` interactively
# once to complete OAuth). Must NOT be invoked as root — `--dangerously-skip-
# permissions` is refused for EUID 0 by the Claude CLI.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

SCENARIOS=(
  01_install.sh
  02_inside_workspace_edit.sh
  03_outside_workspace_subagent.sh
  04_restore.sh
  05_retention.sh
  06_dashboard.sh
  07_back_to_back_actions.sh
  08_stress_alternating.sh
  09_stress_restore_middle.sh
  10_stress_same_file_rewind.sh
)

START=$(date +%s)
PASS=0
FAIL=0
for s in "${SCENARIOS[@]}"; do
  echo "============================================================"
  echo "=== $s"
  echo "============================================================"
  if bash "$DIR/$s"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "*** $s FAILED — stopping chain"
    break
  fi
  echo ""
done

ELAPSED=$(($(date +%s) - START))
echo "============================================================"
echo "== $PASS passed, $FAIL failed, total ${ELAPSED}s"
echo "============================================================"
[ "$FAIL" -eq 0 ]
