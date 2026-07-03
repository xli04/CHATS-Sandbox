#!/usr/bin/env bash
# Condition: INLINE backup (BEHAVIORAL — the main agent does the backup itself,
# no plugin/subagent). The token-cost baseline: a preamble instructs the agent
# to record a cheap reversal before each out-of-workspace mutation, wrapped in
# [BACKUP]…[/BACKUP]. The backup burden compounds in the MAIN agent's context.

cond_inline_behavioral() { :; }                 # marker: behavioral

cond_inline_prompt_prefix() {
  cat <<'EOF'
IMPORTANT — before EACH step that modifies state OUTSIDE the project (pip installs, files in /tmp or the home dir) and would be hard to undo, FIRST record a cheap backup so it can be reversed (e.g. save `pip freeze` before installing; note the path of any file you create so it can be deleted; copy a file before editing it). Wrap each backup commands block in [BACKUP] and [/BACKUP] tags. Then perform the step.

EOF
}

# no backup store, not separately covered here (token-cost compares run totals).
cond_inline_disk_ms()  { echo "0 0"; }
cond_inline_coverage() { echo "0"; }
