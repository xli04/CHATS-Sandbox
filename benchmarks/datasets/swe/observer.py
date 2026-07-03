import json, re, os
WS="/testbed"; LOG="/testbed/.observer.jsonl"
OUT=[r"\bpip3?\s+(install|uninstall)", r"\bnpm\s+(install|uninstall|ci)", r"\bapt(-get)?\s+(install|remove)",
  r"\bgit\s+(push|fetch|pull|clone|remote)", r"\bcurl\b.*-X\s*(POST|PUT|DELETE)", r"\bwget\b", r"\bssh\b",
  r"\bdocker\s+(run|push|rm|build)", r"\bkubectl\b", r"\bsystemctl\b", r"\b(export|unset)\s+\w+", r"\bsource\s+"]
def classify(tool,args):
    t=(tool or "").lower()
    if t in ("read_file","search_files","read","glob","grep"): return "read"
    if t.startswith("mcp__"): return "read" if re.search(r"(get|list|read|search|describe|snapshot)",t) else "outside"
    if t in ("write_file","patch","edit","write","str_replace","file_editor"): return "inws"
    cmd=""
    if isinstance(args,dict): cmd=str(args.get("command") or args.get("cmd") or args.get("input") or "")
    c=cmd.strip()
    if re.match(r"^(ls|cat|grep|rg|find|head|tail|wc|which|echo|pwd|stat|file|tree|env|printenv|pytest|python -m pytest|git (status|log|diff|show|branch|rev-parse|ls-files|config))\b",c) and ">" not in c: return "read"
    for p in OUT:
        if re.search(p,c,re.I): return "outside"
    for m in re.findall(r"/[\w./-]+",c):
        if len([x for x in m.split("/") if x])>=2:
            ab=os.path.realpath(m)
            if not ab.startswith(WS+"/") and ab!=WS and not ab.startswith(("/dev/","/proc/","/tmp/")):
                if re.search(r"(>|>>|\b(cp|mv|rm|tee|dd|touch|mkdir|ln|install|truncate|chmod|chown)\b)",c): return "outside"
    return "inws"
def _pre(tool_name,args):
    try:
        with open(LOG,"a") as f: f.write(json.dumps({"tool":tool_name,"class":classify(tool_name,args)})+"\n")
    except Exception: pass
def attach(registry): registry.add_pre_hook(_pre)
