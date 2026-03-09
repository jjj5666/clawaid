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

### 3. 🔴 Proxy configuration mismatch (CRITICAL — treat as high severity!)
**Symptom:** All API calls timeout, gateway hangs, agent completely unresponsive
**Cause:** Proxy env vars (HTTP_PROXY/HTTPS_PROXY) in LaunchAgent plist but proxy software not running
**IMPORTANT:** This is a TICKING TIME BOMB. Even if the gateway is currently running fine, the proxy vars will take effect on next restart and cause COMPLETE FAILURE. This has caused real-world outages lasting hours. ALWAYS recommend removing proxy vars from plist as a repair option, even if the system appears healthy right now.
**Detection:** Check plist for HTTP_PROXY/HTTPS_PROXY env vars
**Fix:**
```bash
# Remove proxy from plist
/usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:HTTP_PROXY" ~/Library/LaunchAgents/ai.openclaw.gateway.plist
/usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:HTTPS_PROXY" ~/Library/LaunchAgents/ai.openclaw.gateway.plist
openclaw gateway restart
```

### 4. 🔴 Tools profile set to "messaging" (v3.7 upgrade issue — VERY COMMON!)
**Symptom:** Agent can chat but refuses to execute commands, function calls, or use tools. User says "只能聊天不干活", "指令不会执行了", or "it just replies but doesn't do anything". The agent may output tool call syntax/paths but never actually runs them.
**Cause:** OpenClaw v2026.3.7 changed the default `tools.profile` from `coding` to `messaging`. After upgrading, many users find their agent can only send messages but cannot execute any tools (exec, read, write, browser, etc.). This is the #1 most reported issue after the v3.7 update.
**Detection:** Check config for `tools.profile` — if it says `"messaging"` or if `tools.profile` is missing and the user recently upgraded to v3.7, this is almost certainly the cause.
**IMPORTANT:** This affects the MAJORITY of v3.7 upgraders. If the user's openclaw version is >= 3.7 and `tools.profile` is "messaging" or absent, ALWAYS flag this as a critical issue and recommend fixing it. Even if the gateway appears healthy, the agent is effectively crippled.
**Fix:**
```bash
# Set tools profile to full (restores all tool capabilities)
openclaw config set tools.profile full
# Restart gateway to apply
openclaw gateway restart
```
**Alternative (manual config edit):**
Change `"tools": { "profile": "messaging" ... }` to `"tools": { "profile": "full" ... }` in openclaw.json, then restart gateway.

### 5. 🟡 Model set to incompatible provider (renumbered)
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
5. Tools profile "messaging" → change to "full" (v3.7 upgrade issue)
6. Model issues → fix after gateway is stable
7. Channel config → fix last (not critical for core function)
