# self-exploration

Self-exploration pipeline for CHATS-Sandbox: learn the cheapest **easy-win**
reversal for each destructive operation an MCP server exposes, so the tier-3
backup subagent prefers an in-place reverse (delete→private, edit→version-restore,
file→trash) over the expensive scrape-and-recreate default.

Modeled on NVIDIA ToolShield's experience pipeline, but aimed at *recoverability*
instead of *safety*.

## Layout

| File | Role |
| --- | --- |
| `prompts.ts` | **All prompts** — stage-1 proposal, stage-2 verify, read-only verify. |
| `tree_generation.ts` | **Stage 1 (PROPOSE)** — enumerate every mutating op + propose an easy-win for each; all JSON parsers (hardened against hallucination). |
| `verify.ts` | **Stage 2 (VERIFY)** — a live agent executes each proposed reversal against a freshly-seeded sandbox; keep / adjust / delete + harvest. |
| `mcp_scan.ts` | Live tool discovery (initialize → tools/list) + backup-history target/server scan. |
| `explore.ts` | Orchestrator (`runExplore`) — ties stage 1 + 2, accumulates with prior results, saves. |
| `infra.ts` | Bridge to the main build's shared modules (`experiences`, `subagent`, `extract_json`). |
| `types.ts` | Local types. |
| `self_exploration.sh` | Starting script (mirrors ToolShield's) — args: `tools`/`agent`/`model`/`provider`. |
| `results/` | Per-server result archive (`<server>.json`). |

The shared, backup-runtime modules it reuses — `experiences.ts`, `tool_registry.ts`,
`list_mcp_tools.ts`, `extract_json.ts` — deliberately stay in the main `src/` tree
(the backup/restore path depends on them); this module imports their compiled
output via `infra.ts`.

## Build

`npm run build` (in the repo root) builds the main project **then** this module
into `dist/self-exploration/` (it needs the main build's `.d.ts` first).

## Run

It is **standalone** — it does **not** read `.chats-sandbox/config.json`. The
runner (`--agent`), model (`--model`), and server (`--tools`/positional) come
from args. A single model drives both stages.

```bash
export OPENROUTER_API_KEY=...                 # required
./self_exploration.sh postgres                # agent=hermes, model=deepseek/deepseek-v4-pro (defaults)
AGENT=hermes MODEL=deepseek/deepseek-v4-pro ./self_exploration.sh postgres
# or directly:
node ../dist/cli.js explore postgres --agent hermes --model deepseek/deepseek-v4-pro --provider openrouter
```

**Agent support:** stage-2 (verify) needs live MCP tools, which today is wired
only for `--agent hermes`; `claude`/`codex`/`openclaw` are rejected by the CLI
(their verify stage would get no tools). Live tool discovery reads the named
server from `~/.hermes/config.yaml` regardless of agent.

Each server's learned experiences are written to `results/<server>.json` (for
inspection) and to the runtime experiences dir (`<cwd>/.chats-sandbox/experiences/`,
cwd-relative — run explore from the project whose backup subagent will consume
them), where the easy-win patterns get injected into the backup prompt.
