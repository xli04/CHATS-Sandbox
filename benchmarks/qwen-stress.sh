#!/usr/bin/env bash
# Stress-test the qwen3.5-9b subagent with the cleaned prompt: run the drill
# (which fires the subagent on 3 outside-workspace actions) N times and
# aggregate how often qwen produces a parseable result vs fails.
set -u
cd /mnt/data/CHATS-Sandbox/benchmarks
: "${OPENROUTER_API_KEY:?}"
N="${1:-6}"; PAR="${2:-3}"
SUBAGENT_MODEL="${SUBAGENT_MODEL:-qwen/qwen3.5-9b}"
PREFIX="${PREFIX:-s}"   # label prefix so different models don't clobber each other
echo "stress: model=$SUBAGENT_MODEL  runs=$N  prefix=$PREFIX" >&2
rm -rf results/qwen-capture/psf__requests-2931_${PREFIX}* 2>/dev/null
seq 1 "$N" | xargs -P"$PAR" -I{} bash -c '
  export OPENROUTER_API_KEY="'"$OPENROUTER_API_KEY"'" SUBAGENT_MODEL="'"$SUBAGENT_MODEL"'" LOCAL_DRILL="'"${LOCAL_DRILL:-0}"'"
  RUN_LABEL="'"$PREFIX"'{}" DRILL_ONLY=1 ./capture-qwen.sh psf__requests-2931 >/dev/null 2>&1
  echo "done run {}" >&2
'
echo "STRESS DONE ($SUBAGENT_MODEL)" >&2

# ── aggregate ─────────────────────────────────────────────────────────
python3 - <<'PY'
import glob, re, os
import os as _os
runs = sorted(glob.glob(f"results/qwen-capture/psf__requests-2931_{_os.environ.get('PREFIX','s')}*"))
inv=succ=fail=ro=t3=0
for d in runs:
    lg = os.path.join(d, "subagent.log")
    if not os.path.exists(lg): continue
    t = open(lg, errors="replace").read()
    inv  += len(re.findall(r"invoking: hermes", t))
    succ += len(re.findall(r"parse success", t))
    fail += len(re.findall(r"parse failed", t))
    ro   += len(re.findall(r"subagent verdict: read-only", t))
    pa = os.path.join(d, "per-action.txt")
    if os.path.exists(pa):
        t3 += open(pa).read().count("'subagent'")
print(f"runs={len(runs)}  subagent invocations={inv}")
print(f"  parse SUCCESS={succ}  ({100*succ//inv if inv else 0}%)")
print(f"  parse FAILED ={fail}  ({100*fail//inv if inv else 0}%)")
print(f"  of successes: read-only verdicts={ro}, durable T3 artifacts={t3}")
PY
