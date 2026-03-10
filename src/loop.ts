import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import { execSync } from 'child_process';
import { observe, loadMockObservation, formatObservation, ObservationResult } from './observe';
import { getMachineFingerprint, PaywallError } from './diagnose';

// ClawAid backend API URL
const CLAWAID_API = process.env.CLAWAID_API || 'https://api.clawaid.app';

// v3: No hardcoded reObserve. AI uses read steps to verify fixes itself.

// Package version for telemetry
const clawaidVersion: string = (() => {
  try { return (require('../package.json') as { version: string }).version; } catch { return 'unknown'; }
})();

// v3: Give AI room to iterate. Read steps are cheap, fix steps need confirmation.
const MAX_STEPS = 30;
const MAX_FIX_ATTEMPTS = 8;

export type LoopState =
  | 'idle'
  | 'waiting_user_description'  // waiting for user to describe their problem (or skip)
  | 'observing'
  | 'running'     // agentic loop in progress
  | 'waiting'     // waiting for user to confirm a medium/high risk step
  | 'fixed'
  | 'not_fixed'
  | 'healthy'
  | 'degraded'    // system runs but has functional issues (auth errors, model failures, timeouts)
  | 'paywall'
  | 'error';

export interface AgentStep {
  type: 'read' | 'fix' | 'done';
  command?: string;
  description: string;
  reason?: string;
  risk?: 'low' | 'medium' | 'high';
  // for done:
  fixed?: boolean;
  summary?: string;
  warnings?: string[];  // non-critical issues to display to the user
}

export interface StepRecord {
  step: AgentStep;
  output: string;
  skipped?: boolean;
  timestamp: number;
}

export interface LoopEvent {
  type:
    | 'state_change'
    | 'progress'
    | 'step_start'      // agent decided on a step, about to run
    | 'step_done'       // step finished with output
    | 'confirm_needed'  // medium/high risk step needs user approval
    | 'complete'
    | 'paywall'
    | 'request_input'
    | 'error';
  data: unknown;
}

export type EventCallback = (event: LoopEvent) => void;

export class DoctorLoop {
  private callback: EventCallback;
  private state: LoopState = 'idle';
  private stopped = false;
  private token?: string;
  private lang = 'en';
  private userDescription = '';
  private userScreenshot?: string; // base64 data URL
  private observation?: ObservationResult;
  private observationText = '';
  private history: StepRecord[] = [];
  private fixAttempts = 0;
  private pendingConfirm?: { step: AgentStep; resolve: (confirmed: boolean) => void };
  private pendingDescription?: { resolve: (value: { description: string; screenshot?: string }) => void };
  private sbSessionId?: string;

  constructor(callback: EventCallback) {
    this.callback = callback;
  }

  setToken(token: string) { this.token = token; }
  setLang(lang: string) { this.lang = lang || 'en'; }

