# fullabl — reddit full-package ablation (skills vs no-knowledge naive), n=30/29

**Design (full-package):** the skills arm carries the whole learned reddit
experience (playbook injection + gate triggers + reverters + capture_tools).
The naive arm has NO experience file and runs the no-knowledge gate
(`CHATS_SANDBOX_NAIVE_GATE=1`): every browser action not read-only-by-NAME
escalates to the backup subagent, which judges per call and may return
`no_backup_needed` — the honest fail-safe unexplored baseline. Main agent
deepseek-v4-pro, backup subagent qwen3.6-35b-a3b, browser-less backup design
(PAGE_STATE in prompt, no browser tools). Same 30 samples (round-robin over 4
task types), same repaired delete staging, current runtime (whole-word
triggers, unambiguous matchPattern, payload floor). 2026-07-03.

Runs: `fullabl30-skills` (n=30) vs `fullabl10-naive` + `fullabl_s11to30-naive`
(n=29 valid; one delete sample voided by the pre-fix staging bug).

## Aggregates

| arm | n | tokS/run | backups/run | coverage | backup latency/run |
|---|---|---|---|---|---|
| skills | 30 | **24,046** | 1.0 | 28/30 | 26s |
| naive (no-knowledge) | 29 | **30,224** | 1.2 | **29/29** | 34s |

| task type | skills tokS (cov) | naive tokS (cov) | ratio |
|---|---|---|---|
| create-post | 14,128 (8/8) | 15,309 (8/8) | 0.92x |
| delete-submission | **18,649 (7/7), 1 spawn** | 38,518 (6/6), 2 spawns | **0.48x** |
| upvote-newest | 26,437 (5/7) | 47,522 (7/7) | 0.56x |
| change-bio | **36,592 (8/8)** | 23,783 (8/8) | **1.54x — inverted, see below** |

## Findings

1. **Overall the full package is ~20% cheaper (24.0k vs 30.2k) and ~25% lower
   latency, with the win concentrated exactly where discovery cost is high:**
   deletes cost HALF (one pinned capture from PAGE_STATE vs two exploratory
   spawns), upvotes 0.56x.

2. **The naive gate's virtue is perfect coverage (29/29).** Escalate-everything
   misses nothing; it pays for it in spawns on non-mutating clicks and
   double-spawns per delete.

3. **change-bio INVERTED (skills 1.5x naive) — stale-experience incompatibility.**
   The reddit experience predates the browser-less backup design: its playbook
   entries instruct live browser actions (capture via `browser_evaluate`,
   `browser_run_code`, re-read via `browser_snapshot`) that the current backup
   subagent cannot perform (it gets PAGE_STATE only, no browser). The bio/save
   captures burn 10-13 API calls (vs naive's ~7) discovering the instructions
   are unfollowable, then fall back. Same failure class as the postgres
   toolAllow contradiction (abl10/abl11): **instructions that contradict the
   subagent's actual toolset are worse than no instructions.**
   Fix: regenerate the reddit experience with the current pipeline, or
   reconcile playbook entries against the subagent's real capabilities at
   generation time (the browser-less analog of reconcileCaptureTools).

4. **The 2 skills upvote "misses" are judgment calls, not silent gaps:** the
   subagent spawned (~33.8k tokens each), then declined to record a backup
   (no_backup_needed — an upvote has a live inverse). The harness coverage
   metric counts recorded backups only. Arguably correct behavior, wrong
   metric bookkeeping.

5. **Historical delete rows (qwen10/qwen_s11to30, BOTH arms) are void:** the
   forum's `_bk_*` staging tables had been lost, so delete tasks 404'd —
   old skills 3/7 and old naive 0/7 delete coverage measured a broken
   environment. Staging was rebuilt (submission 135142 recreated, `_bk_sub`/
   `_bk_com`/`_bk_vote` restored, reset round-trip verified) before
   fullabl30-skills and from naive s08 onward.

## Cross-surface picture (with abl11 postgres)

- **Gate knowledge** = coverage on SQL surfaces (unexplored postgres: zero
  backups without it) and spawn-precision on browsers (naive pays a judge per
  click).
- **Playbook knowledge** = reliability + cost on high-discovery captures
  (postgres DROP: verified vs failed; reddit delete: 0.48x tokens) — and it
  goes NEGATIVE when stale or contradicting the runtime's toolset (reddit
  change-bio 1.54x; postgres pre-matchPattern-fix DROP failures).
- Keeping experiences consistent with the runtime (regeneration after design
  changes + generation-time reconciliation) is as important as having them.
