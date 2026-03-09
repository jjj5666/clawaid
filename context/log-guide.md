# OpenClaw Log Guide

## Log File Location
- Default: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- Date uses gateway host's local timezone
- Format: JSONL (one JSON object per line)
- Can be overridden: `~/.openclaw/openclaw.json` → `logging.file`

## Finding Logs
```bash
# Most recent log file
ls -lt /tmp/openclaw/ | head -5

# Check config for custom log path
cat ~/.openclaw/openclaw.json | grep -A3 '"logging"'

# Live tail via CLI
openclaw logs --follow

# Check for any openclaw log directories
find /tmp -name "openclaw*.log" 2>/dev/null
find ~/.openclaw -name "*.log" 2>/dev/null
```

## Log Format
Each line is a JSON object:
```json
{
  "time": "2024-01-15T10:30:00.000Z",
  "level": "info",
  "subsystem": "gateway/channels/telegram",
  "message": "webhook processed",
  "data": {}
}
```

## Log Levels
- `trace` - very verbose, internal
- `debug` - debugging info
- `info` - normal operations
- `warn` - warnings, non-fatal issues
- `error` - errors that need attention

## Key Subsystem Prefixes
- `gateway` - core gateway
- `gateway/channels/whatsapp` - WhatsApp channel
- `gateway/channels/telegram` - Telegram channel
- `gateway/channels/discord` - Discord channel
- `gateway/sessions` - session management
- `gateway/model` - AI model calls
- `gateway/tools` - tool execution
- `gateway/cron` - scheduled jobs

## Important Log Signatures

### Config errors
```
"Gateway start blocked: set gateway.mode=local"
"refusing to bind gateway ... without auth"
"Config validation failed"
```

### Service issues
```
"another gateway instance is already listening"
"EADDRINUSE"
"Runtime: stopped"
```

### Auth issues
```
"unauthorized"
"device identity required"
"device nonce required"
"gateway connect failed:"
```

### Channel issues
```
"drop guild message (mention required"
"pairing request"
"blocked"
"allowlist"
"missing_scope"
"Forbidden"
"401/403"
```

### Model issues
```
"HTTP 429: rate_limit_error"
"Extra usage is required for long context"
"model auth failed"
```

## Reading Logs for Diagnosis
1. Get the most recent log file path
2. Read the last 200-500 lines for recent errors
3. Look for `"level":"error"` or `"level":"warn"` entries
4. Check subsystem prefix for which component failed
5. Cross-reference with `openclaw gateway status` output
