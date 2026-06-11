# Self-exploration experience samples

Real outputs of `chats-sandbox explore` (two-stage propose→verify pipeline),
generated with claude runner / Sonnet 4.6 for both stages, June 8–9 2026.
Live verification ran against a disposable postgres instance (postgres-mcp,
unrestricted) and the filesystem MCP, on `chats_probe_*` throwaway items.

| File | Server | Result | Note |
|------|--------|--------|------|
| `postgres-verified-8of8.json` | postgres | 8 patterns, 8/8 verified | the production-quality run |
| `filesystem-verified-6of6.json` | filesystem | 6 patterns, 6/6 verified | |
| `postgres-firstrun-0verified.json` | postgres | 7 patterns, 0 verified | historical: first run, before the stage-2 safety guard (verifier broke DB auth via unrestricted ALTER USER); kept as the motivating example for the guard |

Deploy format: these are verbatim `.chats-sandbox/experiences/<server>.json`
files — drop one into a project's experiences dir and the tier-3 backup
subagent picks it up (verified patterns first).
