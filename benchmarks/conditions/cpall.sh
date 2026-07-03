#!/usr/bin/env bash
# Condition: cp-all baseline (naive brute force). A read-aware PreToolUse hook
# copies the ENTIRE working tree into .cpall/trash/action_NNN on every mutation
# (no dedup -> the headline disk cost). Covers in-workspace state only.
# (Hook wired as a hermes plugin — the SWE+hermes lane.)
SWE_DIR="${SWE_DIR:-$HERE/datasets/swe}"

cond_cpall_install() {
  local wd; wd="$(denv_workdir)"
  denv_exec '
    mkdir -p '"$wd"'/.cpall
    cat > '"$wd"'/.cpall/hook.sh <<EOS
#!/usr/bin/env bash
N=\$(ls '"$wd"'/.cpall/trash 2>/dev/null | wc -l)
SEQ=\$(printf "%03d" \$((N+1)))
mkdir -p '"$wd"'/.cpall/trash/action_\$SEQ
find '"$wd"' -mindepth 1 -maxdepth 1 \
  ! -name .cpall ! -name .hermes ! -name .git ! -name .chats-sandbox ! -name .baseline ! -name .native \
  -print0 2>/dev/null | xargs -0 -I{} cp -a {} '"$wd"'/.cpall/trash/action_\$SEQ/ 2>/dev/null
exit 0
EOS
    cat > '"$wd"'/.cpall/timed-hook.sh <<EOS
#!/usr/bin/env bash
S=\$(date +%s%3N); '"$wd"'/.cpall/hook.sh; RC=\$?; E=\$(date +%s%3N)
echo \$((E-S)) >> '"$wd"'/.cpall/hook-times.log
exit \$RC
EOS
    chmod +x '"$wd"'/.cpall/hook.sh '"$wd"'/.cpall/timed-hook.sh
    mkdir -p '"$wd"'/.hermes/plugins'
  denv_cp "$SWE_DIR/cpall.py" "$wd/.hermes/plugins/cpall.py"
}

# echo "disk_bytes backup_ms"
cond_cpall_disk_ms() {
  local wd b m; wd="$(denv_workdir)"
  b=$(denv_exec "du -sb $wd/.cpall 2>/dev/null | cut -f1" | tr -d ' \n'); b=${b:-0}
  m=$(denv_exec "awk '{s+=\$1} END{print s+0}' $wd/.cpall/hook-times.log 2>/dev/null"); m=${m:-0}
  echo "$b $m"
}

# cov_handled <inws> <outside> : in-workspace only.
cond_cpall_coverage() { echo "$1"; }
