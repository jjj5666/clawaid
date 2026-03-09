import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import { execSync } from 'child_process';
import { observe, loadMockObservation, formatObservation, ObservationResult } from './observe';
import { extractApiKey, getMachineFingerprint, PaywallError } from './diagnose';

// ClawAid backend API URL
const CLAWAID_API = process.env.CLAWAID_API || 'https://api.clawaid.app';

// Max steps before giving up
const MAX_STEPS = 20;
// Max consecutive fix attempts before giving up
const MAX_FIX_ATTEMPTS = 4;

export type LoopState =
  | 'idle'
  | 'waiting_user_description'  // waiting for user to describe their problem (or skip)
  | 'observing'
  | 'running'     // agentic loop in progress
  | 'waiting'     // waiting for user to confirm a medium/high risk step
  | 'fixed'
  | 'not_fixed'
  | 'healthy'
  | 'needs_api_key'
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
  private apiKey = '';
  private token?: string;
  private userDescription = '';
  private userScreenshot?: string; // base64 data URL
  private observation?: ObservationResult;
  private observationText = '';
  private history: StepRecord[] = [];
  private fixAttempts = 0;
  private pendingConfirm?: { step: AgentStep; resolve: (confirmed: boolean) => void };
  private pendingDescription?: { resolve: (value: { description: string; screenshot?: string }) => void };

  constructor(callback: EventCallback) {
    this.callback = callback;
  }

  setToken(token: string) { this.token = token; }
  stop() { this.stopped = true; }

  private emit(event: LoopEvent) { this.callback(event); }
  private setState(s: LoopState) { this.state = s; this.emit({ type: 'state_change', data: { state: s } }); }
  private progress(msg: string) { this.emit({ type: 'progress', data: { message: msg } }); }

  async start() {
    // Auto-extract API key from OpenClaw config
    const autoKey = extractApiKey();
    if (autoKey) {
      this.apiKey = autoKey;
    } else if (!this.apiKey) {
      this.setState('needs_api_key');
      this.emit({
        type: 'request_input',
        data: {
          field: 'apiKey',
          instructions: 'ClawAid needs an OpenRouter API key to run diagnostics.',
        }
      });
      return;
    }

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

    await this.runLoop();
  }

  async provideInput(field: string, value: string, extra?: { screenshot?: string }) {
    if (field === 'apiKey') {
      this.apiKey = value;
      await this.runLoop();
    } else if (field === 'userDescription') {
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
          this.emit({ type: 'paywall', data: { price: err.price, currency: err.currency, isChinese: err.isChinese, credits: err.credits } });
          return;
        }
        const msg = (err as Error).message;
        if (msg.includes('paywall')) {
          this.setState('paywall');
          this.emit({ type: 'paywall', data: {} });
          return;
        }
        this.setState('error');
        this.emit({ type: 'error', data: { message: msg } });
        return;
      }

      // Done
      if (step.type === 'done') {
        this.emit({ type: 'step_start', data: { step, index: stepIndex } });
        const warnings = step.warnings || [];
        if (step.fixed) {
          this.setState('fixed');
          this.emit({ type: 'complete', data: { fixed: true, summary: step.summary, warnings, history: this.history } });
        } else if (this.fixAttempts === 0 && !step.fixed) {
          // Healthy — no fixes were needed
          this.setState('healthy');
          this.emit({ type: 'complete', data: { fixed: false, healthy: true, summary: step.summary, warnings, history: this.history } });
        } else {
          this.setState('not_fixed');
          this.emit({ type: 'complete', data: { fixed: false, summary: step.summary, warnings, history: this.history } });
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
          return;
        }

        // ALL fix steps require user confirmation — never auto-execute
        this.setState('waiting');
        const confirmed = await this.waitForConfirm(step);
        this.setState('running');

        if (!confirmed) {
          this.history.push({ step, output: '[Skipped by user]', skipped: true, timestamp: Date.now() });
          this.emit({ type: 'step_done', data: { step, output: '[Skipped by user]', skipped: true, index: stepIndex } });
          continue;
        }
      }

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
      ...(this.token ? { token: this.token } : {}),
      ...(isFirst ? { sessionStart: true } : {}),
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
              }));
              return;
            }
            if (parsed.error) { reject(new Error(parsed.error)); return; }
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
