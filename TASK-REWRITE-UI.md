# Task: Rewrite web/index.html

Rewrite web/index.html completely. This is the web UI for ClawAid, a diagnostic & repair tool for OpenClaw.

## Design Philosophy (from user testing feedback)
This must look like a **production-level product** from a top AI company, not a developer tool.
Reference: Linear, Vercel Dashboard, Stripe Checkout, Google Health checks.
Every pixel matters. No ugly developer-style debug output.
Key principles:
- **Whitespace is a feature** — generous padding, clear hierarchy
- **One action per screen** — don't overwhelm with choices
- **Immediate feedback** — every click must produce visible response
- **Cards, not blocks** — subtle shadows, rounded corners, clear separation
- **Color communicates** — green=good, amber=attention, red=problem, blue=info. Use sparingly.

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
- Green heart, title "一切正常！ / All clear!"
- NO description paragraph (the long "RPC探测通过，无认证错误…" is redundant — delete it)
- Just the green heart + title + scan again button. Clean and confident.
- Scan again button

**Healthy + warnings → suggestions**
- Green heart + title (same as above)
- NO redundant description paragraph
- Below: suggestions card with structured warnings
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

### Structured Warnings (REDESIGN — critical feedback)
Each warning from AI is: {text, recommendation: 'ignore'|'fix'|'review', fixCommand?, reason}

**Current problems (user feedback):**
- Warnings look ugly and unstructured, not production-level
- When AI says "fix this" but doesn't know user intent (e.g. WhatsApp groupPolicy), user has no way to choose
- "建议修复" badge + copy command is confusing UX

**New design — clean card-based warnings:**
Each warning is a standalone card with:
- Left icon (contextual: 🔧 fix / 💡 info / 👀 review)
- Title line (the warning text, bold, 14px)
- Subtitle (the reason, 12px muted, only if provided)
- Right side: action area

**Actions by recommendation type:**
- `ignore` → Small muted "可忽略 / Ignorable" label + dismiss ✕ button. Entire card is light gray bg.
- `review` → Blue card border-left. Show the warning text clearly. If fixCommand exists, show it in a code block with copy button. NO "建议修复" badge. The card explains the situation, user decides.
- `fix` → Amber/yellow card border-left. Show "一键修复 / Quick fix" button that copies command + shows toast. If multiple commands possible, show them as options.

**Card visual style:**
- NO yellow background flooding — use white bg with colored LEFT BORDER (4px) to indicate type
- Subtle shadow like other cards
- 12px rounded corners
- Proper spacing (16px padding)
- Each card clearly separated (8px gap)

**Actions array (for review warnings):**
Some warnings have an `actions` array instead of `fixCommand`:
```json
{
  "text": "WhatsApp groups silently dropped",
  "recommendation": "review",
  "actions": [
    {"label": "Enable group messages", "command": "openclaw config set channels.whatsapp.groupPolicy open"},
    {"label": "Keep disabled (do nothing)", "command": null}
  ],
  "reason": "groupPolicy is allowlist but allowFrom is empty"
}
```
Render these as **choice buttons** inside the warning card:
- Each action with a non-null command → button that copies the command + shows toast
- Each action with null command → button that just dismisses the card
- Buttons should be pill-shaped, side by side, with the action label as text
- This lets the user CHOOSE what to do instead of us assuming

**Backward compatibility for warnings:**
- warnings may be array of strings (old format) OR array of structured objects
- If item is string → treat as {text: item, recommendation: 'review'}
- If structured but no actions array → use fixCommand if present
- If structured with actions array → render action buttons

**Section title:** Use a clean divider + label, not the current "⚠️ 其他需要注意的" loud style. Something like:
- Fixed result: "其他发现 / Other findings" (subtle, since main issue is resolved)
- Healthy result: "建议 / Suggestions" (these are the main content when healthy)

### Paywall Page
- Emoji heading + 'Free scans used up'
- Price display (from event data)
- 'X fixes, only charged on success' subtext
- Primary buy button → https://buy.stripe.com/8x26oJ6WrdNnd9T4hI0oM01
- Divider
- Token/email redemption: input + activate button
- Support contact (WeChat: oliver56666)

### Feedback UI (MUST FIX)
When user clicks 👍 or 👎, the feedback area MUST:
1. Immediately replace the buttons with a clear visual confirmation
2. Use smooth fade/slide animation (not instant swap)
3. Show big emoji (🎉 for yes, 🙏 for no) + clear text
4. The replacement should be visually obvious — user must KNOW their click registered
5. Disable double-clicking (prevent multiple submissions)

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
