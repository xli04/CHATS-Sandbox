#!/usr/bin/env bash
# Launch the reddit self-exploration (site-affordance playbook learning).
#
#   OPENROUTER_API_KEY=sk-or-... bash remote_test/run_explore.sh
#   (or:  nohup bash remote_test/run_explore.sh > /tmp/reddit-explore.log 2>&1 &)
#
# Produces <explore-work>/.chats-sandbox/experiences/playwright.json. Stage 1
# proposes site-affordance patterns (create/delete/vote/bio + generic tool
# recipes); Stage 2 verifies each live against the forum.
#
# NOTE this MUST live in a file, not be pasted inline through bash -c: it
# contains `pkill -f` patterns that would match (and kill) an inline launcher
# whose own command line carries the script text.
set -uo pipefail
RT="$(cd "$(dirname "$0")" && pwd)"
: "${OPENROUTER_API_KEY:?export OPENROUTER_API_KEY first}"
export PATH="/root/micromamba/envs/chats_sandbox/bin:$PATH"
source "$RT/env.sh"
rt_seed_profile
rt_check_forum || exit 1
# clear any stale browser holding the profile lock (safe here: this pattern
# lives in a FILE, so no launcher cmdline contains it)
pkill -9 -f "wa-pw-profile" 2>/dev/null
rm -f /tmp/wa-pw-profile/Singleton* 2>/dev/null
mkdir -p "$RT/explore-work"; cd "$RT/explore-work"
MODEL="${EXPLORE_MODEL:-deepseek/deepseek-v4-pro}"
echo "[explore] server=playwright experience=reddit target=$FORUM_URL model=$MODEL workdir=$PWD"
node /mnt/data2/CHATS-Sandbox/dist/cli.js explore playwright \
  --experience reddit \
  --target "$FORUM_URL" --agent hermes --model "$MODEL"
rc=$?
# Publish the learned experience to the PERMANENT home the benchmark reads
# (WEBARENA_EXP -> remote_test/experiences/reddit.json). The explore-work copy
# stays as the merge base for future re-explorations.
SRC="$RT/explore-work/.chats-sandbox/experiences/reddit.json"
if [ $rc -eq 0 ] && [ -f "$SRC" ]; then
  mkdir -p "$RT/experiences"
  cp "$SRC" "$RT/experiences/reddit.json"
  echo "[explore] published -> $RT/experiences/reddit.json"
else
  echo "[explore] NOT published (rc=$rc, src present: $([ -f "$SRC" ] && echo yes || echo no))" >&2
fi
exit $rc
