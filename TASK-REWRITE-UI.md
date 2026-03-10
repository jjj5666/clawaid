# Task: Rewrite web/index.html

Rewrite web/index.html completely. This is the web UI for ClawAid, a diagnostic & repair tool for OpenClaw.

## Architecture
The frontend communicates with a local server via:
- SSE: GET /api/diagnose?lang=zh|en (diagnostic event stream)
- REST: POST /api/input {sessionId, field, value, screenshot?}
- REST: POST /api/confirm {sessionId, confirmed: bool}
- REST: POST /api/redeem {token: string} → {valid, credits, token?}
- REST: POST /api/feedback {feedback: 'yes'|'no', sessionId, sbSessionId}

## SSE Events (from server)
- session_start: {sessionId}
- state_change: {state} — states: idle, waiting_user_description, observing, running, waiting, fixed, not_fixed, healthy, paywall, error
- progress: {message} — status text during scanning
- step_start: {step, index} — step has: type(read|fix|done), command?, description, risk?, thinking?, fixed?, summary?, problem?, fix?, warnings?
- step_done: {step, output, skipped?, index}
- confirm_needed: {step} — user must approve a fix
- complete: {fixed, healthy?, summary, problem?, fix?, warnings, sbSessionId, history}
- paywall: {price?, isChinese?, credits?}
- request_input: {field, instructions, allowSkip?, allowScreenshot?} — field is 'userDescription'
- error: {message}

## Design Requirements

### Language
- Detect browser language: /^zh/ → Chinese UI + pass ?lang=zh to SSE
- ALL UI text must be i18n (Chinese / English)
- AI returns content already in the user's language (summary, warnings, descriptions)

### Flow
1. Start screen → 'Start Scan' button
2. Problem description (optional textarea + screenshot upload/paste + skip button)
3. Scanning phase → ONE card with animated progress lines, NOT individual cards per READ step
4. Fix steps → individual cards that need user confirmation (Allow / Skip)
5. Result page → one of 4 variants (see below)
6. Feedback + scan again

### Scanning Phase (IMPORTANT)
- All READ steps are collapsed into a single 'Diagnosing...' card
- Show animated progress: checkmarks for completed checks, spinner for current
- Expandable 'View details' toggle to see individual read commands
- Only FIX steps get their own card

### Result Pages (5 variants)

**Fixed → celebration 🎉**
- CSS confetti/fireworks animation (pure CSS, no library) — impressive but tasteful, multiple colored pieces falling from top
- Big checkmark ✅
- 'problem' field → one SHORT line: what was wrong
- 'fix' field → one SHORT line: what was fixed
- If warnings exist, show them below (structured, see below)
- Feedback buttons
- Scan again

**Healthy + 0 warnings → clean 💚**
- Green heart, one line summary
- Scan again button

**Healthy + warnings → suggestions**
- Green status but with suggestions card below
- 'System is running normally. A few suggestions:'
- Structured warnings list
- Feedback + scan again

**Degraded → yellow warning ⚠️**
- Yellow/amber card — NOT red (system runs, but has issues)
- Icon: ⚠️
- Title: 'System is running but has issues' / '系统在运行但存在问题'
- 'problem' field shown (what's degraded — e.g. "API key invalid, model requests failing")
- Structured warnings shown prominently (these ARE the issues)
- Contact info
- Feedback + scan again
- This is for: gateway alive but provider auth failing, model not found, timeout loops, Node too old, fallback chain broken

**Not fixed → help 😔**
- 'problem' field shown
- Contact info (WeChat: oliver56666, GitHub Issues)
- Try again button

The `complete` SSE event data has these fields:
- fixed: boolean
- healthy: boolean (only true if genuinely healthy)
- degraded: boolean (system runs but has functional issues)
- summary: string
- problem: string|null (short, <80 chars)
- fix: string|null (short, <80 chars)
- warnings: array (structured or string, handle both)
- sbSessionId: string|null

Logic for choosing which page:
1. data.fixed → celebration
2. data.degraded → yellow warning
3. data.healthy && warnings.length === 0 → clean green
4. data.healthy && warnings.length > 0 → green with suggestions
5. else → not fixed

### Structured Warnings
Each warning from AI is: {text, recommendation: 'ignore'|'fix'|'review', fixCommand?, reason}
- recommendation=ignore → gray, show reason, dismissible
- recommendation=fix → yellow, show 'One-click fix' button. When clicked, copy fixCommand to clipboard and show toast 'Copied! Paste in terminal.'
- recommendation=review → blue, show details for user to decide

### Paywall Page
- Emoji heading + 'Free scans used up'
- Price display (from event data)
- 'X fixes, only charged on success' subtext
- Primary buy button → https://buy.stripe.com/8x26oJ6WrdNnd9T4hI0oM01
- Divider
- Token/email redemption: input + activate button
- Support contact (WeChat: oliver56666)

### Visual Design
- Clean, minimal, Apple-inspired
- Light/dark mode via prefers-color-scheme
- Max width 540px, centered
- Card-based layout with subtle shadows
- Smooth animations (fadeIn, slideUp)
- Color scheme: blue primary, green success, yellow warning, red error
- Font: system font stack
- The confetti animation for 'fixed' should be impressive but tasteful — use multiple small colored confetti pieces falling from top

### Analytics (keep existing)
- Mixpanel: init with 'fb6af7e76538dfda2675ab13beaf2727', track_pageview:'full-url'
- Track events: scan_start, user_input, diagnosis_step, fix_confirm, fix_skip, scan_complete, paywall_hit, token_redeem_attempt/success/fail, feedback, warning_fix_copy
- Clarity: project id 'vt5wimnmsf'

### Anti-garbling (IMPORTANT — real user issue)
Chinese users with browser translation extensions/AI toolbars (Edge AI, 360, Sogou) get garbled text.
Defenses:
- Add `translate="no"` attribute to: version numbers, port numbers, command text, technical output, code blocks
- Wrap ALL numbers/versions/ports in `<code>` or `<span translate="no">` — translation extensions skip these
- Font stack MUST include Chinese fonts: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', sans-serif`
- Add `<meta name="google" content="notranslate">` to head
- Add `class="notranslate"` to the root wrapper div
- SSE charset: server already sends `text/event-stream` but ensure all text content is UTF-8 safe

### Tech constraints
- Single HTML file, no build tools, no external dependencies (except Mixpanel/Clarity CDN)
- Pure CSS animations (no JS animation libraries)
- ES6+ JavaScript in an IIFE
- Must handle SSE reconnection gracefully
- Mobile responsive

### BACKWARD COMPATIBILITY
- warnings may be array of strings (old format) OR array of {text, recommendation, fixCommand?, reason} objects (new format)
- Handle both: if item is string, treat as {text: item, recommendation: 'review'}
- problem/fix fields may be null (old format sends only summary)
- If problem is null, show summary instead

Keep the file well-organized with clear sections: CSS variables → base styles → component styles → dark mode → animations → HTML → JavaScript.
