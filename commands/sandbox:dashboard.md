---
description: Launch the CHATS-Sandbox web dashboard (timeline + config editor)
argument-hint: "[--port N]"
---

Start the CHATS-Sandbox dashboard. It runs a local HTTP server (loopback only) that serves a web UI for browsing the action timeline and editing the sandbox config.

Run it **detached** so it keeps serving after this command returns:

```bash
nohup chats-sandbox dashboard $ARGUMENTS > .chats-sandbox/dashboard.log 2>&1 &
sleep 1
cat .chats-sandbox/dashboard.log
```

Then tell the user the URL printed in the log (e.g. `http://127.0.0.1:7321`) and that they can open it in any browser.

If the log shows `Could not start dashboard: port … already in use`, the user either already has the dashboard running or another process owns that port. Suggest they either:
- open the existing URL, or
- re-run with a different port: `/sandbox:dashboard --port 7400`

To stop the dashboard later:

```bash
pkill -f "chats-sandbox dashboard"
```
