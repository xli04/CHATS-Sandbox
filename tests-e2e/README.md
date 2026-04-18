# End-to-end tests

Shell scripts that drive a real `claude -p` subprocess against a real
installation of the plugin, asserting on disk state. Complements the unit
tests in `tests/`, which mock the hook context.

## Requirements

- `claude` CLI on PATH, authenticated (run `claude` interactively once to
  complete OAuth). Tested against Claude Code 2.1.114.
- Not root. The CLI refuses `--dangerously-skip-permissions` for EUID 0.
- The repo built: `npm run build` at the repo root.
- `python3` and `curl` available (used for assertions on JSON payloads and
  dashboard endpoints).

## Running

All scripts together:

```bash
bash tests-e2e/run_all.sh
```

One at a time (useful when iterating on a specific path):

```bash
bash tests-e2e/03_outside_workspace_subagent.sh
```

Each script creates its project under `/tmp/chats-e2e-NN*` and leaves it in
place on exit so you can inspect. Subsequent runs wipe and recreate.

## What each scenario covers

| # | Scenario | Runs claude? | Focus |
|---|----------|--------------|-------|
| 01 | install wiring | no | settings.json hooks + deny rules, slash commands, config file |
| 02 | inside-workspace edit | yes | hook → git_snapshot artifact → action folder |
| 03 | outside-workspace edit | yes | subagent + `external-shadow/` + recovery commands |
| 04 | restore (both tiers) | no | tier-2 git_snapshot restore, tier-3 subagent command replay |
| 05 | retention pruning | no | maxActions cap, seq assignment after prune |
| 06 | dashboard HTTP endpoints | no | /, /api/actions, /api/config, /api/status round-trip |
| 07 | back-to-back actions | yes | no-drift pointer fallback (regression guard) |
| 08 | 12 alternating actions + 2 restores | yes | strategy mix per action type, 2-point restore validation |
| 09 | 10-action mixed chain + middle restore | yes | reverse-loop restore through 7 intermediates |
| 10 | same external file edited 6× + 5-step rewind | yes | subagent recovery under repeated overwrites |

## Cost

Scenarios that call `claude` go against your Claude Code subscription.
Typical cost per full run (scenarios 01-10): 30-60k tokens, mostly
cache-reads. Well under 1% of a standard daily rate window.

## Artifacts on failure

Scripts leave `/tmp/chats-e2e-NN*/` in place and write the claude raw
JSON output to `/tmp/e2e-NN-*.json`. If a scenario fails, inspect
those before rerunning.
