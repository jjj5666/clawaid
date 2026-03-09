# 🦞🩹 ClawAid

AI-powered diagnostic and repair tool for [OpenClaw](https://github.com/openclaw/openclaw).

## Usage

```bash
npx clawaid
```

Opens a clean web UI in your browser. No config, no API key needed — just run it.

## What it does

1. **Scans** your OpenClaw installation (read-only, zero risk)
2. **Analyzes** with AI to find what's wrong
3. **Shows** the diagnosis + repair plan clearly
4. **Fixes** with one click, in real-time
5. **Verifies** the fix worked
6. If not fixed: retries with a different strategy (up to 9 attempts)

## What it diagnoses

- Gateway not running or crashed
- Port conflicts
- Config file errors (invalid JSON, unknown fields)
- Proxy environment variables blocking connections
- Wrong model IDs causing HTTP 400
- Stale LaunchAgent needing reinstall
- And more — AI reasons from real system state

## Privacy

- Your OpenClaw config is **partially redacted** before analysis
- Data sent only to our diagnostic service for analysis, **nothing stored**
- All fixes run **locally on your machine**
- Open source — verify everything

## License

MIT
