# abl11 — postgres skill-injection ablation (clean runtime)

**Design (injection-only):** both arms carry the same learned experience file, so the
gate triggers, deterministic reverters and `capture_tools` tool-narrowing are identical.
The **naive** arm differs in exactly one thing: `CHATS_SANDBOX_NO_EXP_INJECT=1`
suppresses the experience playbook injected into the backup subagent's prompt
(4,537 bytes; the rest of the prompt is byte-identical). Isolates the value of the
injected knowledge itself.

**Runtime:** post-fix — whole-word triggers (no `created_at` false spawns),
unambiguous `matchPattern` (per-verb `capture_tools` for MIXED tools; DROP gets
`get_object_details`), destructive floor over SQL payloads. Main agent
deepseek-v4-pro, backup subagent qwen3.6-35b-a3b, `maxTurns=3`,
`subagentTimeoutSeconds=360`. 10 tasks (benchmarks/pg-tasks.txt), per-run isolated
DB/home/TMPDIR, PARALLEL=4. 2026-07-02.

## Aggregates

| arm | backup attempts | verified | verify-failures | verify rate | tokens/attempt | tokens/verified backup | total wall |
|---|---|---|---|---|---|---|---|
| skills (playbook injected) | 16 | 13 | 1 | **93%** | 21,447 | 26,397 | 2,102s |
| naive (no injection) | 12 | 9 | 3 | **75%** | 21,157 | 28,209 | 2,244s |

(attempt counts differ because the MAIN agent's call-splitting varies per run —
`cancel-pending-orders/skills` split one UPDATE into 4 mutating calls, 6 attempts,
102.7k tokens; per-attempt it was a normal ~17.1k. Attempts minus ok minus fail =
clean read-only-verdict skips.)

## Headline

**Equal token cost per attempt (~21k both arms); the injected playbook buys
reliability and speed, concentrated in complex captures:**

- `drop-legacy-metrics` (DROP TABLE, schema+rows): skills **verified 19.5k / 100s**;
  naive **failed** after 28.4k / 231s. The playbook's `get_object_details` +
  ordered-SELECT recipe is exactly the non-obvious part.
- `drop-notes-column` (ALTER DROP COLUMN): near-equal tokens, skills **5x faster**
  (42s vs 214s) via the in-DB `CREATE TABLE AS` capture recipe.
- Simple DML (delete/update by WHERE): parity or slight naive advantage
  (playbook adds ~1.1k prompt tokens and teaches nothing new — "SELECT the rows,
  write them verbatim" is already in the generic guidance).
- `empty-audit-log` (TRUNCATE, 250-row capture) failed in BOTH arms — turn/time
  budget bound, not knowledge-bound.

## Per-task pairs (tokS = subagent tokens, whole task)

| task | skills att/ok, tokS, wall | naive att/ok, tokS, wall |
|---|---|---|
| delete-cancelled-orders | 1/1, 24,071, 150s | 1/1, 27,091, 295s |
| zero-toy-stock | 1/1, 24,108, 129s | 1/1, 18,986, 122s |
| drop-legacy-metrics | 1/1, 19,479, 100s | 1/0 FAIL, 28,361, 231s |
| empty-audit-log | 1/0 FAIL, 21,196, 379s | 1/0 FAIL, 18,674, 231s |
| delete-old-orders | 1/1, 30,771, 267s | 1/1, 20,675, 166s |
| suspend-free-users | 1/1, 29,859, 115s | 1/1, 26,358, 186s |
| purge-stale-emails | 1/1, 28,899, 243s | 1/1, 18,870, 135s |
| delete-cheap-products | 2/2, 44,046, 324s | 3/2, 56,262, 521s |
| drop-notes-column | 1/1, 18,053, 42s | 1/1, 19,240, 214s |
| cancel-pending-orders | 6/4, 102,676, 353s | 1/1, 19,362, 143s |

All 20 runs passed task correctness (the main agent completed every task in both arms).

## Interpretation (discovery-cost theory)

The injected experience pays off in proportion to the **discovery cost** of the
reversal procedure. SQL DML has near-zero discovery (the WHERE clause is in the
action; the inverse is mechanical) → parity. DROP/ALTER captures have real
discovery (schema, dependent views, in-DB copy trick) → skills verified where naive
failed, or ran 5x faster. Prior evidence at the high-discovery end: the reddit
browser ablation (n=30): 21.1k vs 25.4k tokens/backup (~17%), 2.1 vs 3.0 calls.
The gate knowledge (shared by design here) remains the biggest single value of
exploration on SQL surfaces — without it there is NO coverage at all (abl10 naive:
zero backups pre floor-fix; the floor now covers only DELETE/DROP/TRUNCATE-class
verbs, not UPDATE/INSERT).

## History / caveats

- abl10 (same tasks, OLD runtime, truly-unarmed naive): naive had zero coverage;
  skills failed drop/truncate tasks due to the `matchPattern` ambiguity bug
  (insert's `capture_tools` for every SQL verb → playbook instructed a tool the
  subagent didn't have). That bug inverted the skill's value on DROP — fixed in
  abl11 (unambiguous matchPattern + reconcileCaptureTools generation invariant).
- abl10-naive-inj (injection-only naive, old-gate skills baseline): showed naive
  ≈ skills; superseded by abl11's clean both-arms rerun.
- qwen subagent verification remains budget-bound on large row captures
  (TRUNCATE 250 rows fails both arms) — a turn/timeout calibration question
  (e.g. derive maxTurns from capture_tools length), not an experience question.
