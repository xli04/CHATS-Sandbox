# Reddit remote-test harness

Everything needed to start the WebArena/SafeArena **reddit forum** remote test,
in permanent files (nothing load-bearing in `/tmp`). The test runs the hermes
agent locally, drives a **logged-in** Playwright MCP browser against the forum,
and measures the backup cost of the out-of-workspace mutations.

## What lives here (permanent — survives reboots / `/tmp` wipes)

| path | what |
|---|---|
| `wa-pw-profile/` | the **logged-in** chromium profile (source of truth) |
| `experiences/reddit.json` | the learned reddit backup experience (produced by self-exploration; may be absent → runs fall back to generic guidance) |
| `env.sh` | canonical env + helper functions (`rt_seed_profile`, `rt_check_forum`) — **source it, don't run it** |
| `start.sh` | pre-run check: seeds the scratch profile, verifies the forum is up |

The browser actually runs against a **scratch** copy at `/tmp/wa-pw-profile`
(chromium locks/mutates its profile dir). `rt_seed_profile` re-creates that
scratch copy from `wa-pw-profile/` on every run, so the login is never lost.

## Prerequisites (out of scope for this dir)

- **Forum container up** on the isolated docker daemon
  (`unix:///mnt/data/sa-docker-run/docker.sock`, container `sa_forum_aa_0`).
  Bring-up lives in `OpenAgentSafety/servers` (`make up`). `start.sh` checks it.
- `OPENROUTER_API_KEY` exported (the run scripts require it).
- Playwright MCP is launched **per task in stdio mode** via
  `mcp_server/playwright_stdio.sh` (configured in `~/.hermes/config.yaml`
  `mcp_servers.playwright.command`). No shared gateway to keep alive.

## Usage

```bash
cd benchmarks
bash remote_test/start.sh            # check env + seed scratch profile (force: also overwrite existing)

# learn (or refresh) the reddit backup experience -- runs self-exploration
# against the live forum and publishes experiences/reddit.json:
OPENROUTER_API_KEY=sk-or-... bash remote_test/run_explore.sh

# subagent (tier-3) backup arm:
OPENROUTER_API_KEY=sk-or-... bash run_reddit10.sh          # -> results/webarena/reddit10-repro/
# inline (main-agent) backup arm:
OPENROUTER_API_KEY=sk-or-... bash run_reddit10_inline.sh   # -> results/webarena/reddit10-inline/
```

Both run scripts now `source remote_test/env.sh` and re-seed the profile
themselves, so they are self-contained from the permanent state above.

## Overridable env (defaults in `env.sh`)

`DOCKER_HOST`, `FORUM`, `FORUM_URL`, `RT_PROFILE_SRC`, `PW_PROFILE`,
`WEBARENA_EXP`, plus run knobs `WA_TASKS`, `WA_SAMPLES`.

## Troubleshooting

- **`Unknown toolsets: mcp-playwright` / agent falls back to curl** — stdio
  playwright failed to launch; check `mcp_server/playwright_stdio.sh` resolves a
  chromium build under `$PLAYWRIGHT_BROWSERS_PATH`.
- **Browser opens logged-out** — the scratch profile drifted; re-seed with
  `bash remote_test/start.sh force`.
- **`forum NOT up`** — start the SafeArena containers in `OpenAgentSafety/servers`.
- **Generic backup guidance (no patterns)** — `experiences/reddit.json` is
  missing; run the reddit self-exploration to produce it.
