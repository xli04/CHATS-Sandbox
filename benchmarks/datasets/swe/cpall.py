import subprocess, re
def is_read(tool, args):
    t=(tool or "").lower()
    if t in ("read_file","search_files","read","glob","grep"): return True
    if t.startswith("mcp__"): return bool(re.search(r"(get|list|read|search|describe|snapshot)", t))
    if t in ("write_file","patch","edit","write","str_replace","file_editor"): return False
    cmd=""
    if isinstance(args,dict): cmd=str(args.get("command") or args.get("cmd") or args.get("input") or "")
    c=cmd.strip()
    if re.match(r"^(ls|cat|grep|rg|find|head|tail|wc|which|echo|pwd|stat|file|tree|env|printenv|pytest|python -m pytest|git (status|log|diff|show|branch|rev-parse|ls-files|config))\b", c) and ">" not in c:
        return True
    return False
def _pre(tool_name, args):
    try:
        if is_read(tool_name, args): return
        subprocess.run(["/testbed/.cpall/timed-hook.sh"], capture_output=True, timeout=600)
    except Exception: pass
def attach(registry): registry.add_pre_hook(_pre)
