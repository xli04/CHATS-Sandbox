#!/usr/bin/env python3
"""Recompute the ADDITIONAL token cost of backup from the FULL run log.

No runtime instrumentation. hermes already persists the complete conversation
to ~/.hermes/sessions/session_<id>.json (system_prompt + tools + EVERY message,
incl. the final assistant output that request dumps miss). We reconstruct each
API call's exact input/output from that log and recompute offline.

Per-call reconstruction (no prompt caching — every call re-sends its full context):
  call k's OUTPUT  = the k-th assistant message (its content + tool_calls)
  call k's INPUT   = system_prompt + tools + every message BEFORE that assistant
                     (so input GROWS each call; this is what the API bills)
  a call is a BACKUP call (`ba`) iff its assistant output contains [BACKUP]

MAIN-AGENT inline backup cost = the tokens spent *because backup is on*:
  A  guidance tax on the ordinary task turns (the playbook rides in the prompt,
     re-sent on every NON-backup call too):     A = guidance_tok * N_task_calls
  B  the extra backup turns, each carrying the FULL accumulated context+tools:
     B = sum over ba-calls of (full_input + output)
  main_backup = A + B
  (No double count: A covers task calls; the guidance inside ba calls is in B.)

SUBAGENT backup cost = its whole isolated run (the subagent IS the backup):
  subagent_backup = sum over ALL its calls of (full_input + output)
  — fresh context: no main task history, only its own system+tools+prompt.

Usage:
  recompute-backup-cost.py --mode main     --session-log <session.json> --guidance <file|->
  recompute-backup-cost.py --mode subagent --session-log <session.json> [--session-log ...]
"""
import json, sys, argparse, re
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
    """Tokens of one message as it sits in the wire context."""
    t = tok(m.get("role", "")) + tok(text_of(m.get("content"))) + 4
    if m.get("tool_calls"): t += tok(json.dumps(m["tool_calls"]))
    return t

def has_backup(m):
    """A turn is a BACKUP turn if it emits a [BACKUP] note OR does backup work:
       writing/creating the persisted recovery artifact (inline-backups dir,
       remote-state.json, recovery_*.json, subagent_result.json)."""
    if "[BACKUP]" in text_of(m.get("content")): return True
    blob = json.dumps(m.get("tool_calls") or [])
    return any(k in blob for k in ("inline-backups", "remote-state", "recovery_", "subagent_result"))

def dump_inputs(dumps_dir):
    """Exact per-call INPUT from request dumps (the real wire payloads), in call order."""
    import glob
    ins = []
    # filename embeds the per-call timestamp (request_dump_<sid>_<ts>.json) → sorts in call order.
    # (mtime is unreliable: copying dumps resets it.)
    for f in sorted(glob.glob(dumps_dir + "/request_dump_*.json")):
        try: d = json.load(open(f))
        except Exception: continue
        b = (d.get("request") or {}).get("body") or d.get("body") or {}
        msgs = b.get("messages") or []
        t = sum(mtok(m) for m in msgs) + (tok(json.dumps(b["tools"])) if b.get("tools") else 0)
        ins.append(t)
    return ins

def reconstruct(log, dumps_dir=None):
    """Per-call rows: each assistant turn is one API call.
       OUTPUT + [BACKUP] detection come from the full session log (has the final turn).
       INPUT comes from the request dumps when given (exact payloads), else reconstructed
       from the log (system+tools+prior msgs; ~1-3% high due to content cleaning)."""
    sys_tok = tok(log.get("system_prompt") or "")
    tools_tok = tok(json.dumps(log.get("tools") or [])) if log.get("tools") else 0
    fixed = sys_tok + tools_tok          # re-sent on every call
    msgs = log.get("messages") or []
    rows, carried = [], 0                # carried = tokens of messages before this turn
    for m in msgs:
        if m.get("role") == "assistant":
            rows.append({"input_tok": fixed + carried, "output_tok": mtok(m), "is_ba": has_backup(m)})
        carried += mtok(m)
    if dumps_dir:                        # override input with exact dump payloads (paired by call order)
        ins = dump_inputs(dumps_dir)
        for k, r in enumerate(rows):
            if k < len(ins): r["input_tok"] = ins[k]
    return rows, sys_tok, tools_tok

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["main", "subagent"], required=True)
    ap.add_argument("--session-log", action="append", required=True,
                    help="session_<id>.json (repeatable for subagent: one per spawn)")
    ap.add_argument("--dumps", action="append", default=[],
                    help="request-dumps dir for EXACT input (paired with --session-log by order)")
    ap.add_argument("--guidance", help="inline backup guidance text file (or '-' for 0); MAIN mode")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    if a.mode == "main":
        log = json.load(open(a.session_log[0]))
        rows, sys_tok, tools_tok = reconstruct(log, a.dumps[0] if a.dumps else None)
        N = len(rows); n_ba = sum(r["is_ba"] for r in rows); n_task = N - n_ba
        guidance_tok = tok(open(a.guidance).read()) if (a.guidance and a.guidance != "-") else 0
        A = guidance_tok * n_task
        B = sum(r["input_tok"] + r["output_tok"] for r in rows if r["is_ba"])
        total = A + B
        print(f"# MAIN-agent inline backup cost  (tokenizer={TK})")
        print(f"  session: {a.session_log[0].split('/')[-1]}")
        print(f"  system={sys_tok}/call  tools={tools_tok}/call  guidance={guidance_tok}/call")
        print(f"  calls={N}  (task={n_task}, backup[ba]={n_ba})")
        if not a.quiet:
            print(f"\n  {'call':>4}{'input':>9}{'output':>8}  kind")
            for i, r in enumerate(rows, 1):
                print(f"  {i:>4}{r['input_tok']:>9}{r['output_tok']:>8}  {'BACKUP' if r['is_ba'] else 'task'}")
        print(f"\n  A  guidance*N_task = {guidance_tok}*{n_task} = {A}")
        print(f"  B  ba-calls(full in+out) = {B}")
        print(f"  MAIN_BACKUP = A + B = {total}")
        print(f"\nMAIN_BACKUP_TOTAL {total}")
    else:
        grand, n_calls = 0, 0
        print(f"# SUBAGENT backup cost  (tokenizer={TK})")
        for i, sl in enumerate(a.session_log):
            log = json.load(open(sl))
            rows, sys_tok, tools_tok = reconstruct(log, a.dumps[i] if i < len(a.dumps) else None)
            sub = sum(r["input_tok"] + r["output_tok"] for r in rows)
            grand += sub; n_calls += len(rows)
            print(f"  {sl.split('/')[-1]:<42} calls={len(rows):>2} sys={sys_tok} tools={tools_tok}  total={sub}")
        print(f"\n  SUBAGENT_BACKUP = sum over {len(a.session_log)} spawn(s), {n_calls} calls = {grand}")
        print(f"\nSUBAGENT_BACKUP_TOTAL {grand}")

if __name__ == "__main__":
    main()
