#!/usr/bin/env bash
# Condition: always-git-add baseline. A PreToolUse hook snapshots the whole
# work-tree into a shadow repo on every action (excluding the infra dirs).
# Covers in-workspace state only; out-of-workspace mutations are uncoverable.
# (Hook is wired as a hermes plugin — the SWE+hermes lane.)

cond_gitadd_install() {
  local wd; wd="$(denv_workdir)"
  denv_exec '
    mkdir -p '"$wd"'/.baseline/shadow/info
    printf ".baseline\n.hermes\n.chats-sandbox\n.native\n.cpall\n" > '"$wd"'/.baseline/shadow/info/exclude
    cat > '"$wd"'/.baseline/hook.sh <<EOS
#!/usr/bin/env bash
cd '"$wd"'
GIT_DIR='"$wd"'/.baseline/shadow GIT_WORK_TREE='"$wd"' git init -q 2>/dev/null || true
GIT_DIR='"$wd"'/.baseline/shadow GIT_WORK_TREE='"$wd"' git config user.email b@x
GIT_DIR='"$wd"'/.baseline/shadow GIT_WORK_TREE='"$wd"' git config user.name b
GIT_DIR='"$wd"'/.baseline/shadow GIT_WORK_TREE='"$wd"' git add -A 2>/dev/null
GIT_DIR='"$wd"'/.baseline/shadow GIT_WORK_TREE='"$wd"' git commit -qm s --allow-empty 2>/dev/null
exit 0
EOS
    cat > '"$wd"'/.baseline/timed-hook.sh <<EOS
#!/usr/bin/env bash
S=\$(date +%s%3N); '"$wd"'/.baseline/hook.sh; RC=\$?; E=\$(date +%s%3N)
echo \$((E-S)) >> '"$wd"'/.baseline/hook-times.log
exit \$RC
EOS
    chmod +x '"$wd"'/.baseline/hook.sh '"$wd"'/.baseline/timed-hook.sh
    mkdir -p '"$wd"'/.hermes/plugins
    cat > '"$wd"'/.hermes/plugins/baseline.py <<EOF
import subprocess
def _pre(tool_name, args):
    try: subprocess.run(["'"$wd"'/.baseline/timed-hook.sh"], capture_output=True, timeout=600)
    except Exception: pass
def attach(registry): registry.add_pre_hook(_pre)
EOF'
}

# echo "disk_bytes backup_ms"
cond_gitadd_disk_ms() {
  local wd b m; wd="$(denv_workdir)"
  b=$(denv_exec "du -sb $wd/.baseline 2>/dev/null | cut -f1"); b=${b:-0}
  m=$(denv_exec "awk '{s+=\$1} END{print s+0}' $wd/.baseline/hook-times.log 2>/dev/null"); m=${m:-0}
  echo "$b $m"
}

# cov_handled <inws> <outside> : workspace snapshot only.
cond_gitadd_coverage() { echo "$1"; }
