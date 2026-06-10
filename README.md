# CHATS-Sandbox

General-purpose backup/restore plugin for autonomous coding agents. It hooks the agent's `PreToolUse` event and snapshots state **before** any potentially destructive tool call runs, so you can undo any action. Works with Claude Code, and with Hermes / OpenHands / OpenClaw via pluggable agent adapters.

## Quick Start

```bash
# Clone, build, link globally
git clone https://github.com/xli04/CHATS-Sandbox.git
cd CHATS-Sandbox
npm install && npm run build && npm link

# Go to your project and install the hooks
cd /path/to/your/project
chats-sandbox install            # auto-detects the agent (Claude Code by default)
# chats-sandbox install hermes   # or target a specific agent: hermes | openhands | openclaw

# Runs automatically on every tool call from now on.

chats-sandbox status             # see what's been backed up
chats-sandbox history            # timeline of recent actions
chats-sandbox restore            # undo the last step (default)
chats-sandbox restore 3          # reverse-loop restore to action 3
chats-sandbox diff               # what did the last step change? (default)
chats-sandbox clear              # wipe all backup state
chats-sandbox uninstall          # remove hooks entirely
```

## How It Works

Hooks into the agent's `PreToolUse` event. Before any tool call executes, it decides whether to back up or pass through, capturing the state **before** the tool runs. Each backed-up tool call becomes a numbered **action** folder under `.chats-sandbox/backups/action_NNN_TIMESTAMP/`.

### Backup Tiers (cheapest first)

The pipeline tries tiers in order and stops at the first that covers the action.

