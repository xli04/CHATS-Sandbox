#!/usr/bin/env python3
"""Recompute token usage from hermes HERMES_DUMP_REQUESTS dumps.

Each dump is one API call's exact request body (messages + model). Input tokens
= sum over ALL calls of tokens(messages) — this captures the compounding context
cost. Output tokens (approx) = assistant-message tokens in the largest dump per
session. Split by model: main (pro) vs subagent (flash).

Tokenizer is a consistent BPE (o200k_base) — absolute counts are estimates, but
the subagent-vs-inline COMPARISON is valid because both are tokenized identically.

Usage: recompute-tokens.py <cond> <dumps_dir>
"""
import json, glob, sys, collections
try:
    import tiktoken
    ENC = tiktoken.get_encoding("o200k_base")
    tok = lambda s: len(ENC.encode(s))
    TK = "o200k_base"
except Exception:
    tok = lambda s: max(1, len(s) // 4)   # fallback: ~4 chars/token
    TK = "chars/4"

def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for b in content:
            if isinstance(b, dict):
                out.append(b.get("text") or b.get("content") or json.dumps(b))
            else:
                out.append(str(b))
        return "\n".join(out)
    return json.dumps(content) if content is not None else ""

def msg_tokens(messages):
    t = 0
    for m in messages:
        t += tok(m.get("role", "")) + tok(text_of(m.get("content"))) + 4
        # tool calls / tool results also cost tokens
        if m.get("tool_calls"):
            t += tok(json.dumps(m["tool_calls"]))
    return t

def assistant_tokens(messages):
    return sum(tok(text_of(m.get("content"))) + (tok(json.dumps(m["tool_calls"])) if m.get("tool_calls") else 0)
               for m in messages if m.get("role") == "assistant")

cond, ddir = sys.argv[1], sys.argv[2]
per_model = collections.defaultdict(lambda: {"calls": 0, "input": 0})
# group by session to estimate output from the largest message list per session
sess_best = {}   # session_id -> (model, n_messages, assistant_tokens)
for f in sorted(glob.glob(ddir + "/request_dump_*.json")):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    body = (d.get("request") or {}).get("body") or d.get("body") or {}
    model = body.get("model", "?")
    messages = body.get("messages", []) or []
    sid = d.get("session_id", f)
    per_model[model]["calls"] += 1
    per_model[model]["input"] += msg_tokens(messages)
    n = len(messages)
    if sid not in sess_best or n > sess_best[sid][1]:
        sess_best[sid] = (model, n, assistant_tokens(messages))

out_by_model = collections.defaultdict(int)
for sid, (model, n, at) in sess_best.items():
    out_by_model[model] += at

# classify
PRO = next((m for m in per_model if "pro" in m), None)
FLASH = next((m for m in per_model if "flash" in m or "qwen" in m), None)
def g(m, k):
    if k == "input": return per_model[m]["input"] if m else 0
    if k == "calls": return per_model[m]["calls"] if m else 0
    if k == "out": return out_by_model[m] if m else 0
main_in, main_out, main_calls = g(PRO, "input"), g(PRO, "out"), g(PRO, "calls")
sub_in, sub_out, sub_calls = g(FLASH, "input"), g(FLASH, "out"), g(FLASH, "calls")
tot_in, tot_out = main_in + sub_in, main_out + sub_out

print(f"# tokenizer={TK}  cond={cond}")
print(f"# models seen: {dict((m, per_model[m]['calls']) for m in per_model)}")
print(f"{cond},{main_in},{main_out},{main_calls},{sub_in},{sub_out},{sub_calls},{tot_in},{tot_out},{tot_in+tot_out}")
