# CHATS-Sandbox

General-purpose sandbox plugin for Claude Code. Automatically backs up state before destructive tool calls, enforces safety policies, and logs effect manifests.

## Quick Start

```bash
npm install chats-sandbox
npx chats-sandbox install

# Done. Runs automatically on every Claude Code tool call.
# Blocks dangerous commands, backs up before destructive actions, logs effects.

npx chats-sandbox status             # see what's been backed up
npx chats-sandbox restore            # list restore points
npx chats-sandbox restore 3          # reverse-loop restore to interaction 3
npx chats-sandbox restore_direct 3   # direct jump to interaction 3's snapshot
npx chats-sandbox diff 3             # preview changes since interaction 3
npx chats-sandbox config set enabled false  # turn off
npx chats-sandbox uninstall          # remove hooks entirely
```

## How It Works

Hooks into Claude Code's `PreToolUse` and `PostToolUse` events. Before any tool call executes, it decides whether to deny, backup, or pass through.

### Backup Tiers (cheapest first)

| Tier | Strategy | What it captures | When used |
|------|----------|-----------------|-----------|
| 1st | Targeted manifest | `pip freeze`, `npm list`, `git tag`, `env snapshot` | Known patterns (pip install, git push, etc.) |
| 2nd | `git add -A` | Full workspace snapshot (git-compressed) | All other workspace-modifying actions |
| 3rd | Subagent (Haiku) | Out-of-workspace state (remote APIs, system config) | When action touches outside workspace AND tiers 1-2 can't cover it |

The sandbox inspects tool call arguments to detect if the action affects state outside the current workspace. Only out-of-workspace actions that aren't covered by a targeted manifest trigger the subagent.

## Commands

```bash
chats-sandbox install                         # Wire hooks into .claude/settings.json
chats-sandbox uninstall                       # Remove hooks
chats-sandbox status                          # Show sandbox state
chats-sandbox config                          # Show configuration
chats-sandbox config set <key> <value>        # Set a config value
chats-sandbox backups                         # List recent backup artifacts
chats-sandbox restore                         # List restorable interactions
chats-sandbox restore <N>                     # Reverse-loop restore to interaction N
chats-sandbox restore <N> --file <path>       # Restore single file from interaction N
chats-sandbox restore_direct <N>              # Direct jump to interaction N's snapshot
chats-sandbox diff <N>                        # Diff interaction N vs current state
```

## Restore

Two restore modes:

- **`restore <N>`** (reverse loop) — Undoes interactions one by one from latest back to N+1. Each step is a small reversal. Safer for non-workspace state (packages, env vars, remote refs).
- **`restore_direct <N>`** (direct jump) — Restores workspace directly from interaction N's git snapshot. Fast, but only covers workspace files.

| Backup strategy | Restore method | Automatic? |
|----------------|----------------|------------|
| `pip_freeze` | `pip install -r <snapshot>` | Yes |
| `npm_list` | `npm install` from saved JSON | Yes |
| `env_snapshot` | Re-export from saved file | Yes |
| `git_tag` | `git reset --hard <tag>` | Yes |
| `git_snapshot` | `git checkout <hash> -- .` from shadow repo | Yes |
| `subagent` | Prompt generated with backup context | Needs subagent |

## Configuration

Stored in `.chats-sandbox/config.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Master switch |
| `backupMode` | `"smart"` | `"smart"` = rule + precaution, `"always"` = backup everything, `"off"` = disabled |
| `maxInteractions` | `50` | Max interaction folders before pruning oldest |
| `effectManifest` | `true` | Log effect manifests to JSONL |
| `verbose` | `false` | Verbose stderr logging |
| `denyPatterns` | `[...]` | Regex patterns that block tool calls entirely |
| `alwaysBackupPatterns` | `[...]` | Regex patterns that always trigger backup |

## Backup Storage

```
.chats-sandbox/backups/
  interaction_001_20260410_1906/    # One folder per user turn
    pip_freeze_abc123.txt           # 1st tier: targeted manifest
    git_snapshot/                   # 2nd tier: shadow git repo
    metadata.json                   # Artifact index for this interaction
```

Oldest folders auto-pruned when `maxInteractions` is exceeded.

## Development

```bash
npm install          # Install dependencies
npm run build        # Build src + tests
npm run lint         # ESLint
npm run test         # Build + run 47 tests
npm run check        # Lint + test (use in CI)
```

## License

MIT
