# OpenClaw CLI Reference

## Diagnostic Commands

### `openclaw status`
Overall system status: channels, sessions, gateway health.
```bash
openclaw status
openclaw status --all
openclaw status --deep    # live probes
openclaw status --json
```

### `openclaw gateway status`
Service + RPC probe status.
```bash
openclaw gateway status
openclaw gateway status --json
openclaw gateway status --deep  # scan system services
```
Expected healthy output: `Runtime: running`, `RPC probe: ok`

### `openclaw doctor`
Health checks, config migrations, repair steps.
```bash
openclaw doctor
openclaw doctor --yes        # accept defaults without prompting
openclaw doctor --repair     # apply recommended repairs
openclaw doctor --repair --force  # aggressive repairs
openclaw doctor --non-interactive # safe-only migrations
openclaw doctor --deep       # scan system services
```

### `openclaw logs`
```bash
openclaw logs --follow
openclaw logs --json
openclaw logs --plain
```

### `openclaw health`
```bash
openclaw health
openclaw gateway health --url ws://127.0.0.1:18789
```

### `openclaw channels status`
```bash
openclaw channels status
openclaw channels status --probe  # live connectivity test
```

## Gateway Management

```bash
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway install
openclaw gateway install --force   # reinstall service
openclaw gateway uninstall
openclaw gateway probe             # debug all reachable gateways
openclaw gateway discover          # Bonjour scan
```

## Configuration

```bash
openclaw config get                    # show entire config
openclaw config get agents.defaults.workspace
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config unset tools.web.search.apiKey
openclaw configure                     # interactive wizard
openclaw onboard                       # full setup wizard
```

## Other Useful Commands

```bash
openclaw --version
openclaw nodes status
openclaw cron status
openclaw cron list
openclaw devices list
openclaw pairing list --channel <channel>
openclaw browser status
openclaw models status
```

## Key Ports and URLs
- Gateway WebSocket: `ws://127.0.0.1:18789`
- Control UI: `http://127.0.0.1:18789`
- Default gateway port: **18789**

## Environment Variables
- `OPENCLAW_LOG_LEVEL` - override log level (debug, info, warn, error)
- `OPENCLAW_DIAGNOSTICS` - enable diagnostic flags (e.g., "telegram.http")
- `OPENCLAW_STATE_DIR` - override state directory
- `OPENCLAW_GATEWAY_TOKEN` - gateway auth token
- `OPENCLAW_GATEWAY_PASSWORD` - gateway auth password
