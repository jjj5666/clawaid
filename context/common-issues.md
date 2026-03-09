# Common OpenClaw Issues (from user reports)

## Top Issues by Frequency

### 1. 🔴 Config file corrupted by AI (most common)
**Symptom:** Agent stops responding, gateway errors, HTTP 400/500
**Cause:** AI agent edited openclaw.json directly, introducing syntax errors or invalid values
**Detection:** 
- `openclaw config validate` returns errors
- JSON5 parse error in logs
- Gateway status shows config-related errors
**Fix:** 
- Restore from backup: `cp ~/.openclaw/openclaw.json.bak ~/.openclaw/openclaw.json`
- Then: `openclaw gateway restart`
- If no backup: `openclaw config validate` to find the error, manually fix

### 2. 🔴 Gateway won't start / port conflict
**Symptom:** "EADDRINUSE", "port 18789 already in use"
**Detection:** `lsof -i :18789` shows another process
**Fix:** 
- `openclaw gateway run --force` (kills existing, starts new)
- Or: `kill <pid>` then `openclaw gateway start`

### 3. 🟡 Proxy configuration mismatch
**Symptom:** All API calls timeout, gateway hangs
**Cause:** Proxy env vars in LaunchAgent plist but proxy not running
**Detection:** Check plist for HTTP_PROXY/HTTPS_PROXY env vars
**Fix:**
```bash
# Remove proxy from plist
/usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:HTTP_PROXY" ~/Library/LaunchAgents/ai.openclaw.gateway.plist
/usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:HTTPS_PROXY" ~/Library/LaunchAgents/ai.openclaw.gateway.plist
openclaw gateway restart
```

### 4. 🟡 Model set to incompatible provider
**Symptom:** HTTP 400 errors, agent doesn't respond
**Cause:** Primary model set to a provider that doesn't support the tool schema
**Detection:** Error logs show "400 Bad Request" or schema validation errors
**Fix:** `openclaw models set default <working-model-name>`

### 5. 🟡 Stale gateway process (zombie)
**Symptom:** Gateway status says "running" but agent doesn't respond, RPC probe fails
**Detection:** 
- `openclaw gateway status` shows running but RPC probe fails
- Multiple openclaw-gateway processes in `ps aux`
**Fix:**
- `pkill -f "openclaw-gateway"` then `openclaw gateway start`
- Or: `openclaw gateway restart`

### 6. 🟢 WhatsApp/Telegram channel misconfiguration
**Symptom:** Messages not received or silently dropped
**Cause:** groupPolicy set to "allowlist" but no IDs in allowFrom
**Detection:** `openclaw doctor` shows warning about groupPolicy
**Fix:** 
- `openclaw config set channels.whatsapp.groupPolicy open` (to receive all)
- Or add specific IDs to groupAllowFrom

### 7. 🟢 Desktop app not connecting
**Symptom:** Menu bar icon dark/inactive
**Cause:** Version mismatch, app needs restart, or gateway URL changed
**Fix:** Restart app, or update to latest version

### 8. 🟢 Node.js version incompatible
**Symptom:** Various crashes, syntax errors in logs
**Detection:** `node -v` shows old version
**Fix:** Update Node.js to latest LTS

## Diagnostic Priority

When multiple issues are found, fix in this order:
1. Gateway not running → start it first
2. Config file broken → fix config before anything else  
3. Port conflicts → clear before restart
4. Proxy issues → remove before restart
5. Model issues → fix after gateway is stable
6. Channel config → fix last (not critical for core function)
