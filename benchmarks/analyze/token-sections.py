#!/usr/bin/env python3
"""Per-SECTION token breakdown for main agent vs subagent, side by side.

Splits HERMES_DUMP_REQUESTS dumps by model (the larger model = main, the
smaller = subagent) and decomposes each agent's token spend into sections so
the two can be compared apples-to-apples:

  system      system prompt, summed over every call (re-sent each turn)
  tools       tool/function JSON schemas (body.tools), summed over calls
  instruction the FIRST user message (task for main / backup-instructions for sub),
              summed over calls
  context     all OTHER messages (accumulated browser/tool/assistant history)
  output      assistant-generated tokens (from the final, largest message list)

input_total = system + tools + instruction + context  (what the API bills as input)
total       = input_total + output

Usage: token-sections.py <dumps_dir> [main_model_substr] [sub_model_substr]
       defaults: main="pro", sub="flash"/"qwen"
"""
import json, glob, sys, collections
try:
    import tiktoken; ENC = tiktoken.get_encoding("o200k_base"); tok = lambda s: len(ENC.encode(s)); TK = "o200k_base"
except Exception:
    tok = lambda s: max(1, len(s) // 4); TK = "chars/4"

def text_of(c):
    if isinstance(c, str): return c
    if isinstance(c, list):
        return "\n".join((b.get("text") or b.get("content") or json.dumps(b)) if isinstance(b, dict) else str(b) for b in c)
    return json.dumps(c) if c is not None else ""

def mtok(m):
    t = tok(m.get("role", "")) + tok(text_of(m.get("content"))) + 4
    if m.get("tool_calls"): t += tok(json.dumps(m["tool_calls"]))
    return t

def analyze(dumps, main_sub, sub_sub):
    # bucket dumps by which agent (main/sub) via model substring
    agents = {"main": [], "sub": []}
    for f in sorted(glob.glob(dumps + "/request_dump_*.json")):
        try: d = json.load(open(f))
        except Exception: continue
        b = (d.get("request") or {}).get("body") or d.get("body") or {}
        model = b.get("model", "")
        which = "main" if main_sub in model else ("sub" if (sub_sub in model or "qwen" in model) else None)
        if which: agents[which].append(b)

    out = {}
    for which, bodies in agents.items():
        if not bodies: out[which] = None; continue
        sec = collections.Counter(); n = len(bodies)
        biggest = max(bodies, key=lambda b: len(b.get("messages", []) or []))
        for b in bodies:
            msgs = b.get("messages", []) or []
            sec["tools"] += tok(json.dumps(b.get("tools", []))) if b.get("tools") else 0
            seen_user = False
            for m in msgs:
                r = m.get("role", "")
                if r == "system": sec["system"] += mtok(m)
                elif r == "user" and not seen_user: sec["instruction"] += mtok(m); seen_user = True
                else: sec["context"] += mtok(m)
        # output = assistant tokens in the final (largest) state
        sec["output"] = sum(mtok(m) for m in (biggest.get("messages", []) or []) if m.get("role") == "assistant")
        sec["calls"] = n
        out[which] = sec
    return out

def main():
    dumps = sys.argv[1]
    main_sub = sys.argv[2] if len(sys.argv) > 2 else "pro"
    sub_sub  = sys.argv[3] if len(sys.argv) > 3 else "flash"
    a = analyze(dumps, main_sub, sub_sub)
    if "--totals" in sys.argv:           # machine-readable: "MAIN_TOTAL SUB_TOTAL"
        def total(x): return (sum(x[r] for r in ("system","tools","instruction","context")) + x["output"]) if x else 0
        print(f"{total(a['main'])} {total(a['sub'])}")
        return
    print(f"# token sections  (tokenizer={TK})   dir={dumps}")
    rows = ["system", "tools", "instruction", "context", "output"]
    def col(x): return f"{x:>12}" if x is not None else f"{'—':>12}"
    m, s = a["main"], a["sub"]
    print(f"\n{'section':<14}{'MAIN':>12}{'SUBAGENT':>12}   note")
    print("-" * 56)
    notes = {"system":"re-sent/call","tools":"re-sent/call (API-billed, not in our prior totals)",
             "instruction":"task vs backup-prompt, re-sent/call","context":"accumulated history","output":"generated"}
    for r in rows:
        mv = m[r] if m else None; sv = s[r] if s else None
        print(f"{r:<14}{col(mv)}{col(sv)}   {notes[r]}")
    print("-" * 56)
    mi = sum(m[r] for r in ("system","tools","instruction","context")) if m else 0
    si = sum(s[r] for r in ("system","tools","instruction","context")) if s else 0
    print(f"{'input_total':<14}{mi:>12}{si:>12}")
    mt = mi + (m["output"] if m else 0); stt = si + (s["output"] if s else 0)
    print(f"{'TOTAL':<14}{mt:>12}{stt:>12}")
    print(f"{'calls':<14}{(m['calls'] if m else 0):>12}{(s['calls'] if s else 0):>12}")

if __name__ == "__main__":
    main()