| Tier | Strategy | What it captures | When used |
|------|----------|-----------------|-----------|
| **T0** | **Policy rewrite** | Rewrites a destructive command into a reversible equivalent (e.g. `rm` → move to per-action trash) and records the exact inverse | Recognized destructive commands (see [Tier 0 Policy Rules](#tier-0-policy-rules)) |
| **T1** | Targeted manifest | `pip freeze`, `npm list`, `git tag`, `env` snapshot | Known patterns (pip install, git push, etc.) |
| **T2** | `git add -A` in a **shared shadow repo** | Full workspace state, git-compressed + deduplicated | Any workspace change not handled by T0/T1 |
| **T3** | Subagent (Haiku by default) | Out-of-workspace / remote state (MCP servers, remote APIs, system config) | Action touches outside the workspace AND T0–T2 can't cover it |

The shared shadow repo lives at `.chats-sandbox/shadow-repo/`. Each action is a commit in that one repo, so git deduplication keeps storage cheap. Read-only actions (`ls`, `cat`, MCP `*_get`/`*_list`, etc.) produce no commit and no action folder — folders are created **lazily**, only when a real change is detected.

### Tier 0 Policy Rules

Tier 0 is the cheapest and most deterministic tier: it intercepts a destructive command, performs a reversible equivalent, and records an exact shell inverse as the recovery — **no LLM needed to restore**. `rm`-to-trash and no-clobber `mv` are O(1) inode renames; the copy-based rules snapshot only the affected file(s), not the whole workspace.

| Rule | Reverses |
|------|----------|
| `rm-to-trash` | `rm` → move into per-action trash; restore moves back (LIFO) |
| `mv-overwrite` | `mv src dst` → record inverse `mv`; snapshots a clobbered destination |
| `sed-in-place` | `sed -i` → snapshot file bytes first; restore via `cp` back |
| `truncate` | `truncate` → snapshot bytes before shrink/wipe |
| `chmod` / `chown` | record old mode / owner; restore re-applies it |
| `git-reset-hard` | record HEAD; restore `git reset --hard <sha>` |
| `git-branch-delete-force` | record branch sha; restore `git branch -f` |
| `git-stash-drop` | preserve the dropped stash under a backup ref |
| `git-push-force` | record remote sha before force-push |
| `git-discard-worktree` | snapshot bytes before `git restore` / `git checkout -- <path>` discards them |
| `docker-rm` / `docker-volume-rm` / `docker-image-rm` | commit / tar / `docker save` before removal |
| `kubectl-delete` | `kubectl get -o yaml` before deleting a single namespaced resource |
| `outside-workspace-write-new` | new file outside cwd → record `rm` as recovery |

Each rule bails conservatively (compound commands, cross-filesystem moves, dangerous/system paths, ambiguous flags) and falls through to T1–T3 instead. To author more rules, see [`docs/policy-rules.md`](docs/policy-rules.md).

### Self-Exploration (learned remote reversals)

For remote/MCP actions that reach T3, the default recovery is expensive (scrape the remote state and recreate it, which loses identity — new IDs/timestamps). The `explore` command learns cheaper **"easy-win" reversals** per MCP server and injects them into the T3 subagent's context:

```bash
chats-sandbox explore [server] [--target URL]   # learn easy-win reversal patterns
```

A two-stage pipeline (modeled on NVIDIA ToolShield): stage 1 a model **proposes** the cheapest in-place reversal per destructive action (e.g. "delete a post → set it to private; reverse = set public"); stage 2 a live agent **verifies** each proposal against the real backend and records only what actually worked. Verified patterns are stored at `.chats-sandbox/experiences/<server>.json` and surfaced (verified-first) to the subagent so it prefers the cheap reversal over scrape-and-recreate.

## Slash Commands (inside the agent)

```
/sandbox:status            Show sandbox state
/sandbox:history           Timeline of recent actions
/sandbox:restore           Reverse-loop restore (undo last step by default)
/sandbox:restore_direct    Direct jump restore
/sandbox:diff              Diff against a previous action
/sandbox:backups           List backup artifacts
/sandbox:config            Show/edit configuration
/sandbox:clear             Wipe all backup state
```

## CLI Commands

```bash
chats-sandbox install [agent]           # Wire hooks + slash commands (agent: claude-code | hermes | openhands | openclaw)
chats-sandbox uninstall [agent]         # Remove hooks + slash commands
chats-sandbox status                    # Show sandbox state
chats-sandbox config [set <k> <v>]      # Show or update config
chats-sandbox history [N]               # Timeline of last N actions (default 10)
chats-sandbox backups                   # List all backup artifacts
chats-sandbox explore [server] [--target URL]  # Learn easy-win remote reversal patterns
chats-sandbox restore [N]               # Reverse-loop restore (default: undo last step)
chats-sandbox restore <N> --file <path> # Restore a single file from action N
chats-sandbox restore_direct [N]        # Direct jump restore (default: undo last step)
chats-sandbox diff [N]                  # Diff action N vs current state (default: last step)
chats-sandbox dashboard                 # Launch the local web dashboard
chats-sandbox clear                     # Delete all action folders, shadow repo, and effect log
```

## Restore Behavior

Since each snapshot captures the state **before** an action ran:

- `restore 3` with 5 actions → workspace returns to pre-action-3 state. Actions 3, 4, 5 are pruned. Folders 1 and 2 remain.
- `restore` with no arg → undo just the last step.
- `restore N --file <path>` → restore a single file only. Does not prune folders.

Two modes:

- **`restore <N>`** (reverse loop) — Undoes actions one by one from the latest back to N. Safer for non-workspace state (packages, env vars, remote refs). Each step is a small, well-defined reversal.
- **`restore_direct <N>`** (direct jump) — Restores the workspace directly from action N's git snapshot. Fast, but only covers workspace files.

Restore correctly handles file creation, deletion, and modification:

| Situation | Result after restore |
|-----------|---------------------|
| File modified after target | Overwritten with target version |
| File created after target | Deleted |
| File deleted after target | Recreated |

| Backup strategy | Restore method |
|----------------|----------------|
| `policy_rewrite` | Recorded recovery commands run verbatim (no LLM) |
| `pip_freeze` | `pip install -r <snapshot>` |
| `npm_list` | `npm install` from saved JSON |
| `env_snapshot` | Re-export from saved file |
| `git_tag` | `git reset --hard <tag>` |
| `git_snapshot` | `git read-tree` + `checkout-index` + `clean -fd` |
| `subagent` | Recorded recovery commands; or a fresh **live-restore** subagent that reads current remote state when canned commands can't be trusted |

## Configuration

Stored in `.chats-sandbox/config.json` (edit via `chats-sandbox config set <key> <value>`):

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Master switch |
| `backupMode` | `"smart"` | `"smart"` / `"always"` / `"off"` |
| `maxActions` | `50` | Max action folders before pruning oldest. `0` = disabled |
| `maxTotalSizeMB` | `0` | Prune oldest until total action size is under this cap. `0` = disabled |
| `maxAgeHours` | `0` | Prune folders older than this. `0` = disabled |
| `effectManifest` | `true` | Log effect manifests to JSONL |
| `verbose` | `false` | Verbose stderr logging |
| `denyPatterns` | `[]` | Opt-in regex patterns that block tool calls entirely |
| `alwaysBackupPatterns` | `[...]` | Regex patterns that always trigger backup |
| `subagentEnabled` | `true` | Enable the T3 subagent for out-of-workspace actions |
| `subagentModel` | `"haiku"` | Subagent model: `haiku` / `sonnet` / `opus` / `inherit` |
| `subagentTimeoutSeconds` | `60` | Max wait for the subagent before giving up |
| `subagentPermissionMode` | `"bypassPermissions"` | `bypassPermissions` (full freedom) / `acceptEdits` (fs-only, smaller blast radius) |
| `subagentRunner` | `"claude"` | Which runner spawns the subagent: `claude` (`claude -p`) or `hermes` (`hermes chat`) |
| `subagentHermesModel` | `"anthropic/claude-haiku-4.5"` | Model id for the hermes runner |
| `subagentHermesProvider` | `"openrouter"` | Provider for the hermes runner |

Trash from Tier 0 rewrites lives **inside** each action folder, so the three retention knobs above (`maxActions` / `maxTotalSizeMB` / `maxAgeHours`) govern it automatically — no separate lifecycle.

## Storage Layout

```
.chats-sandbox/
  config.json                     # Sandbox configuration
  effects.jsonl                   # Effect manifest log
  shadow-repo/                    # Shared shadow git repo (all T2 snapshots)
  experiences/
    <server>.json                 # Learned easy-win reversal patterns (from `explore`)
  backups/
    action_001_TIMESTAMP/
      pip_freeze_abc123.txt       # T1 targeted manifest
      trash/                      # T0 rewrite payloads (e.g. files moved aside by rm)
      metadata.json               # Artifact index (commit hash, recovery commands, etc.)
    action_002_TIMESTAMP/
      metadata.json
```

Action folders are created **lazily** — only when a real change is detected. Read-only actions (`ls`, `cat`, `chats-sandbox status`, etc.) produce no folder.

## Dashboard

`chats-sandbox dashboard` launches a local web UI: a timeline of backed-up actions with per-action diffs, backup tier, and recovery commands; one-click restore; and a Backups tab with **By file**, **By size**, and **Location Table** views of where backups physically live.

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
