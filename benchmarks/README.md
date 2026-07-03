# CHATS-Sandbox evaluation pipeline

One driver, any benchmark. Pick a **dataset**, an **agent**, and one or more backup
**conditions**; the dataset adapter runs the agent once per task and measures each
requested condition on the identical action sequence.

```bash
# SWE-bench: plugin vs git-add vs cp-all on one agent run, 30 instances, 4-way parallel
./eval.sh --dataset swe --agent hermes \
          --condition plugin,git-add,cpall \
          --model deepseek/deepseek-v4-pro --subagent-model deepseek/deepseek-v4-flash \
          --n 30 --concurrency 4 --report

# a single behavioral baseline (own run): hermes native checkpoints
./eval.sh --dataset swe --agent hermes --condition native --tasks django__django-13109

# WebArena reddit, subagent-backup vs inline-backup
./eval.sh --dataset webarena --agent hermes --condition plugin,inline --n 10
```

Convenience wrappers preset `--dataset`: `./swe.sh …`, `./regret.sh …`, `./webarena.sh …`, `./mcp.sh …`.

## Flags
| flag | meaning | default |
|---|---|---|
| `--dataset` | `swe`·`regret`·`webarena`·`mcp` or a path to an adapter `.sh` | (required) |
| `--agent` | `hermes`·`claude` (see `agents/`) | `hermes` |
| `--condition` | comma list of `conditions/` (see below) | `plugin` |
| `--model` / `--subagent-model` | main agent / tier-3 subagent model | pro / flash |
| `--n` / `--concurrency` | number of tasks / parallel workers | all / 4 |
| `--tasks` | explicit comma list (overrides `ds_tasks`) | — |
| `--filter` | regex over task ids | — |
| `--timeout` | per-agent-turn seconds | 600 |
| `--report` | also write `RESULTS.md` via `analyze/aggregate.py` | off |

Runs are **resume-safe** (re-invoke to fill in missing tasks) and write to
`results/<dataset>/<run>/ALL.csv` (one schema, see `lib/common.sh:CSV_HEADER`).

## Conditions
- **observational** (passive hooks, co-measured on ONE agent run): `plugin`, `git-add`, `cpall`
- **behavioral** (change the agent invocation → each its own run): `native` (`--checkpoints`), `inline` (a `[BACKUP]` prompt preamble)

The driver auto-splits a `--condition` list into the observational group + one run per behavioral cond.

## Layout
```
eval.sh                 entrypoint (+ swe.sh/regret.sh/webarena.sh/mcp.sh wrappers)
lib/common.sh           CSV schema, atomic appends, concurrency pool, resume, cid()
datasets/<d>.sh         env primitives (denv_exec/denv_cp/denv_workdir) + ds_tasks + ds_task
datasets/swe/           SWE instruments (observer.py, manifest.py, cpall.py, drill.txt)
agents/<a>.sh           agent_install + agent_invoke
conditions/<c>.sh       cond_<id>_install / _disk_ms / _coverage (+ _behavioral/_agent_args/_pre_run/_prompt_prefix)
analyze/                aggregate.py (RESULTS.md), recompute-tokens.py, recovery_quality.py
results/<dataset>/<run>/ ALL.csv + runs/<task>/ forensics + RESULTS.md
```

## Adding things
- **Dataset**: write `datasets/<name>.sh` providing `ds_tasks` and `ds_task <task> <group_conds>`, plus the env primitives `denv_exec`/`denv_cp`/`denv_workdir`. Emit rows with `emit_row` (from `lib/common.sh`).
- **Agent**: write `agents/<name>.sh` with `agent_install` and `agent_invoke <prompt_file> <out_log> [args…]` operating through `denv_*`. Set `AGENT_PLUGIN_TARGET` if the plugin knows the runner by another name.
- **Condition**: write `conditions/<name>.sh` with `cond_<id>_install` (observational) **or** `cond_<id>_behavioral` + optional `_agent_args`/`_pre_run`/`_prompt_prefix` (behavioral), plus `cond_<id>_disk_ms` and `cond_<id>_coverage`. `<id>` = name with dashes removed.
