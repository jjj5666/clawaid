# Official OpenClaw Doctor Reference

## Command: `openclaw doctor`

Health checks + quick fixes for the gateway and channels.

### Key Flags
- `--fix` or `--repair`: Apply recommended repairs without prompting
- `--yes`: Accept defaults without prompting  
- `--force`: Apply aggressive repairs (overwrites custom service config)
- `--deep`: Scan system services for extra gateway installs
- `--non-interactive`: Run without prompts (safe migrations only)

### What It Checks
1. **Doctor warnings** — config issues (e.g., groupPolicy mismatches, empty allowlists)
2. **State integrity** — orphan files, broken session references
3. **Session locks** — stale lock files from crashed processes
4. **Security** — channel security warnings
5. **Skills status** — eligible, missing requirements, blocked
6. **Plugins** — loaded, disabled, errors
7. **Channel status** — configured/not configured for each channel
8. **Channel warnings** — missing config for enabled channels

### Common Warnings and Fixes

| Warning | Meaning | Fix |
|---------|---------|-----|
| `groupPolicy is "allowlist" but groupAllowFrom is empty` | All group messages silently dropped | Add sender IDs to groupAllowFrom, or set groupPolicy to "open" |
| `orphan transcript files` | Old session files not in sessions.json | `openclaw doctor --fix` cleans them |
| `stale session lock` | Process that held lock is dead | `openclaw doctor --fix` removes stale locks |
| `Not configured (missing serverUrl or password)` | Channel enabled but not set up | Run the suggested configure command |

## Command: `openclaw gateway`

### Subcommands
- `status` — Show service status + probe reachability
- `start` — Start the Gateway service (launchd)
- `stop` — Stop the Gateway service
- `restart` — Restart the Gateway service
- `install` — Install the Gateway service (creates LaunchAgent plist)
- `install --force` — Reinstall, overwriting custom config
- `uninstall` — Remove the Gateway service
- `run` — Run gateway in foreground (for debugging)
- `run --force` — Kill existing listener, then run
- `probe` — Show reachability + discovery + health
- `health` — Fetch health from running gateway

### Key Gateway Options
- `--port <port>` — Default 18789
- `--bind <mode>` — loopback (default), lan, tailnet, auto, custom
- `--force` — Kill existing listener on target port before starting
- `--verbose` — Verbose logging

## Fix Priority Order (for ClawAid AI)

When diagnosing issues, try solutions in this order:
1. `openclaw doctor --fix` or `openclaw doctor --repair` (fixes most common issues)
2. `openclaw gateway restart` (fixes service/connection issues)
3. `openclaw gateway install --force` (fixes broken LaunchAgent/service)
4. `openclaw gateway run --force` (for debugging — kills port conflicts)
5. System commands: `kill`, `launchctl` (last resort for zombie processes)
6. File edits to openclaw.json or plist (absolute last resort, always backup first)

## Common Error Patterns

### Gateway won't start
- Port 18789 already in use → `lsof -i :18789` then kill the process, or `openclaw gateway run --force`
- Plist has wrong node path → `openclaw gateway install --force`
- Proxy env vars in plist → Remove with PlistBuddy, then `openclaw gateway restart`

### Gateway starts but agent doesn't respond
- Config has invalid model → Check `openclaw status`, look at model errors
- API key expired/invalid → Check provider config in openclaw.json
- JSON5 syntax error in config → Validate config file

### Desktop app (bot.molt.mac) not connecting
- Version mismatch between app and gateway CLI
- App needs restart after gateway restart
- Check: `defaults read /Applications/OpenClaw.app/Contents/Info.plist CFBundleShortVersionString`

### WhatsApp/Telegram issues
- groupPolicy "allowlist" with empty allowFrom → messages silently dropped
- Channel not configured → run setup command from doctor output
