---
description: Show or update CHATS-Sandbox configuration
argument-hint: "[set <key> <value>]"
---

Show or update CHATS-Sandbox configuration.

To show current config:

```bash
chats-sandbox config
```

To change a setting, run:

```bash
chats-sandbox config set $ARGUMENTS
```

Available settings:
- `enabled` (true/false) — master switch
- `backupMode` (smart/always/off) — backup strategy
- `maxInteractions` (number) — max interaction folders before pruning
- `effectManifest` (true/false) — enable effect logging
- `verbose` (true/false) — verbose output
