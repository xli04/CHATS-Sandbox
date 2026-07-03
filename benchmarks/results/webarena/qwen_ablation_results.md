# Qwen backupper ablation — does the learned experience help a small model?

**Question.** For the tier-3 backup subagent, does injecting the self-explored
per-server *experience* (skill playbook + reverters + `capture_tools` narrowing +
learned gating) reduce backup cost — and does it help *more* on a small model,
the first rung of the distillation thesis
(`naive < +skills-in-prompt < distilled-with-skills`)?

## Setup

- **Tasks:** WebArena reddit, 10 samples cycling `create-post / change-bio /
  upvote-newest / delete-submission`, plugin (tier-3 subagent) condition, live
  postmill forum, per-task stdio Playwright browser.
- **Main agent:** `deepseek/deepseek-v4-pro` (both arms).
- **Backup subagent:** `qwen/qwen3.6-35b-a3b` (both arms).
- **Only variable — the injected experience:**
  - **`+skills` arm:** the published `reddit.json` (18 patterns, 13 live-verified:
    playbook prose, comment/reply reverters, `capture_tools`, learned triggers).
  - **`naive` arm:** no experience file → generic guidance only (no playbook, no
    reverters, no schema narrowing, verb-heuristic gating).
- **Accounting:** subagent request dumps split by model; tokens = request-body
  chars / 4; a "fired" task is one where a backup subagent actually ran.

## Headline result (ROBUST, n=30 — supersedes the n=10 numbers below)

Scaled to 30 samples/arm (s01-s30). The clean, confound-free cut is the
**paired comparison** over the **21 tasks where BOTH arms fired a backup**
(drops delete-submission, which the main agent can't complete, and the 3
skills-only-fired samples — `delete-s28`, `upvote-s03`, `upvote-s27`):

| metric (per backed-up task, paired n=21) | **+skills** | **naive** | delta |
|---|---|---|---|
| avg subagent **tokens** | **21,132** | 25,386 | **−16.8%** |
| avg subagent **calls (round-trips)** | **2.14** | 2.95 | **−27%** |

**Three-tier distillation matrix** (same 21 paired tasks; distilled = skills
behavior minus the injected `LEARNED BACKUP SKILL` block, ~1,129 tok/call ×
~2.1 calls ≈ 2,419 tok/task):

| tier | avg tokens / backup | vs naive |
|---|---|---|
| **naive** (no experience) | **25,386** | — |
| **+skills in prompt** | **21,132** | −16.8% |
| **distilled (ESTIMATE)** | **~18,713** | **−26.3%** |

The ladder `naive > +skills > distilled` holds. Mechanism: skills cuts cost by
removing round-trips; distillation adds a further cut by removing the injected
prose on each remaining round-trip.

**Per-task-type (n=30, delete excluded) — the token win is uneven:**

| task type | skills (tok / calls) | naive (tok / calls) | note |
|---|---|---|---|
| **create-post** | **11.7K / 1.5** | 17.2K / 2.5 | skill wins big (−32%) |
| **change-bio** | **24.1K / 3.0** | 28.8K / 4.0 | skill wins (−16%) + captures original value |
| **upvote** | 32.5K / 1.9 | 33.1K / 2.0 | ~flat — skill adds ~1.1K playbook, saves no discovery on a cheap toggle |

**Caveats.**
- **Distilled is an ESTIMATE, not a measurement.** It assumes the fine-tuned
  model reproduces the skills-arm behavior (same calls, same recipe adherence).
  A real distill could beat it (internalized recipes) or regress (lossy) — only
  an actual fine-tune + rerun settles it.
- **Distillation removes only the ~2.4K/task playbook prose.** Base guidance,
  tool schemas, and especially **PAGE_STATE (~10.8K/call)** remain — so the floor
  after distillation is still ~18.7K, dominated by the injected browser snapshot,
  NOT the skill. Getting under the 10K/run target needs the separate per-call
  snapshot-trimming lever, not distillation.
