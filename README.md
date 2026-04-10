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

### Decision Flow

```
PreToolUse fires
  -> 1. Deny rules           -> block (exit 2)
  -> 2. Precaution field      -> backup (LLM set precaution=true)
  -> 3. Read-only tool?       -> pass (no backup needed)
  -> 4. Rule-based checklist   -> backup (known destructive pattern)
  -> 5. Default                -> backup (safe default for unknown actions)

Backup execution:
  -> 1st: Targeted manifest   -> done if matched
  -> 2nd: git add -A          -> done if succeeded
  -> 3rd: Subagent            -> only if outside-workspace AND 1st+2nd failed
```

## Install

```bash
cd your-project
npm install chats-sandbox
npx chats-sandbox install
```

This wires `PreToolUse` + `PostToolUse` + `PostToolUseFailure` hooks into `.claude/settings.json` and creates a `.chats-sandbox/` config directory.

## Uninstall

```bash
npx chats-sandbox uninstall
```

## Commands

```bash
chats-sandbox install                         # Wire hooks into .claude/settings.json
chats-sandbox uninstall                       # Remove hooks
chats-sandbox status                          # Show sandbox state
chats-sandbox config                          # Show configuration
chats-sandbox config set <key> <value>        # Set a config value
chats-sandbox backups                         # List recent backup artifacts
chats-sandbox restore                         # List restorable interactions
chats-sandbox restore <N>                     # Restore interaction N
chats-sandbox restore <N> --file <path>       # Restore single file from interaction N
chats-sandbox diff <N>                        # Diff interaction N vs current state
```

## Restore

Every backup is restorable. The restore engine picks the right strategy based on what was backed up:

| Backup strategy | Restore method | Automatic? |
|----------------|----------------|------------|
| `pip_freeze` | `pip install -r <snapshot>` | Yes |
| `npm_list` | `npm install` from saved JSON | Yes |
| `env_snapshot` | Re-export from saved file | Yes (provides command) |
| `git_tag` | `git reset --hard <tag>` | Yes |
| `git_snapshot` | `git checkout <hash> -- .` from shadow repo | Yes |
| `subagent` | Subagent prompt generated with backup context | Needs subagent |

For tier-3 (subagent) backups, the restore CLI outputs a prompt containing the original action, what was backed up, and the commands that were run. This prompt is sent to a subagent to execute the restore.

### Examples

```bash
# List what can be restored
chats-sandbox restore

# Output:
#   1. interaction_001_20260410194611  [pip_freeze, git_snapshot]
#      - Saved pip freeze snapshot
#      - git add -A snapshot (e1e0a905)
#   2. interaction_002_20260410194612  [git_snapshot]
#      - git add -A snapshot (e1e0a905)

# Restore everything from interaction 1
chats-sandbox restore 1

# Restore just one file
chats-sandbox restore 1 --file src/config.py

# See what changed since interaction 1
chats-sandbox diff 1
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

Oldest interaction folders are automatically pruned when `maxInteractions` is exceeded (default 50).

## Safety Rules

**Deny rules** block dangerous commands outright (exit code 2):
- `rm -rf /` (except `/tmp`)
- `mkfs.*`
- `dd if=... of=/dev/...`
- Fork bombs

**Read-only tools** are always passed through without backup:
- `Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`

**Everything else** gets backed up. Unknown actions default to backup (safe by default).

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
