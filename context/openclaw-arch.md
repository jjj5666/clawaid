# OpenClaw Architecture

## Overview
OpenClaw is an AI gateway/assistant platform that runs a local WebSocket server (the "Gateway") that connects to messaging channels (WhatsApp, Telegram, Discord, etc.) and provides AI assistant capabilities.

## Key Components

### Gateway
- The core WebSocket server process
- Default port: **18789**
- Config file: `~/.openclaw/openclaw.json` (JSON5 format)
- State directory: `~/.openclaw/`
- Runs as a launchd service on macOS: `ai.openclaw.gateway`
- LaunchAgent plist: `~/Library/LaunchAgents/ai.openclaw.gateway.plist`

### Control UI
- Web dashboard at `http://127.0.0.1:18789`
- Shows logs, config, channels, sessions

### Channels
- WhatsApp (via Baileys Web library)
- Telegram
- Discord
- iMessage
- Slack
- Signal
- Google Chat
- etc.

## State Directory Structure
```
~/.openclaw/
├── openclaw.json          # Main config (JSON5)
├── credentials/           # Auth credentials
│   ├── whatsapp/         # WhatsApp session data
│   └── oauth.json        # OAuth tokens
├── agents/               # Agent data
│   └── <agentId>/
│       ├── sessions/     # Session store
│       └── agent/        # Agent workspace (links to workspace dir)
├── workspace/            # Default agent workspace
└── logs/ (see logging)
```

## Log Files
- Default location: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- Format: JSONL (one JSON object per line)
- Can be overridden in config: `logging.file`
- Tail via CLI: `openclaw logs --follow`

## Gateway Service (macOS)
- Managed by launchd
- Label: `ai.openclaw.gateway`
- Start: `openclaw gateway start`
- Stop: `openclaw gateway stop`
- Restart: `openclaw gateway restart`
- Install: `openclaw gateway install`
- Status: `openclaw gateway status`

## Common Issues
1. Gateway not running → `openclaw gateway start`
2. Port 18789 in use → another process using same port
3. Config validation error → `openclaw doctor` to diagnose
4. Stale launchd service → `openclaw gateway install --force`
5. Wrong Node path in plist → version manager path broke after upgrade
6. Config schema mismatch → legacy keys need migration via `openclaw doctor`
