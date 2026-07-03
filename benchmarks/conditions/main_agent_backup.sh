#!/usr/bin/env bash
# Condition: MAIN-AGENT backup (BEHAVIORAL). The FAIR inline baseline — the main
# agent does the backup itself, but is given the SAME backup knowledge the
# tier-3 subagent gets (experiences + PIN-the-target + category strategies),
# reframed for inline use. Prefix comes from `cli.js backup-guidance --mode
# inline`, which shares ONE source (buildBackupGuidance) with the subagent
# prompt so the two can never drift. The backup burden compounds in the MAIN
# agent's own context — that's the cost this condition measures.
REPO="${REPO:-$(cd "$HERE/.." && pwd)}"

cond_main_agent_backup_behavioral() { :; }      # marker: behavioral

cond_main_agent_backup_prompt_prefix() {
  node "$REPO/dist/cli.js" backup-guidance --mode inline ${EXPERIENCE:+--experience "$EXPERIENCE"} --cwd "$WORK" 2>/dev/null
  printf '\n\n'
}

# no separate backup store; token-cost compares whole-run totals.
cond_main_agent_backup_disk_ms()  { echo "0 0"; }
cond_main_agent_backup_coverage() { echo "0"; }