  private sendEvent(event: string, data?: Record<string, unknown>): void {
    const fingerprint = getMachineFingerprint();
    const body = JSON.stringify({
      fingerprint,
      sessionId: this.sbSessionId,
      event,
      data: data || {},
      clientTs: new Date().toISOString(),
    });
    const url = new URL(`${CLAWAID_API}/event`);
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const lib = isLocal ? require('http') : require('https');
    const options = {
      hostname: url.hostname,
      port: parseInt(url.port) || (isLocal ? 3001 : 443),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = lib.request(options, () => {});
    req.on('error', () => {});
    req.write(body);
    req.end();
  }

  private async callComplete(token: string): Promise<void> {
    const url = new URL(`${CLAWAID_API}/complete`);
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const lib = isLocal ? require('http') : require('https');
    const body = JSON.stringify({ token });
    return new Promise((resolve) => {
      const req = lib.request({
        hostname: url.hostname,
        port: parseInt(url.port) || (isLocal ? 3001 : 443),
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, () => resolve());
      req.on('error', () => resolve());
      req.setTimeout(10000, () => { req.destroy(); resolve(); });
      req.write(body);
      req.end();
    });
  }
  stop() { this.stopped = true; }

  private emit(event: LoopEvent) { this.callback(event); }
  private setState(s: LoopState) { this.state = s; this.emit({ type: 'state_change', data: { state: s } }); }
  private progress(msg: string) { this.emit({ type: 'progress', data: { message: msg } }); }

  async start() {
    // Ask user to describe their problem (or skip)
    this.setState('waiting_user_description');
    this.emit({
      type: 'request_input',
      data: {
        field: 'userDescription',
        instructions: 'What\'s going on? Describe the problem in a few words, or upload a screenshot. You can also skip and let ClawAid figure it out.',
        allowSkip: true,
        allowScreenshot: true,
      }
    });
    const userInput = await new Promise<{ description: string; screenshot?: string }>((resolve) => {
      this.pendingDescription = { resolve };
    });
    this.userDescription = userInput.description || '';
    this.userScreenshot = userInput.screenshot;

    this.sendEvent('scan_start', {
      clawaid_version: clawaidVersion,
      platform: os.platform(),
      lang: this.lang,
      has_description: Boolean(this.userDescription),
      has_screenshot: Boolean(this.userScreenshot),
    });

    await this.runLoop();
  }

  async provideInput(field: string, value: string, extra?: { screenshot?: string }) {
    if (field === 'userDescription') {
      if (this.pendingDescription) {
        this.pendingDescription.resolve({ description: value, screenshot: extra?.screenshot });
        this.pendingDescription = undefined;
      }
    }
  }

  // Called when user confirms or rejects a medium/high risk step
  async confirmStep(confirmed: boolean) {
    if (this.pendingConfirm) {
      this.pendingConfirm.resolve(confirmed);
      this.pendingConfirm = undefined;
    }
  }

  // Called when user wants to skip current pending step
  async skipStep() {
    await this.confirmStep(false);
  }

  private async runLoop() {
    const loopStartTime = Date.now();
    let stepsCompleted = 0;

    // ── Phase 1: Observe ─────────────────────────────────────────────────────
    this.setState('observing');
    this.progress('🔍 Scanning your system...');

    const mockScenario = (global as Record<string, unknown>).__clawaid_mock as string | undefined;
    const obs = mockScenario
      ? loadMockObservation(mockScenario)
      : await observe((msg) => this.progress(msg));

    this.observation = obs;
    this.observationText = formatObservation(obs);
    this.progress('✓ Scan complete');

    // ── Phase 2: Agentic step loop ───────────────────────────────────────────
    // Always call AI — rule engine findings are hints, not gatekeepers.
    this.setState('running');

    for (let stepIndex = 0; stepIndex < MAX_STEPS; stepIndex++) {
      if (this.stopped) return;

      // Ask AI for next step
      let step: AgentStep;
      try {
        step = await this.callStep(stepIndex === 0);
      } catch (err) {
        if (err instanceof PaywallError) {
          this.setState('paywall');
          // v3: Include rule findings so paywall page can show what was found
          const findings = this.observation?.ruleFindings || [];
          this.emit({ type: 'paywall', data: { price: err.price, currency: err.currency, isChinese: err.isChinese, credits: err.credits, payMethod: err.payMethod, findings } });
          this.sendEvent('session_end', { reason: 'paywall', duration_ms: Date.now() - loopStartTime, steps_completed: stepsCompleted, outcome: 'paywall' });
          return;
        }
        const msg = (err as Error).message;
        if (msg.includes('paywall')) {
          this.setState('paywall');
          this.emit({ type: 'paywall', data: {} });
          this.sendEvent('session_end', { reason: 'paywall', duration_ms: Date.now() - loopStartTime, steps_completed: stepsCompleted, outcome: 'paywall' });
          return;
        }
        this.setState('error');
        this.emit({ type: 'error', data: { message: msg } });
        this.sendEvent('session_end', { reason: 'error', duration_ms: Date.now() - loopStartTime, steps_completed: stepsCompleted, outcome: 'error' });
        return;
      }

      // Done
      if (step.type === 'done') {
        this.emit({ type: 'step_start', data: { step, index: stepIndex } });
        const warnings = step.warnings || [];
        const problem = (step as any).problem || null;
        const fix = (step as any).fix || null;
        const degraded = (step as any).degraded || false;
        const baseData = { summary: step.summary, warnings, problem, fix, history: this.history, sbSessionId: this.sbSessionId };

        if (step.fixed) {
          this.setState('fixed');
          // Deduct 1 credit if using a paid token
          if (this.token) {
            this.callComplete(this.token).catch(() => {});
          }
          this.emit({ type: 'complete', data: { ...baseData, fixed: true } });
          this.sendEvent('session_end', { reason: 'done', duration_ms: Date.now() - loopStartTime, steps_completed: stepsCompleted, outcome: 'fixed' });
        } else if (degraded) {
          // System runs but has functional issues (auth errors, model failures, etc.)
          this.setState('degraded');
          this.emit({ type: 'complete', data: { ...baseData, fixed: false, degraded: true } });
          this.sendEvent('session_end', { reason: 'done', duration_ms: Date.now() - loopStartTime, steps_completed: stepsCompleted, outcome: 'degraded' });
        } else if (this.fixAttempts === 0 && !step.fixed) {
          // Healthy — no fixes were needed
          this.setState('healthy');
          this.emit({ type: 'complete', data: { ...baseData, fixed: false, healthy: true } });
          this.sendEvent('session_end', { reason: 'done', duration_ms: Date.now() - loopStartTime, steps_completed: stepsCompleted, outcome: 'healthy' });
        } else {
          this.setState('not_fixed');
          this.emit({ type: 'complete', data: { ...baseData, fixed: false } });
          this.sendEvent('session_end', { reason: 'done', duration_ms: Date.now() - loopStartTime, steps_completed: stepsCompleted, outcome: 'not_fixed' });
        }
        return;
      }

      // Announce step to UI
      this.emit({ type: 'step_start', data: { step, index: stepIndex } });

      // For fix steps: check risk level and maybe ask user
      if (step.type === 'fix') {
        this.fixAttempts++;
        if (this.fixAttempts > MAX_FIX_ATTEMPTS) {
          this.setState('not_fixed');
          this.emit({ type: 'complete', data: { fixed: false, summary: `Tried ${MAX_FIX_ATTEMPTS} fixes without success.`, history: this.history } });
          this.sendEvent('session_end', { reason: 'max_steps', duration_ms: Date.now() - loopStartTime, steps_completed: stepsCompleted, outcome: 'not_fixed' });
          return;
        }

        // ALL fix steps require user confirmation — never auto-execute
        this.setState('waiting');
        const confirmShownAt = Date.now();
        const confirmed = await this.waitForConfirm(step);
        const decisionTimeMs = Date.now() - confirmShownAt;
        this.setState('running');

        this.sendEvent('step_decided', {
          step_number: stepIndex,
          decision: confirmed ? 'confirmed' : 'skipped',
          decision_time_ms: decisionTimeMs,
        });

        if (!confirmed) {
          this.history.push({ step, output: '[Skipped by user]', skipped: true, timestamp: Date.now() });
          this.emit({ type: 'step_done', data: { step, output: '[Skipped by user]', skipped: true, index: stepIndex } });
          continue;
        }
      }

      stepsCompleted++;
      // Execute the command
      const output = this.executeCommand(step.command || '');
      // Include thinking in history so AI can see its own reasoning chain
      const stepWithThinking = { ...step, thinking: (step as any).thinking };
      this.history.push({ step: stepWithThinking, output, timestamp: Date.now() });
      this.emit({ type: 'step_done', data: { step: stepWithThinking, output, index: stepIndex } });
    }

    // Exhausted max steps
    this.setState('not_fixed');
    this.emit({ type: 'complete', data: { fixed: false, summary: `Reached maximum of ${MAX_STEPS} diagnostic steps.`, history: this.history } });
    this.sendEvent('session_end', { reason: 'max_steps', duration_ms: Date.now() - loopStartTime, steps_completed: stepsCompleted, outcome: 'not_fixed' });
  }

  private waitForConfirm(step: AgentStep): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingConfirm = { step, resolve };
      this.emit({ type: 'confirm_needed', data: { step } });
    });
  }

  private executeCommand(command: string): string {
    if (!command) return '(no command)';
    const dryRun = Boolean((global as Record<string, unknown>).__clawaid_dry_run);
    if (dryRun) return '[dry-run: command not executed]';

    try {
      const cmd = command.replace(/~/g, os.homedir());
      const output = execSync(cmd, {
        timeout: 20000,
        encoding: 'utf-8',
        shell: os.platform() === 'win32' ? 'cmd.exe' : '/bin/sh',
        env: { ...process.env, PATH: (process.env.PATH || '') + ':/usr/local/bin:/opt/homebrew/bin' },
      });
      return (output || '(no output)').slice(0, 3000);
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const out = ((e.stdout || '') + (e.stderr || '')).trim();
      return out ? out.slice(0, 3000) : `Error: ${e.message || 'unknown error'}`;
    }
  }

  private async callStep(isFirst: boolean): Promise<AgentStep> {
    const fingerprint = getMachineFingerprint();
    const findings = this.observation?.ruleFindings || [];

    // Build mode context for AI
    const allFindings = findings.map(f => `- [${f.severity.toUpperCase()}] ${f.title}: ${f.description}${f.fix ? ' (suggested fix: ' + f.fix + ')' : ''}`).join('\n');
    const rulesSummary = findings.length > 0
      ? `Rule engine pre-scan found:\n${allFindings}`
      : 'Rule engine pre-scan: no known issues detected (but rules only cover common patterns — use your own judgment on the full data).';

    let modeContext = '';
    if (this.userDescription) {
      modeContext = `MODE: USER_REPORTED_PROBLEM\nUser says: "${this.userDescription}"\n${rulesSummary}\nYour goal: Solve the user's problem. Use the system data and rule findings as clues. If you find other unrelated issues, put them in warnings.`;
      if (this.userScreenshot) {
        modeContext += '\nUser also provided a screenshot of the issue.';
      }
    } else {
      const hasRuleIssues = findings.some(f => f.severity === 'critical' || f.severity === 'high');
      if (hasRuleIssues) {
        modeContext = `MODE: FULL_SCAN\n${rulesSummary}\nYour goal: Confirm and fix the issues identified above. Use the system data as evidence.`;
      } else {
        modeContext = `MODE: FULL_SCAN (verification)\n${rulesSummary}\nThe rule engine found no critical issues. Verify by checking the full system data. If you agree the system is healthy, return done immediately with healthy=true — don't run extra read steps. Only investigate further if you spot a real problem in the data above. Put minor observations in warnings.`;
      }
    }

    const body = JSON.stringify({
      observationData: this.observationText,
      modeContext,
      history: this.history.map(h => ({ step: h.step, output: h.output, skipped: h.skipped })),
      fingerprint,
      lang: this.lang,
      ...(this.token ? { token: this.token } : {}),
      ...(isFirst ? {
        sessionStart: true,
        userDescription: this.userDescription || undefined,
        clawaid_version: clawaidVersion,
        platform: os.platform(),
        openclaw_version: this.observation?.openclawVersion || undefined,
      } : {}),
      ...(this.sbSessionId ? { supabaseSessionId: this.sbSessionId } : {}),
    });

    const url = new URL(`${CLAWAID_API}/step`);
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const lib = isLocal ? http : https;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        port: parseInt(url.port) || (isLocal ? 3001 : 443),
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'paywall') {
              reject(new PaywallError({
                price: parsed.price?.price || '$1.99',
                currency: parsed.price?.currency || 'USD',
                isChinese: parsed.price?.isChinese || false,
                credits: parsed.price?.credits || 5,
                payMethod: parsed.price?.payMethod,
              }));
              return;
            }
            if (parsed.error) { reject(new Error(parsed.error)); return; }
            // Capture Supabase session ID for subsequent requests
            if (parsed._sbSessionId) this.sbSessionId = parsed._sbSessionId;
            resolve(parsed as AgentStep);
          } catch {
            reject(new Error(`Parse error: ${data.slice(0, 100)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('Step request timeout')); });
      req.write(body);
      req.end();
    });
  }

  // Legacy: kept for old test harness compatibility
  async startFix(_optionId?: string) {
    // In the new design, fixing happens automatically in the loop
    // This is a no-op but kept so server.ts doesn't break
  }
}
