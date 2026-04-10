# CHATS-Sandbox

General-purpose sandbox plugin for Claude Code. Automatically backs up state before destructive tool calls, enforces safety policies, and logs effect manifests.

## How It Works

CHATS-Sandbox hooks into Claude Code's `PreToolUse` and `PostToolUse` lifecycle events. Before any tool call executes, it decides whether to deny, backup, or pass through.

### Backup Tiers (cheapest first)

| Tier | Strategy | What it captures | When used |
|------|----------|-----------------|-----------|
| 1st | Targeted manifest | `pip freeze`, `npm list`, `git tag`, `env snapshot` | Known patterns (pip install, git push, etc.) |
| 2nd | `git add -A` | Full workspace snapshot (git-compressed) | All other workspace-modifying actions |
| 3rd | Subagent (Haiku) | Out-of-workspace state (remote APIs, system config) | When action touches outside workspace AND tiers 1-2 can't cover it |

### Workspace Scope Detection

The sandbox inspects tool call arguments to detect if the action affects state outside the current workspace (e.g., `pip install` touches `/usr/lib/`, `git push` touches remote, `curl -X POST` calls an API). Only out-of-workspace actions that aren't covered by a targeted manifest trigger the subagent.

## Install

```bash
cd your-project
npm install chats-sandbox
npx chats-sandbox install
```

This wires `PreToolUse` + `PostToolUse` hooks into `.claude/settings.json` and creates a `.chats-sandbox/` config directory.

## Uninstall

```bash
npx chats-sandbox uninstall
```

## Commands

```bash
chats-sandbox status                    # Show sandbox state
chats-sandbox config                    # Show configuration
chats-sandbox config set backupMode smart  # Set a config value
chats-sandbox backups                   # List recent backup artifacts
```

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
  interaction_002_20260410_1912/
    ...
```

Oldest interaction folders are automatically pruned when `maxInteractions` is exceeded.

## Safety Rules

**Deny rules** block dangerous commands outright (exit code 2):
- `rm -rf /` (except `/tmp`)
- `mkfs.*`
- `dd if=... of=/dev/...`
- Fork bombs

**Read-only tools** are always passed through without backup:
- `Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`

**Everything else** gets backed up. Unknown actions default to backup (safe by default).

## License

MIT
