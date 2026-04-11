# CHATS-Sandbox

General-purpose sandbox plugin for Claude Code. Automatically backs up state before destructive tool calls and logs effect manifests, so you can restore to any previous interaction.

## Quick Start

```bash
# Clone, build, link globally
git clone https://github.com/xli04/CHATS-Sandbox.git
cd CHATS-Sandbox
npm install && npm run build && npm link

# Go to your project and install the hooks
cd /path/to/your/project
chats-sandbox install

# Runs automatically on every Claude Code tool call from now on.

chats-sandbox status             # see what's been backed up
chats-sandbox history            # timeline of recent interactions
chats-sandbox restore            # undo the last step (default)
chats-sandbox restore 3          # reverse-loop restore to interaction 3
chats-sandbox diff               # what did the last step change? (default)
chats-sandbox clear              # wipe all backup state
chats-sandbox uninstall          # remove hooks entirely
```

## How It Works

Hooks into Claude Code's `PreToolUse` event. Before any tool call executes, it decides whether to back up or pass through. Snapshots capture the state **before** the tool runs.

### Backup Tiers (cheapest first)

| Tier | Strategy | What it captures | When used |
|------|----------|-----------------|-----------|
| 1st | Targeted manifest | `pip freeze`, `npm list`, `git tag`, `env snapshot` | Known patterns (pip install, git push, etc.) |
| 2nd | `git add -A` in a **shared shadow repo** | Full workspace state, git-compressed + deduplicated | All workspace changes |
| 3rd | Subagent (Haiku) | Out-of-workspace state (remote APIs, system config) | When action touches outside workspace AND tiers 1-2 can't cover it |

The shared shadow repo lives at `.chats-sandbox/shadow-repo/`. Each interaction is a commit in that one repo, so git deduplication keeps storage cheap. Read-only actions produce no commit → no interaction folder.

## Slash Commands (inside Claude Code)

```
/sandbox:status            Show sandbox state
/sandbox:history           Timeline of recent interactions
/sandbox:restore           Reverse-loop restore (undo last step by default)
/sandbox:restore_direct    Direct jump restore
/sandbox:diff              Diff against a previous interaction
/sandbox:backups           List backup artifacts
/sandbox:config            Show/edit configuration
/sandbox:clear             Wipe all backup state
```

## CLI Commands

```bash
chats-sandbox install                   # Wire hooks + slash commands
chats-sandbox uninstall                 # Remove hooks + slash commands
chats-sandbox status                    # Show sandbox state
chats-sandbox config [set <k> <v>]      # Show or update config
chats-sandbox history [N]               # Timeline of last N interactions (default 10)
chats-sandbox backups                   # List all backup artifacts
chats-sandbox restore [N]               # Reverse-loop restore (default: undo last step)
chats-sandbox restore <N> --file <path> # Restore a single file from interaction N
chats-sandbox restore_direct [N]        # Direct jump restore (default: undo last step)
chats-sandbox diff [N]                  # Diff interaction N vs current state (default: last step)
chats-sandbox clear                     # Delete all interaction folders, shadow repo, and effect log
```

## Restore Behavior

Since each snapshot captures the state **before** an interaction ran:

- `restore 3` with 5 interactions → workspace returns to pre-interaction-3 state. Interactions 3, 4, 5 are pruned. Folders 1 and 2 remain.
- `restore` with no arg → undo just the last step.
- `restore N --file <path>` → restore a single file only. Does not prune folders.

Two modes:

- **`restore <N>`** (reverse loop) — Undoes interactions one by one from the latest back to N. Safer for non-workspace state (packages, env vars, remote refs). Each step is a small, well-defined reversal.
- **`restore_direct <N>`** (direct jump) — Restores workspace directly from interaction N's git snapshot. Fast, but only covers workspace files.

Restore correctly handles file creation, deletion, and modification:

| Situation | Result after restore |
|-----------|---------------------|
| File modified after target | Overwritten with target version |
| File created after target | Deleted |
| File deleted after target | Recreated |

| Backup strategy | Restore method |
|----------------|----------------|
| `pip_freeze` | `pip install -r <snapshot>` |
| `npm_list` | `npm install` from saved JSON |
| `env_snapshot` | Re-export from saved file |
| `git_tag` | `git reset --hard <tag>` |
| `git_snapshot` | `git read-tree` + `checkout-index` + `clean -fd` |
| `subagent` | Prompt generated with backup context |

## Configuration

Stored in `.chats-sandbox/config.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Master switch |
| `backupMode` | `"smart"` | `"smart"` / `"always"` / `"off"` |
| `maxInteractions` | `50` | Max interaction folders before pruning oldest |
| `effectManifest` | `true` | Log effect manifests to JSONL |
| `verbose` | `false` | Verbose stderr logging |
| `denyPatterns` | `[]` | Opt-in regex patterns that block tool calls entirely |
| `alwaysBackupPatterns` | `[...]` | Regex patterns that always trigger backup |

## Storage Layout

```
.chats-sandbox/
  config.json                     # Sandbox configuration
  effects.jsonl                   # Effect manifest log
  shadow-repo/                    # Shared shadow git repo (all snapshots)
  backups/
    interaction_001_TIMESTAMP/
      pip_freeze_abc123.txt       # 1st-tier targeted manifest
      metadata.json               # Artifact index (commit hash, description, etc.)
    interaction_002_TIMESTAMP/
      metadata.json
```

Interaction folders are created **lazily** — only when a real change is detected. Read-only actions (`ls`, `cat`, `chats-sandbox status`, etc.) produce no folder.

## Development

```bash
npm install          # Install dependencies
npm run build        # Build src + tests
npm run lint         # ESLint
npm run test         # Build + run test suite
npm run check        # Lint + test (use in CI)
```

## License

MIT
