# OpenClaw Config Schema

## File Location
`~/.openclaw/openclaw.json` (JSON5 format - supports comments and trailing commas)

## Key Top-Level Fields

### gateway
```json5
{
  "gateway": {
    "mode": "local",       // "local" | "remote" - REQUIRED for local gateway
    "port": 18789,          // default 18789
    "bind": "loopback",     // "loopback" | "lan" | "tailnet" | "auto" | "custom"
    "auth": {
      "mode": "token",      // "token" | "password" | "none"
      "token": "..."        // required for non-loopback bind
    }
  }
}
```

**CRITICAL**: `gateway.mode` must be set to `"local"` for local gateway operation.
Without it, gateway refuses to start (unless --allow-unconfigured flag used).

### agents
```json5
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "model": {
        "primary": "anthropic/claude-sonnet-4-5",
        "fallbacks": ["openai/gpt-4.1"]
      },
      "models": {
        "anthropic/claude-opus-4-6": { "alias": "Opus" }
      }
    }
  }
}
```

### channels
```json5
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "...",
      "dmPolicy": "pairing"  // "pairing" | "allowlist" | "open" | "disabled"
    },
    "discord": {
      "enabled": true,
      "botToken": "..."
    },
    "whatsapp": {
      "dmPolicy": "pairing"
    }
  }
}
```

### logging
```json5
{
  "logging": {
    "level": "info",              // trace|debug|info|warn|error
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",     // pretty|compact|json
    "redactSensitive": "tools"
  }
}
```

### providers (AI model providers)
```json5
{
  "models": {
    "providers": {
      "openrouter": {
        "apiKey": "sk-or-...",
        "baseUrl": "https://openrouter.ai/api/v1"
      },
      "anthropic": {
        "apiKey": "sk-ant-..."
      },
      "openai": {
        "apiKey": "sk-..."
      }
    }
  }
}
```

## Finding the OpenRouter API Key
Look in `~/.openclaw/openclaw.json` under:
- `models.providers.openrouter.apiKey`
- `models.providers["openrouter"].apiKey`

## Common Config Mistakes
1. Missing `gateway.mode: "local"` → gateway won't start
2. Non-loopback bind without auth token → security guardrail blocks start
3. Legacy config keys → doctor migration needed
4. Invalid JSON5 → gateway won't start, doctor shows exact issues
5. Unknown fields → strict validation rejects config

## Config Validation
- Strict schema validation on start
- Run `openclaw doctor` for exact validation errors
- Run `openclaw doctor --fix` or `--yes` for auto-repair
- Config hot-reloads automatically when file changes

## LaunchAgent Plist (macOS)
Location: `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
- Contains the node path and environment variables
- If node path uses nvm/fnm/volta/asdf → can break after upgrades
- Should use system Node (Homebrew: `/opt/homebrew/bin/node`)
- Check for proxy environment variables that might interfere
