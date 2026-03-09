# OpenClaw Doctor - Build Instructions

Read ARCHITECTURE.md first. It is the complete spec.

## What to Build

A diagnostic and repair tool for OpenClaw. When users run `npx openclaw-doctor`, it:
1. Starts a local web server on a free port
2. Opens the browser to a clean, Google-style UI
3. Automatically gathers system info (read-only checks)
4. Calls OpenRouter API (Claude Opus) to diagnose issues
5. Shows the diagnosis in plain language
6. One-click fix button
7. Executes repairs with real-time progress via SSE
8. Verifies the fix worked
9. If not fixed after 3 rounds, AI meta-thinks and tries a new direction
10. After 3 meta-think cycles (9 rounds), asks the user

## Tech Stack
- **Runtime:** Node.js (TypeScript, compiled to JS)
- **Server:** Express + SSE for real-time updates
- **Frontend:** Single HTML page, inline CSS, inline JS (no build step for frontend)
- **AI:** Direct HTTP to OpenRouter API (do NOT use openclaw gateway - it might be broken)
- **Package:** npm package, runnable via `npx openclaw-doctor`

## Key Design Decisions

### AI API Access
1. First, try to read OpenRouter API key from openclaw config: `~/.openclaw/openclaw.json` look for providers with OpenRouter
2. If not found, show a clean input box in the web UI asking for OpenRouter API key
3. Input box must show "🔒 Local only. Not stored. Not sent anywhere except OpenRouter." 
4. The model to use: `anthropic/claude-opus-4.6` via OpenRouter

### Observe Module
Run these read-only commands and collect output:
- `openclaw status` 
- `openclaw gateway status`
- `openclaw config get` (or read ~/.openclaw/openclaw.json)
- `lsof -i :18789` (gateway port)
- `ps aux | grep -i openclaw` (process list)
- Check for LaunchAgent plist: `~/Library/LaunchAgents/ai.openclaw.gateway.plist` - read it for proxy env vars
- Read the most recent/largest log file in `~/.openclaw/logs/`
- `node -v`, `npm -v`
- `uname -a`
- `cat /etc/os-release 2>/dev/null || sw_vers`

### Diagnose Module  
Send ALL observed data to Claude Opus with this system prompt:

```
You are a top-tier OpenClaw diagnostics engineer. You think like a scientist: observe, hypothesize, test, refine.

Given the system data below, follow this exact chain of thought:
1. What anomalies do you see? (List facts only)
2. What root cause do these point to? (Not symptoms - the actual root cause)
3. Could you be wrong? What other possibilities exist?
4. What is the minimal fix? 
5. What are the risks of this fix? Could it break anything else?
6. Can it be done with official CLI commands? Or must files be edited?

Output a JSON response:
{
  "diagnosis": "plain language description of what's wrong",
  "confidence": 0.0-1.0,
  "rootCause": "technical root cause",
  "actions": [
    {
      "description": "what this step does in plain language",
      "command": "the actual command to run",
      "type": "cli|system|file_edit",
      "risk": "low|medium|high",
      "backup": "backup command if type is file_edit, null otherwise"
    }
  ],
  "alternativeHypotheses": ["other possible causes to investigate if this doesn't work"]
}
```

### Execute Module
- Run actions sequentially
- Send SSE events for each step: starting, completed, failed
- For file edits: auto-backup first, then edit
- After all actions: run verify

### Verify Module
- Re-run observe checks
- Send to AI: "Here was the original problem, here's what we did, here's the new state. Is it fixed?"
- AI responds with: fixed/not_fixed + explanation

### Loop Controller
- 3 rounds per direction
- After 3 fails: meta-think (send ALL history to AI: "Your approach isn't working. Given everything you've seen, what's the real problem?")
- After 3 meta-thinks: show user "This is complex. Here's what I found:" + copy-to-clipboard diagnostic report

### Web UI Design
- White background, clean sans-serif font (Inter or system font)
- Centered content, max-width 600px
- Status indicators: spinning dots for loading, green checks, red X, orange warning
- Smooth transitions between states
- The whole page is ONE continuous flow - diagnosis flows into fix flows into result
- Real-time text appears word-by-word or line-by-line (like a chat)
- "Buy me a coffee" button at the end if fixed (link to buymeacoffee.com - use placeholder URL for now)

### Package.json
- name: "openclaw-doctor"
- bin: { "openclaw-doctor": "./dist/index.js" }  
- Make it work with `npx openclaw-doctor`

## Important
- All context/ .md files should contain real OpenClaw knowledge to help AI diagnose
- Read the actual OpenClaw docs if needed: /opt/homebrew/lib/node_modules/openclaw/docs/
- The tool must work even when openclaw gateway is completely broken
- TypeScript with strict mode
- Keep it simple. This is an MVP.
