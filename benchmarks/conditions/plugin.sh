#!/usr/bin/env bash
# Condition: CHATS-Sandbox plugin (the method under test). Tiered backup with
# the tier-3 subagent. Helpers are namespaced cond_plugin_* and called by the
# dataset adapter through the env primitives (denv_exec/denv_cp/denv_workdir).
REPO="${REPO:-$(cd "$HERE/.." && pwd)}"

# install the plugin + configure the subagent (hermes/flash by default).
cond_plugin_install() {
  local wd; wd="$(denv_workdir)"
  denv_exec "mkdir -p /opt/chats-sandbox"
  denv_cp "$REPO/dist"     /opt/chats-sandbox/dist
  denv_cp "$REPO/commands" /opt/chats-sandbox/commands
  denv_exec "cd $wd && node /opt/chats-sandbox/dist/cli.js install $AGENT >/dev/null 2>&1
    node /opt/chats-sandbox/dist/cli.js config set subagentEnabled true >/dev/null
    node /opt/chats-sandbox/dist/cli.js config set subagentRunner $AGENT >/dev/null
    node /opt/chats-sandbox/dist/cli.js config set subagentHermesModel $SUBAGENT_MODEL >/dev/null
    node /opt/chats-sandbox/dist/cli.js config set subagentHermesProvider openrouter >/dev/null
    node /opt/chats-sandbox/dist/cli.js config set subagentTimeoutSeconds 240 >/dev/null"
}

# echo the distinct tier set fired (e.g. "T0 T1 T2 T3"), for coverage attribution.
cond_plugin_tiers() {
  local wd; wd="$(denv_workdir)"
  denv_exec "python3 -c \"
import json,glob,re
ts=set()
for m in glob.glob('$wd/.chats-sandbox/backups/action_*/metadata.json'):
    try:
        for a in json.load(open(m)):
            s=a.get('strategy','')
            if 'policy' in s: ts.add('T0')
            elif s in ('pip_freeze','file_copy','env_snapshot'): ts.add('T1')
            elif s=='git_snapshot': ts.add('T2')
            elif s=='subagent': ts.add('T3')
    except Exception: pass
print(' '.join(sorted(ts)))\" 2>/dev/null"
}

# echo "disk_bytes backup_ms"
# Flagged-failed action folders (containing action-failed.flag) are artifacts of
# the MAIN agent fumbling+retrying an action, NOT a real cost of the backup
# method, so they are EXCLUDED from BOTH the disk total and the latency total.
#  DISK: sum `du` over the non-backup parts of .chats-sandbox plus only the
#        non-flagged action folders (instead of `du -sb` over everything).
#  TIME: each backup-timings.jsonl record carries an `action` field equal to the
#        action folder name, so flagged folders' addedLatencyMs are dropped.
cond_plugin_disk_ms() {
  local wd b m; wd="$(denv_workdir)"
  b=$(denv_exec "python3 -c \"import os,glob
root='$wd/.chats-sandbox'
bdir=os.path.join(root,'backups')
def tree_bytes(p):
    t=0
    for dp,_,fs in os.walk(p):
        t+=os.path.getsize(dp) if os.path.exists(dp) else 0
        for f in fs:
            fp=os.path.join(dp,f)
            try: t+=os.path.getsize(fp)
            except OSError: pass
    return t
total=0
# everything under .chats-sandbox except the per-action backup folders
for name in os.listdir(root) if os.path.isdir(root) else []:
    p=os.path.join(root,name)
    if p==bdir: continue
    total+=tree_bytes(p) if os.path.isdir(p) else (os.path.getsize(p) if os.path.exists(p) else 0)
if os.path.isdir(root): total+=os.path.getsize(root)
# action folders: skip any with action-failed.flag
if os.path.isdir(bdir):
    total+=os.path.getsize(bdir)
    for d in os.listdir(bdir):
        ad=os.path.join(bdir,d)
        if not os.path.isdir(ad): continue
        if os.path.exists(os.path.join(ad,'action-failed.flag')): continue
        total+=tree_bytes(ad)
print(total)\" 2>/dev/null"); b=${b:-0}
  m=$(denv_exec "python3 -c \"import json,os,glob
root='$wd/.chats-sandbox'
bdir=os.path.join(root,'backups')
flagged=set()
if os.path.isdir(bdir):
    for d in os.listdir(bdir):
        if os.path.exists(os.path.join(bdir,d,'action-failed.flag')):
            flagged.add(d)
def joinable(aid):
    # timing 'action' is the full folder name (e.g. action_001_2026...). match
    # exact, or fall back to a prefix match against flagged folder names.
    if aid in flagged: return True
    for f in flagged:
        if f==aid or f.startswith(aid) or aid.startswith(f): return True
    return False
tot=0
try:
    for l in open(os.path.join(root,'backup-timings.jsonl')):
        if not l.strip(): continue
        r=json.loads(l)
        if joinable(str(r.get('action',''))): continue
        tot+=r['addedLatencyMs']
    print(round(tot))
except Exception:
    print(0)\" 2>/dev/null"); m=${m:-0}
  echo "$b $m"
}

# cov_handled <inws> <outside> <tiers> : T2 covers in-workspace; T0/T1/T3 cover outside.
cond_plugin_coverage() {
  local inws=$1 outside=$2 tiers=$3 h=0
  echo "$tiers" | grep -q T2 && h=$((h+inws))
  echo "$tiers" | grep -qE "T0|T1|T3" && h=$((h+outside))
  echo "$h"
}

# restore the latest action (used for recovery measurement); echoes nothing.
cond_plugin_restore() {
  local wd; wd="$(denv_workdir)"
  local n; n=$(denv_exec "ls $wd/.chats-sandbox/backups 2>/dev/null | grep -c ^action_" | tr -d ' \n')
  [ "${n:-0}" -gt 0 ] && denv_exec "cd $wd && node /opt/chats-sandbox/dist/cli.js restore 1" >/dev/null 2>&1
}
