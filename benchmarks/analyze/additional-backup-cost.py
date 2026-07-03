#!/usr/bin/env python3
"""ADDITIONAL token cost of backup: inline (main agent) vs subagent.

Measures the EXTRA tokens incurred *because we asked for a backup* — not the task.

  inline (main does the backup):
    - the backup guidance lives in the main's prompt → re-sent on EVERY action call
        guidance_component = guidance_tok * N_action_calls
    - each emitted [BACKUP] log enters the context → re-sent on every later call
        log_component = sum over calls of (backup-log tokens carried in that call)
    - plus the one-time generation of each [BACKUP] block (output side)
    additional_inline = guidance_component + log_component (+ generated logs)

  subagent (T4 backup spawned separately):
    - each spawn is an isolated context (NO main task history)
        subagent_total = sum over spawns of (input + output)  [grouped by session_id]

Crossover: inline scales with N_action_calls (guidance*N); subagent scales with
N_backups (flat per backup). Subagent wins once guidance*N > spawn*N_backups.

No prompt caching assumed (every call re-sends its full context).
Tokens via tiktoken o200k_base (input is exact; output inferred from the next
call's assistant message — last call's output is flagged unrecoverable).

Usage: additional-backup-cost.py --inline-dumps <dir> --subagent-dumps <dir> \
                                  --guidance <file|-> [--task-prompt <file>]
"""
import json, glob, sys, argparse, collections
try:
    import tiktoken; ENC = tiktoken.get_encoding("o200k_base"); tok = lambda s: len(ENC.encode(s)); TK = "o200k_base"
except Exception:
    tok = lambda s: max(1, len(s) // 4); TK = "chars/4"

def tx(c):
    if isinstance(c, str): return c
    if isinstance(c, list):
        return "\n".join((b.get("text") or b.get("content") or json.dumps(b)) if isinstance(b, dict) else str(b) for b in c)
    return json.dumps(c) if c is not None else ""

def load(dumps, model_sub):
    out = []
    for f in sorted(glob.glob(dumps + "/request_dump_*.json")):
        try: d = json.load(open(f))
        except Exception: continue
        b = (d.get("request") or {}).get("body") or d.get("body") or {}
        if model_sub not in b.get("model", ""): continue
        out.append((d.get("session_id", f), b))
    return out

def call_input_tok(b):
    """Full input of one API call: messages + tools (the whole re-sent context)."""
    t = sum(tok(m.get("role","")) + tok(tx(m.get("content"))) + 4 +
            (tok(json.dumps(m["tool_calls"])) if m.get("tool_calls") else 0)
            for m in (b.get("messages") or []))
    if b.get("tools"): t += tok(json.dumps(b["tools"]))
    return t

def backup_blocks(text):
    """Extract [BACKUP]...[/BACKUP] block token counts from a string."""
    import re
    return [tok(m) for m in re.findall(r"\[BACKUP\].*?\[/BACKUP\]", text, re.S)]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inline-dumps", required=True)
    ap.add_argument("--subagent-dumps", required=True)
    ap.add_argument("--guidance", required=True, help="file with the inline backup guidance text, or '-' to skip")
    ap.add_argument("--main-model", default="pro"); ap.add_argument("--sub-model", default="flash")
    a = ap.parse_args()

    guidance_tok = 0
    if a.guidance != "-":
        guidance_tok = tok(open(a.guidance).read())

    # ── INLINE: guidance re-sent every call + logs compounding ──────────
    inline = load(a.inline_dumps, a.main_model)
    N = len(inline)
    # logs carried in each call's context (re-sent input), summed over calls
    log_carried = 0; logs_generated = 0; seen = set()
    for sid, b in inline:
        for m in (b.get("messages") or []):
            for blk in backup_blocks(tx(m.get("content"))):
                log_carried += blk
    # generated logs: count each distinct block once (approx via assistant msgs in last call)
    if inline:
        last = inline[-1][1]
        for m in (last.get("messages") or []):
            if m.get("role") == "assistant":
                logs_generated += sum(backup_blocks(tx(m.get("content"))))
    guidance_component = guidance_tok * N
    additional_inline = guidance_component + log_carried + logs_generated

    # ── SUBAGENT: each spawn isolated (group by session_id) ─────────────
    sub = load(a.subagent_dumps, a.sub_model)
    spawns = collections.OrderedDict()
    for sid, b in sub: spawns.setdefault(sid, []).append(b)
    spawn_rows = []
    for sid, calls in spawns.items():
        tin = sum(call_input_tok(b) for b in calls)
        # output of a spawn: assistant tokens in its largest (final) message list
        biggest = max(calls, key=lambda b: len(b.get("messages") or []))
        tout = sum(tok(tx(m.get("content"))) for m in (biggest.get("messages") or []) if m.get("role")=="assistant")
        spawn_rows.append((sid, len(calls), tin, tout, tin+tout))
    subagent_total = sum(r[4] for r in spawn_rows)
    n_backups = len(spawn_rows)

    # ── report ──────────────────────────────────────────────────────────
    print(f"# additional backup cost  (tokenizer={TK})")
    print(f"\nINLINE (main agent does backup):  N_action_calls={N}  guidance={guidance_tok} tok/call")
    print(f"  guidance_component = {guidance_tok} * {N} = {guidance_component}")
    print(f"  log_carried (re-sent backup logs) = {log_carried}")
    print(f"  logs_generated (one-time output)  = {logs_generated}")
    print(f"  ADDITIONAL_INLINE = {additional_inline}  (model={a.main_model})")
    print(f"\nSUBAGENT ({n_backups} spawn(s)):")
    print(f"  {'session':<22}{'calls':>6}{'in':>9}{'out':>7}{'total':>9}")
    for sid, n, tin, tout, ttl in spawn_rows:
        print(f"  {str(sid)[:22]:<22}{n:>6}{tin:>9}{tout:>7}{ttl:>9}")
    print(f"  SUBAGENT_TOTAL = {subagent_total}  (model={a.sub_model})")
    print(f"\nCROSSOVER (raw tokens): inline = {guidance_tok}*N (+logs); subagent = {subagent_total//max(1,n_backups)}/backup")
    if guidance_tok: print(f"  subagent (per backup) is undercut by inline once N_action_calls > {subagent_total//max(1,n_backups)//guidance_tok} (per backup)")
    print(f"\nNOTE: inline tokens are on the MAIN model; subagent on the SUB model — apply per-token price for $ cost.")

if __name__ == "__main__":
    main()
