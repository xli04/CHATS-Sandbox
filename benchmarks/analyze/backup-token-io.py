#!/usr/bin/env python3
"""Per-backup token IN/OUT: subagent spawn vs main-agent [BACKUP] turn.

Dumps (HERMES_DUMP_REQUESTS) are REQUEST-ONLY — no usage/response field. So:
  token_in  = tiktoken(o200k_base) over the request (system + all messages + tools)
  token_out = the assistant message a call produced, recovered from the NEXT
              call's messages (the new assistant turn appended after this call).
              The LAST call's output is unrecoverable -> reported as "?".

Subagent mode: per SPAWN (one backup invocation = the flash model's call-loop).
  token_in/out summed over the spawn's calls.
Main mode: per [BACKUP] turn — the pro call whose produced output contains
  "[BACKUP]". token_in = that call's FULL request (whole accumulated context);
  token_out = that call's produced assistant message.

Usage: backup-token-io.py <subagent_dumps_dir> <main_dumps_dir>
"""
import json, glob, sys, collections
try:
    import tiktoken; ENC = tiktoken.get_encoding("o200k_base"); tok = lambda s: len(ENC.encode(s)); TK="o200k_base"
except Exception:
    tok = lambda s: max(1, len(s)//4); TK="chars/4"

def text_of(c):
    if isinstance(c, str): return c
    if isinstance(c, list):
        return "\n".join((b.get("text") or b.get("content") or json.dumps(b)) if isinstance(b, dict) else str(b) for b in c)
    return json.dumps(c) if c is not None else ""

def msg_tok(m):
    t = tok(m.get("role","")) + tok(text_of(m.get("content"))) + 4
    if m.get("tool_calls"): t += tok(json.dumps(m["tool_calls"]))
    return t

def load(dumpdir):
    out = []
    for f in glob.glob(dumpdir + "/request_dump_*.json"):
        try: d = json.load(open(f))
        except Exception: continue
        b = (d.get("request") or {}).get("body") or d.get("body") or {}
        out.append({"ts": d.get("timestamp",""), "model": b.get("model",""),
                    "messages": b.get("messages",[]) or [], "tools": b.get("tools",[]) or []})
    return out

def req_in(c):  # full input the API receives for this call
    return sum(msg_tok(m) for m in c["messages"]) + (tok(json.dumps(c["tools"])) if c["tools"] else 0)

def calls_for(dumps, modelsub):
    cs = [c for c in dumps if modelsub in c["model"]]
    cs.sort(key=lambda c: (len(c["messages"]), c["ts"]))  # context grows monotonically
    return cs

def output_of(cs, i):
    """Assistant message call i produced = new assistant msgs in call i+1 beyond call i's messages."""
    if i+1 >= len(cs): return None  # last call: unrecoverable
    prev, nxt = cs[i]["messages"], cs[i+1]["messages"]
    tail = nxt[len(prev):]
    asst = [m for m in tail if m.get("role") == "assistant"]
    return asst

def main():
    sub_dir, main_dir = sys.argv[1], sys.argv[2]
    print(f"# backup token IN/OUT  (tokenizer={TK}; dumps are request-only, output inferred from next call)\n")

    # ---- SUBAGENT: per spawn (flash call-loop) ----
    sc = calls_for(load(sub_dir), "flash")
    print(f"SUBAGENT spawn  ({len(sc)} internal calls):")
    tin = sum(req_in(c) for c in sc)
    tout = 0; last_unknown = False
    for i in range(len(sc)):
        o = output_of(sc, i)
        if o is None: last_unknown = True
        else: tout += sum(msg_tok(m) for m in o)
    print(f"  token_in  = {tin}   (sum of all {len(sc)} calls' full inputs — no cache)")
    print(f"  token_out = {tout}{'  (+ last call output unrecoverable)' if last_unknown else ''}")
    print(f"  total     = {tin+tout}\n")

    # ---- MAIN: per [BACKUP]-emitting turn ----
    mc = calls_for(load(main_dir), "pro")
    print(f"MAIN-agent  ({len(mc)} calls):")
    found = []
    for i in range(len(mc)):
        o = output_of(mc, i)
        if o and any("[BACKUP]" in text_of(m.get("content")) for m in o):
            found.append((i, req_in(mc[i]), sum(msg_tok(m) for m in o)))
    if not found:
        print("  no [BACKUP] tag found in any recoverable output (could be in the last/unrecoverable call)")
    for (i, tin_i, tout_i) in found:
        print(f"  [BACKUP] emitted by call #{i+1}:  token_in = {tin_i}  (full accumulated context)   token_out = {tout_i}   total = {tin_i+tout_i}")
    if found:
        print(f"  --- sum over {len(found)} [BACKUP] turn(s):  in = {sum(x[1] for x in found)}  out = {sum(x[2] for x in found)}  total = {sum(x[1]+x[2] for x in found)}")

if __name__ == "__main__":
    main()
