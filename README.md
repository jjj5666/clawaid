# 🦞🩹 ClawAid — Fix OpenClaw in One Command

**OpenClaw broken? Gateway crashed? Config corrupted? AI not responding?**

ClawAid is an AI-powered diagnostic and repair tool for [OpenClaw](https://github.com/openclaw/openclaw). It auto-detects what's wrong and fixes it — no manual debugging needed.

## Quick Start

```bash
npx clawaid
```

That's it. Opens a web UI in your browser. No config, no API key, no account needed.

## What It Fixes

| Problem | ClawAid handles it |
|---|---|
| **Gateway not starting** / crashed / not running | ✅ Auto-fix |
| **Config file errors** — invalid JSON, unknown fields | ✅ Auto-fix |
| **Wrong model ID** causing HTTP 400 | ✅ Auto-fix |
| **Network / proxy issues** — AI keeps spinning | ✅ Auto-fix |
| **Port conflicts** — another process on 18789 | ✅ Auto-fix |
| **Stale LaunchAgent** after OpenClaw update | ✅ Auto-fix |
| **API key expired** or misconfigured | ✅ Auto-fix |
| **Broke after updating** OpenClaw | ✅ Auto-fix |
| **`openclaw: command not found`** — PATH issues | ✅ Auto-fix |
| **Telegram / Discord / WhatsApp** channel won't connect | ✅ Auto-fix |

**94% fix rate** across 19,000+ users in 15 countries.

## How It Works

1. **Scans** your OpenClaw installation — logs, config, processes, network (read-only, zero risk)
2. **AI analyzes** the real system state to find the root cause
3. **Shows** a clear diagnosis and repair plan
4. **Fixes** with one click — commands run locally on your machine
5. **Verifies** the fix worked — if not, retries with a different strategy (up to 9 attempts)

## Common Searches This Solves

- "openclaw not working"
- "openclaw gateway not starting"
- "openclaw gateway crash"
- "openclaw config error"
- "openclaw broken after update"
- "openclaw HTTP 400 / 401 / 429"
- "openclaw command not found"
- "openclaw 启动失败" / "openclaw 坏了" / "openclaw 配置错误"
- "how to fix openclaw" / "openclaw troubleshooting"
- "openclaw repair" / "openclaw debug"
- "openclaw proxy error" / "openclaw network issue"
- "openclaw telegram not connecting"

## Troubleshooting Guides

Detailed step-by-step guides for manual fixes:

- [OpenClaw Not Working — Complete Guide](https://clawaid.app/fix/openclaw-not-working)
- [Fix: Gateway Not Starting](https://clawaid.app/fix/gateway-not-starting)
- [Fix: Config Errors](https://clawaid.app/fix/config-errors)

## Privacy & Security

- API keys are **automatically redacted** before any data leaves your machine
- Diagnostic data is sent to our analysis service for the current session only — **nothing stored permanently**
- All repair commands run **locally on your machine**
- **Open source** — verify everything

## Requirements

- Node.js 18+
- macOS (Intel or Apple Silicon), Linux, or Windows

## Links

- **Website:** [clawaid.app](https://clawaid.app)
- **GitHub:** [github.com/jjj5666/clawaid](https://github.com/jjj5666/clawaid)
- **OpenClaw:** [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)
- **OpenClaw Discord:** [discord.com/invite/clawd](https://discord.com/invite/clawd)

## License

MIT