- **Coverage favors skills** across n=30: 24 vs 21 fired (naive missed 2 upvotes
  for lack of a learned trigger; the experience's *gating* contribution).
- **Skills runaway:** `delete-s28` (SKILLS arm) span to **11 calls / 175K tokens**
  — one un-capped subagent dwarfs 20 good backups. Motivates an enforced hard
  call-cap (we have a ~3-call instruction but no ceiling).

### (Earlier, n=10 — optimistic, kept for the record)

| metric (per backed-up task, n=10) | **+skills** | **naive** | delta |
|---|---|---|---|
| avg subagent **tokens** | ~16.3K | ~24.4K | −33% |
| avg subagent **calls** | 1.6 | 3.1 | ~2x |
| fired | 8 / 10 | 7 / 10 | — |

The n=10 gap (−33%) was optimistic vs the robust n=30 paired gap (−16.8%); the
larger sample and paired cut are the number to cite. On the older
`deepseek-v4-flash` runs the raw subagent average was ~38K.

## Why skills is cheaper — it is ROUND-TRIPS, not per-call prompt size

The cost identity: **subagent_tokens ≈ (calls) × (per-call prompt) + output**.

**Per-call prompt is ~13-14K in BOTH arms** and is dominated by fixed context,
not the skill (measured on a representative upvote call):

| per-call section | tokens | note |
|---|---|---|
| **PAGE_STATE** (injected browser snapshot) | **~10.8K** | dominant; per-page, re-sent every call |
| tool schemas | ~2.4K | fixed, re-sent every call |
| guidance + Category F + output format | ~2.2K | fixed |
| **learned skill playbook (+skills only)** | **~1.1K** | the skills arm's *extra* per-call cost |

So the `+skills` arm actually sends a **slightly bigger** prompt per call
(playbook adds ~1.1K). It still wins because it makes **far fewer calls**:

| arm | calls per fired task | | | | | | |
|---|---|---|---|---|---|---|---|
| **+skills** | 1, 1, 1, 1, 2, 2, 2, 3 | | | | | avg **1.6** | |
| **naive** | 2, 2, 3, 3, 3, 4, 5 | | | | | avg **3.1** | |

The extra naive calls ARE discovery round-trips (tool sequences confirm it):

- **naive:** `terminal -> write_file`, `write_file -> read_file`, `terminal ->
  write_file` — a **discovery/orientation step first** (probe to find *what* and
  *where* to capture), then the recovery write. Worst case `change-bio-s06`
  naive = **5 calls** (hunting for the bio value).
- **+skills:** mostly a single `write_file` (occasionally a confirm turn) — **no
  discovery step**; the playbook already states what to capture, from which URL,
  and how to reverse, so it writes the recovery directly.

**Corrected conclusion:** the skill does NOT shrink the per-call prompt (it grows
it ~1.1K). It saves by **eliminating discovery round-trips** — and because each
avoided round-trip carries the full ~13K PAGE_STATE+schema payload, removing
~1.5 calls on average dwarfs the +1.1K playbook surcharge. Net −33%.

**Implication for the 10K target:** with PAGE_STATE alone at ~10.8K/call, no
single-call backup on a rich forum page fits under 10K as-is. The remaining
levers are on the *per-call* side, orthogonal to skills: (a) trim/prune
PAGE_STATE before injecting, (b) prompt caching for the fixed ~4.5K
schema+guidance prefix, (c) `capture_tools` narrowing to cut the ~2.4K schema
block. Skills got calls to ~1.6; per-call trimming is what closes the rest.

## Backup QUALITY — skills is better, not just cheaper

`change-bio` is the checkable case (the original bio is the literal
`t2_5adwlxvn`; a good backup must capture that exact value and record a
replayable restore):

| sample | +skills | naive |
|---|---|---|
| bio-s02 | `live_restore=false`, captured original, deterministic restore | `live_restore=true`, **"value UNKNOWN — not captured"** (non-recovery) |
| bio-s06 | `live_restore=false`, captured original | `live_restore=true`, captured but no fixed command |
| bio-s10 | `live_restore=false`, **captured `t2_5adwlxvn`**, deterministic MCP restore | `live_restore=true`, **"UNVERIFIED: pre-state not in snapshot"** (punted) |

- **+skills captured the true prior value in all 3** and emitted deterministic
  (`live_restore:false`) restores (grep confirms `t2_5adwlxvn` in all three).
- **naive captured it in only 1 of 3**; the other two degraded to
  `UNKNOWN` / `UNVERIFIED` live-restore notes — honest, but a weaker backup
  (restore must re-derive later, by which point the original may be gone).

**Mechanism:** the playbook told the skills subagent exactly where the original
lives (`/user/<u>/edit_biography`, textarea holds current value), so it read it
in one call. The naive subagent only had a stale `/account` PAGE_STATE snapshot,
found no bio value, and gave up. **The skill converts "I couldn't find the
pre-state" into "I know where the pre-state is"** — a correctness win exactly
where site-specific knowledge matters.

create-post and upvote quality is comparable across arms (both pin the new post
by exact title; both describe the vote toggle), so the quality gap concentrates
on the task that needs domain knowledge.

## (1) Did the subagent capture everything needed?

Per-task requirement vs what the recovery artifact actually contains:

| task | what a faithful backup needs | +skills | naive |
|---|---|---|---|
| **change-bio** | original bio (`t2_5adwlxvn`) + restore that writes it back | **3/3 captured, all `live_restore:false` deterministic** | **1/3 captured**; s02 = "value UNKNOWN", s10 = "UNVERIFIED: not in snapshot" |
| **create-post** | pin the new post by its exact title (delete-by-title) | 3/3 pinned by exact title (2 deterministic, 1 live) | 3/3 pinned by exact title (all live) |
| **upvote** | voted entity id + retract/toggle-back | 2/2 (id + retract) | 1/1 (id + retract) |
| **delete** | pre-delete content to recreate | n/a — no backup fired (see below) | n/a |

- **create-post + upvote: both arms captured what's needed** — exact-title pin
  (never by position), correct toggle/delete inverse. Quality parity here.
- **change-bio: only +skills is reliably complete.** It captured the real prior
  value in all three and emitted replayable (`live_restore:false`) restores;
  naive captured it once and degraded twice to UNKNOWN/UNVERIFIED live notes
  (honest, but the restore must re-derive later — a weaker backup). Cause: the
  playbook named the edit-page URL where the original lives; naive had only a
  stale `/account` PAGE_STATE snapshot and could not find it.
- **Net:** no case where +skills captured LESS than needed; one task
  (change-bio) where naive captured less. Completeness favors +skills.

## (2) Why did DELETE never trigger a backup? (both arms, both samples)

**Not a gating defect — the main agent never performed the delete.** Main-agent
tool traces for all four delete runs are `browser_navigate` × 8-10 (wandering
post -> forum -> search -> user profile -> submissions), with at most a stray
`browser_type` / a "More" link click — **never a Delete-button click and never a
confirm-dialog accept**. Postmill's delete is a two-step confirm flow the
deepseek-pro main agent failed to complete. No mutation attempted -> nothing
backup-worthy -> correctly no backup.

**The gate WOULD have fired had a delete happened** — simulated:

| simulated click | gate verdict |
|---|---|
| "Delete button" | **BACKUP** (STRONG_MUTATING floor: "delete") |
| "Delete this submission" | **BACKUP** |
| "More" menu link | skip (correct — opens a menu, mutates nothing) |
| confirm-dialog "OK" | skip |
| navigate | skip |

So the trigger logic is correct; the miss is upstream (main-agent capability on a
hard multi-step UI task), and it is **experience-independent** (identical in both
arms). The other "should-fire" checks all behaved correctly: create/upvote/edit
fired in +skills; the ONE gating gap is naive `upvote-s03`, where — with no
learned `upvote`/`vote` trigger — the generic verb heuristic did not treat the
vote click as backup-worthy (skills caught both upvotes). That is the
experience's *gating* contribution.

> Data caveat: the harness `_wa_reset`/`_wa_cov` for delete references DB tables
> (`_bk_sub` etc.) that do not exist on this forum, so the CSV `action_done=1`
> for delete is unreliable; the authoritative signal is the main-agent tool
> trace above (no delete performed).

## (3) Outlier analysis

- **+skills `upvote-s03` ~35K (vs ~17K for the same task at s07):** NOT extra
  exploration — the subagent did exactly one `write_file`. The 2x is simply
  **two model round-trips** (write, then a confirming turn) each re-sending the
  ~15-17K PAGE_STATE+schema prompt. s07 finished in one round-trip -> ~17K. So
  the "outlier" is round-trip count × a heavy PAGE_STATE, not misbehavior. It
  reinforces the per-call finding above: the dominant cost is the re-sent
  snapshot, so every extra round-trip is expensive regardless of arm.
- **naive `change-bio-s06` ~33K / 5 calls:** the genuine bad case — the model
  looped (`write_file`/`read`/`terminal`) hunting for the bio value it was never
  told the location of. This is exactly the discovery cost the skill removes.
- **`upvote-s03` playbook adherence:** the playbook calls the vote a self-inverse
  toggle ("capture nothing"), yet the artifact still recorded a full
  `browser_run_code` retract sequence and took the confirm turn — qwen did not
  take the cheapest ("capture nothing", one shot) path the recipe offered. Open
  item: weak-model adherence to "capture nothing" recipes.

## Coverage notes / caveats (kept honest)

- **Small n:** 8 vs 7 fired tasks. Treat magnitudes as directional.
- **`delete-submission` fired 0 backups in BOTH arms.** Root cause is upstream of
  the backup method: the deepseek-pro **main agent failed to complete** postmill's
  confirm-dialog delete flow (trace = 8 `browser_navigate` calls wandering
  post/forum/search/profile, no delete click). No mutation attempted -> correctly
  no backup. Experience-independent; a main-agent capability gap on a hard task.
- **`upvote` token outlier (+skills s03 ~35K):** the playbook calls the vote a
  self-inverse toggle ("capture nothing"), but qwen still spent 2 calls / 35K on
  it — the recipe was not followed cheaply. Open item to investigate (playbook
  adherence on the weakest model).
- **naive `upvote-s03` fired nothing:** without the learned `upvote` trigger, the
  generic verb heuristics did not classify the vote click as backup-worthy — an
  instance of the experience's *gating* value (skills caught both upvotes).
- Tokens are request-body chars/4 (approx), not provider-billed tokens; no prompt
  caching applied in either arm.

## Takeaway

- **`naive < +skills-in-prompt` holds** on qwen3.6-35b-a3b, and the mechanism is
  exactly the hypothesis: **fewer actions per run** (skip the discovery step),
  not merely a shorter prompt.
- The experience additionally **improves backup faithfulness** on the
  knowledge-dependent task (bio), turning give-up-to-UNVERIFIED into a
  deterministic restore.
- This sets up the next rung: distill the playbook into the model so the skills
  are internalized at **zero marginal prompt tokens** — expected
  `distilled-with-skills` <= `+skills-in-prompt` on cost, with quality held.

## Artifacts

- `results/webarena/qwen10-skills/ALL.csv`, `.../runs/<task>/` (dumps, backups)
- `results/webarena/qwen10-naive/ALL.csv`, `.../runs/<task>/`
- experience: `remote_test/experiences/reddit.json`
