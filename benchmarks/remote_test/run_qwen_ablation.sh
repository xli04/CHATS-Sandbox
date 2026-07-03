#!/usr/bin/env bash
# Qwen backupper ablation on the reddit 10 tasks (plugin/subagent condition):
#   arm SKILLS: backup subagent = qwen3.6-35b-a3b WITH the learned reddit
#               experience (playbook + reverters + capture_tools + gating)
#   arm NAIVE:  same model, NO experience AND the gate in no-knowledge mode
#               (CHATS_SANDBOX_NAIVE_GATE=1): every browser/MCP action not
#               read-only-by-NAME escalates and the backup subagent itself
#               judges — its generic prompt may return no_backup_needed. The
#               fail-safe unexplored baseline; wasted spawns on nav/read
#               actions are part of the measured cost.
# Main agent is deepseek-v4-pro in both arms. Measures what the full learned
# package buys: gate precision (spawns), backup token cost, reliability.
#
#   OPENROUTER_API_KEY=sk-or-... bash remote_test/run_qwen_ablation.sh
#
# Results: results/webarena/<TAG>-skills/ and results/webarena/<TAG>-naive/
set -uo pipefail
RT="$(cd "$(dirname "$0")" && pwd)"
BENCH="$(cd "$RT/.." && pwd)"
: "${OPENROUTER_API_KEY:?export OPENROUTER_API_KEY first}"
export PATH="/root/micromamba/envs/chats_sandbox/bin:$PATH"
source "$RT/env.sh"

QWEN="${QWEN_MODEL:-qwen/qwen3.6-35b-a3b}"
TAG="${RUN_TAG:-qwen10}"    # result-dir prefix; override (e.g. qwen30) to not clobber a prior run
export WA_TASKS="${WA_TASKS:-reddit-create-post reddit-change-bio reddit-upvote-newest reddit-delete-submission}"
export WA_SAMPLES="${WA_SAMPLES:-10}"
export WA_SAMPLE_START="${WA_SAMPLE_START:-0}"   # 0-based offset; 10 => run s11.. (skip the first batch)
export HERMES_DUMP_REQUESTS=1 CHATS_KEEP_SUBAGENT_HOME=1

run_arm() {
  local name="$1" exp="$2" gate="${3:-}"
  echo "[ablation] arm=$name experience=$exp naive_gate=${gate:-off} subagent=$QWEN"
  rt_seed_profile force
  rt_check_forum || exit 1
  rm -rf "$BENCH/results/webarena/$name"
  ( cd "$BENCH" && env ${gate:+CHATS_SANDBOX_NAIVE_GATE=1} WEBARENA_EXP="$exp" \
      ./eval.sh --dataset webarena --condition plugin \
      --concurrency 1 --run "$name" --timeout 900 --subagent-model "$QWEN" )
  echo "[ablation] arm=$name DONE -> results/webarena/$name/ALL.csv"
}

# ARMS env picks which arm(s) to run (default both).
ARMS="${ARMS:-skills naive}"
# Arm 1: WITH the learned experience (the published reddit.json).
case " $ARMS " in *" skills "*) run_arm "$TAG-skills" "$RT/experiences/reddit.json";; esac
# Arm 2: NAIVE — no experience file AND the no-knowledge gate: escalate
# everything not read-only-by-name; the subagent judges no_backup_needed.
case " $ARMS " in *" naive "*) run_arm "$TAG-naive" "/nonexistent/no-experience.json" naive_gate;; esac

echo "[ablation] ARMS [$ARMS] DONE"
