# Task: ClawAid UI + Observe Rewrite

You are upgrading ClawAid's diagnostic UI and backend. Three goals:

## Goal 1: observe.ts — Parallel Commands + Cleanup

Current problem: 15+ commands run sequentially (~10s). Fix:

1. **Parallel execution**: Group independent commands into Promise.all batches:
   - Batch 1 (can all run in parallel): openclaw status, openclaw gateway status --json, openclaw doctor, openclaw devices list, lsof port check, ps aux process check, node -v, npm -v, openclaw --version, sw_vers, desktop app checks
   - Batch 2 (after batch 1): npm view openclaw version (only if needed)
   - File reads (config, plist, logs, sessions) can also run in parallel with batch 1
   
2. **Remove duplicates**:
   - Remove `openclaw gateway status` (text version) — only keep `openclaw gateway status --json`
   - Remove `gatewayStatus` field from ObservationResult interface and from formatObservation output
   - The gatewayStatusJson field is sufficient

3. **Structured progress**: Instead of just emitting string progress messages, emit structured events so the UI can show a checklist. The onProgress callback should support structured objects:

   ```typescript
   type ProgressEvent = string | { id: string; label: string; status: 'pending' | 'done' | 'error'; detail?: string };
   ```
   
   The observe function should emit these structured events:
   - { id: 'status', label: 'OpenClaw status' }
   - { id: 'gateway', label: 'Gateway health' }  
   - { id: 'doctor', label: 'Doctor check' }
   - { id: 'config', label: 'Config & launch agent' }
   - { id: 'logs', label: 'System logs' }
   - { id: 'devices', label: 'Device pairing' }
   - { id: 'versions', label: 'Version check' }
   - { id: 'sessions', label: 'Session integrity' }
   - { id: 'rules', label: 'Rule engine' }
   
   Emit with status:'pending' before starting each group, then status:'done' when complete.

## Goal 2: loop.ts — Structured Progress Events

Update the DoctorLoop to forward structured progress from observe, AND add its own structured events for the AI phase.

When the loop emits 'progress' events, support both formats:
- `{ type: 'progress', data: { message: 'string...' } }` — legacy string
- `{ type: 'progress', data: { id: string, label: string, status: string, detail?: string } }` — structured

For the AI analysis phase, emit structured progress like:
- `{ id: 'ai-analyze', label: 'AI analyzing system data', status: 'pending' }` when calling the API
- Then `{ id: 'ai-analyze', ..., status: 'done' }` when response arrives

## Goal 3: web/index.html — Beautiful Real-Time Progress UI

This is the MOST IMPORTANT part. The current UI shows fake animation steps while the real work happens invisibly. Replace it with real-time structured progress.

### Design Requirements:
- **Apple/Gemini/ChatGPT quality** — clean, minimal, smooth animations
- **Show REAL progress** — each observe check appears as a checklist item with check/spinner
- **Two phases clearly separated**:

**Phase 1: System Scan** (during observe)
- Card with header "Scanning your system..." / "正在扫描你的系统..."
- Each check item appears as it starts (with spinning indicator)
- When done, spinner changes to green checkmark
- Items match the structured progress IDs from observe.ts
- Show elapsed time in the header subtitle (e.g. "3.2s")
- When all checks done, header changes to "System scanned ✓" with total time

**Phase 2: AI Analysis** (during AI step loop)
- New card appears below scan card
- Header: "AI analyzing..." with a subtle pulsing brain emoji
- Shows current status text from loop
- When AI step results come back, they appear in the existing step_start/step_done flow (which already works)
- Remove the fake `ai-thinking-card` that shows pre-scripted steps

### Checklist Item Design:
```
[spinner] Checking gateway health...        (pending - accent color)
   ✓     Gateway health              0.8s   (done - green, muted time)
   ✗     Device pairing              1.2s   (error - red)
```

- Each item is a flex row: icon (20px) + label (flex:1) + time (right-aligned, muted)
- Pending: small spinner (reuse .spin-sm class) + accent colored label
- Done: green checkmark + normal colored label + elapsed time in muted text
- Error: red X + red label
- Items appear with a subtle fade-in animation
- Compact vertical spacing (28-32px per item)

### CSS Requirements:
- Keep ALL existing CSS variables, dark mode support, animations
- Add new classes for the structured scan UI
- Reuse existing `.spin-sm` for pending spinners
- Reuse existing color tokens (--green, --accent, --text-muted)

### CRITICAL: Remove fake AI thinking card
Delete the `ai-thinking-card` creation logic in the `updateScanProgress()` function (the part that creates fake animated steps like "Reading config files & logs", "Checking gateway status", etc). We're replacing this with REAL data.

### Keep everything else intact:
- Start screen, description input, paywall, result pages, feedback gate, confetti — all stay exactly the same
- Keep all i18n (isZh translations) — add i18n for new checklist labels
- Keep all event tracking (ev() calls)
- Keep all SSE reconnect logic
- The existing step_start/step_done handling for READ and FIX steps stays the same

### JavaScript Implementation:
- In the `onEvent` function, handle 'progress' events by checking if `data.id` exists (structured) vs just `data.message` (legacy string)
- For structured events: create/update checklist items in a Map keyed by id
- Use a container div inside the scan card for the checklist
- Start a timer (setInterval 100ms) during scan phase, stop when scan completes
- Timer display: "2.1s" format, shown in scan card header

After making changes, run: `npx tsc` to verify compilation succeeds.
