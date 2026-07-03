#!/usr/bin/env bash
# Condition: hermes NATIVE checkpoints (BEHAVIORAL — runs the agent with
# --checkpoints, its own run). Timing comes from a subprocess-level git wrapper
# on PATH that times every shadow-repo commit (GIT_DIR in ~/.hermes/checkpoints)
# — independent of which checkpoint_manager module the long agent loaded.

cond_native_behavioral() { :; }                 # marker: behavioral
cond_native_agent_args()  { echo "--checkpoints"; }

cond_native_pre_run() {
  local wd; wd="$(denv_workdir)"
  denv_exec 'set -e
mkdir -p '"$wd"'/.native
REAL=$(command -v git)
[ -f "$REAL.real" ] && exit 0
mv "$REAL" "$REAL.real"
printf "%s\n" \
  "#!/bin/bash" \
  "if [[ \"\$GIT_DIR\" == *.hermes/checkpoints* ]]; then" \
  "  S=\$(date +%s%3N); \"$REAL.real\" \"\$@\"; RC=\$?; E=\$(date +%s%3N)" \
  "  mkdir -p '"$wd"'/.native 2>/dev/null; echo \$((E-S)) >> '"$wd"'/.native/git-times.log; exit \$RC" \
  "fi" \
  "exec \"$REAL.real\" \"\$@\"" > "$REAL"
chmod +x "$REAL"'
}

# echo "disk_bytes backup_ms" — shadow repo size + summed git-wrapper latency.
cond_native_disk_ms() {
  local wd b m; wd="$(denv_workdir)"
  b=$(denv_exec "du -sb /root/.hermes/checkpoints 2>/dev/null | cut -f1" | tr -d ' \n'); b=${b:-0}
  m=$(denv_exec "awk '{s+=\$1} END{print s+0}' $wd/.native/git-times.log 2>/dev/null"); m=${m:-0}
  echo "$b $m"
}

# cov_handled <inws> <outside> : native checkpoints fire on WRITE actions —
# count write-tool entries in the shared observer log.
cond_native_coverage() {
  local wd; wd="$(denv_workdir)"
  denv_exec "python3 -c \"
import json
n=0
try:
    for l in open('$wd/.observer.jsonl'):
        if l.strip():
            d=json.loads(l)
            if (d.get('tool') or '').lower() in ('write_file','patch','edit','write','str_replace','file_editor'): n+=1
except Exception: pass
print(n)\"" | tr -d ' \n'
}
