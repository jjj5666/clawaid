import { observe, formatObservation, ObservationResult } from './observe';
import { diagnose, DiagnosisResult, RepairOption, extractApiKey } from './diagnose';
import { executeActions, formatExecuteResults } from './execute';
import { verify } from './verify';

export type LoopState =
  | 'idle'
  | 'observing'
  | 'diagnosing'
  | 'showing_options'
  | 'auto_executing'
  | 'executing'
  | 'verifying'
  | 'fixed'
  | 'not_fixed'
  | 'healthy'
  | 'needs_api_key'
  | 'error';

export interface LoopEvent {
  type:
    | 'state_change'
    | 'progress'
    | 'diagnosis'
    | 'action_result'
    | 'verify_result'
    | 'request_input'
    | 'complete'
    | 'error';
  data: unknown;
}

export type EventCallback = (event: LoopEvent) => void;

export interface LoopContext {
  apiKey: string;
  originalObservation?: ObservationResult;
  originalObservationText?: string;
  currentDiagnosis?: DiagnosisResult;
  attemptHistory: string[];
  roundNumber: number;
}

export class DoctorLoop {
  private callback: EventCallback;
  private context: LoopContext;
  private state: LoopState = 'idle';
  private stopped = false;

  constructor(callback: EventCallback, apiKey = '') {
    this.callback = callback;
    this.context = {
      apiKey,
      attemptHistory: [],
      roundNumber: 0,
    };
  }

  setApiKey(key: string) {
    this.context.apiKey = key;
  }

  stop() {
    this.stopped = true;
  }

  private emit(event: LoopEvent) {
    this.callback(event);
  }

  private setState(state: LoopState) {
    this.state = state;
    this.emit({ type: 'state_change', data: { state } });
  }

  private progress(msg: string) {
    this.emit({ type: 'progress', data: { message: msg } });
  }

  async start() {
    // Check for API key first
    const autoKey = extractApiKey();
    if (autoKey) {
      this.context.apiKey = autoKey;
      this.progress('Found OpenRouter API key in OpenClaw config ✓');
    } else if (!this.context.apiKey) {
      this.setState('needs_api_key');
      this.emit({
        type: 'request_input',
        data: {
          field: 'apiKey',
          label: 'OpenRouter API Key',
          placeholder: 'sk-or-...',
          hint: '🔒 Local only. Not stored. Only sent to OpenRouter for AI diagnosis.',
          instructions: 'ClawAid needs an OpenRouter API key to call Claude for diagnosis. Your existing OpenClaw config does not have an OpenRouter key.',
        }
      });
      return; // Wait for user to provide key via provideInput()
    }

    await this.runMainLoop();
  }

  async provideInput(field: string, value: string) {
    if (field === 'apiKey') {
      this.context.apiKey = value;
      this.progress('API key received, starting diagnosis...');
      await this.runMainLoop();
    }
  }

  private async runMainLoop() {
    // ── Round 1: Observe + Diagnose ──────────────────────────────────────────
    this.setState('observing');
    this.progress('🔍 Gathering system information...');
    
    const observation = await observe((msg) => this.progress(msg));
    this.context.originalObservation = observation;
    this.context.originalObservationText = formatObservation(observation);
    
    this.progress('✓ System scan complete');
    this.progress('📡 Sending data to AI for analysis...');

    this.setState('diagnosing');
    this.progress('🤔 AI is analyzing your system...');

    try {
      const diagnosis = await diagnose({
        apiKey: this.context.apiKey,
        observationData: this.context.originalObservationText,
      });

      this.context.currentDiagnosis = diagnosis;

      // Healthy?
      if (diagnosis.healthy && diagnosis.options.length === 0) {
        this.progress('✅ ' + (diagnosis.diagnosis || 'OpenClaw is running normally. No issues detected.'));
        this.setState('healthy');
        this.emit({
          type: 'complete',
          data: { fixed: false, healthy: true, explanation: diagnosis.diagnosis, warnings: diagnosis.warnings || [] },
        });
        return;
      }

      this.emit({
        type: 'diagnosis',
        data: {
          diagnosis: diagnosis.diagnosis,
          confidence: diagnosis.confidence,
          rootCause: diagnosis.rootCause,
          warnings: diagnosis.warnings || [],
          options: diagnosis.options,
          alternativeHypotheses: diagnosis.alternativeHypotheses,
          round: 1,
        }
      });

      // Auto-execute if the recommended option(s) are all autoExecute
      const recommended = diagnosis.options.filter(o => o.recommended);
      const canAutoExecute = recommended.length > 0 && recommended.every(o => o.autoExecute);

      if (canAutoExecute) {
        this.progress('🔧 Auto-fix available — executing recommended fix automatically...');
        const fixed = await this.executeOption(recommended[0]);
        if (fixed) {
          this.setState('fixed');
          this.emit({ type: 'complete', data: { fixed: true, explanation: 'OpenClaw has been successfully repaired!' } });
          return;
        }
        // Auto-fix didn't work → show options to user for round 2
      } else {
        // Show option cards to user and wait for their choice
        this.setState('showing_options');
        return; // Resumes via startFix(optionId)
      }
    } catch (err) {
      this.progress(`❌ AI analysis failed: ${(err as Error).message}`);
      this.setState('error');
      this.emit({ type: 'error', data: { message: (err as Error).message } });
      return;
    }

    // Auto-fix failed → round 2 with updated observation
    await this.continueAfterFailure(2);
  }

  /**
   * Called when user clicks "Fix" on an option card.
   * optionId: "A", "B", "C" — if omitted, use the recommended option.
   */
  async startFix(optionId?: string) {
    if (!this.context.currentDiagnosis) {
      this.progress('No diagnosis available. Please restart.');
      return;
    }

    const options = this.context.currentDiagnosis.options;
    let chosen: RepairOption | undefined;

    if (optionId) {
      chosen = options.find(o => o.id === optionId);
    }
    if (!chosen) {
      chosen = options.find(o => o.recommended) || options[0];
    }

    if (!chosen) {
      this.progress('⚠️ No option found to execute.');
      return;
    }

    this.context.roundNumber = 1;
    const fixed = await this.executeOption(chosen);

    if (fixed) {
      this.setState('fixed');
      this.emit({ type: 'complete', data: { fixed: true, explanation: 'OpenClaw has been successfully repaired!' } });
      return;
    }

    // Not fixed after round 1 user choice → round 2
    await this.continueAfterFailure(2);
  }

  /**
   * Continue with round 2 or 3 after a failed fix attempt.
   */
  private async continueAfterFailure(round: number) {
    if (this.stopped) return;

    // Round 3: give up
    if (round > 3) {
      this.setState('not_fixed');
      this.progress('\n😔 After 3 repair rounds, the issue persists.');
      this.emit({
        type: 'complete',
        data: {
          fixed: false,
          explanation: 'The issue could not be automatically resolved after 3 attempts.',
          diagnosticReport: this.buildDiagnosticReport(),
        }
      });
      return;
    }

    // Re-observe
    this.setState('observing');
    this.progress(`\n🔄 Round ${round}: Re-scanning system...`);

    let currentObsText: string;
    try {
      const currentObs = await observe((msg) => this.progress(msg));
      currentObsText = formatObservation(currentObs);
    } catch (err) {
      this.progress(`Observation error: ${(err as Error).message}`);
      currentObsText = this.context.originalObservationText || '';
    }

    // Re-diagnose
    this.setState('diagnosing');
    this.progress('🤔 AI is re-analyzing with attempt history...');

    try {
      const newDiagnosis = await diagnose({
        apiKey: this.context.apiKey,
        observationData: currentObsText,
        previousAttempts: this.context.attemptHistory,
        round,
      });

      this.context.currentDiagnosis = newDiagnosis;

      if (newDiagnosis.healthy && newDiagnosis.options.length === 0) {
        this.progress('✅ ' + (newDiagnosis.diagnosis || 'OpenClaw is running normally. No issues detected.'));
        this.setState('healthy');
        this.emit({ type: 'complete', data: { fixed: false, healthy: true, explanation: newDiagnosis.diagnosis, warnings: newDiagnosis.warnings || [] } });
        return;
      }

      this.emit({
        type: 'diagnosis',
        data: {
          diagnosis: newDiagnosis.diagnosis,
          confidence: newDiagnosis.confidence,
          rootCause: newDiagnosis.rootCause,
          options: newDiagnosis.options,
          alternativeHypotheses: newDiagnosis.alternativeHypotheses,
          round,
        }
      });

      // Round 3 = give up, just show report
      if (round === 3) {
        this.setState('not_fixed');
        this.emit({
          type: 'complete',
          data: {
            fixed: false,
            explanation: 'The issue could not be automatically resolved after 3 attempts.',
            diagnosticReport: this.buildDiagnosticReport(),
          }
        });
        return;
      }

      // Try auto-execute again if possible
      const recommended = newDiagnosis.options.filter(o => o.recommended);
      const canAutoExecute = recommended.length > 0 && recommended.every(o => o.autoExecute);

      if (canAutoExecute) {
        this.progress('🔧 Auto-fix available — executing recommended fix automatically...');
        const fixed = await this.executeOption(recommended[0]);
        if (fixed) {
          this.setState('fixed');
          this.emit({ type: 'complete', data: { fixed: true, explanation: 'OpenClaw has been successfully repaired!' } });
          return;
        }
        await this.continueAfterFailure(round + 1);
      } else {
        // Show options to user
        this.setState('showing_options');
        // Will resume via startFix() — but update roundNumber so next call knows which round we're on
        this.context.roundNumber = round;
      }
    } catch (err) {
      this.progress(`❌ AI analysis failed: ${(err as Error).message}`);
      this.setState('error');
      this.emit({ type: 'error', data: { message: (err as Error).message } });
    }
  }

  private async executeOption(option: RepairOption): Promise<boolean> {
    if (option.steps.length === 0) {
      this.progress('⚠️ No steps in this option.');
      return false;
    }

    this.setState('auto_executing');
    this.progress(`\n🔧 Executing: ${option.title} (${option.steps.length} step${option.steps.length > 1 ? 's' : ''})...`);

    const executeResult = await executeActions(
      option.steps,
      (msg, result) => {
        this.progress(msg);
        if (result) {
          this.emit({ type: 'action_result', data: result });
        }
      }
    );

    // Record this attempt
    const attemptSummary = `
### Attempt ${this.context.roundNumber + 1} — Option ${option.id}: ${option.title}
Diagnosis: ${this.context.currentDiagnosis?.diagnosis || ''}
Root cause: ${this.context.currentDiagnosis?.rootCause || ''}
Steps taken:
${formatExecuteResults(executeResult.results)}
Result: ${executeResult.summary}
`.trim();

    this.context.attemptHistory.push(attemptSummary);
    this.context.roundNumber++;

    // Verify
    this.setState('verifying');
    this.progress('\n🔍 Verifying repair...');

    try {
      const verifyResult = await verify(
        this.context.apiKey,
        this.context.originalObservationText || '',
        executeResult.results.map(r => `${r.action.command}: ${r.output}`),
        (msg) => this.progress(msg)
      );

      this.emit({
        type: 'verify_result',
        data: { fixed: verifyResult.fixed, explanation: verifyResult.explanation },
      });

      if (verifyResult.fixed) {
        this.progress(`\n✅ ${verifyResult.explanation}`);
        return true;
      } else {
        this.progress(`\n⚠️ Not yet fixed: ${verifyResult.explanation}`);
        return false;
      }
    } catch (err) {
      this.progress(`Verification error: ${(err as Error).message}`);
      return false;
    }
  }

  private buildDiagnosticReport(): string {
    return `
# ClawAid - Diagnostic Report
Generated: ${new Date().toISOString()}

## System State (Initial)
${this.context.originalObservationText || 'Not captured'}

## Repair Attempts (${this.context.attemptHistory.length} total)
${this.context.attemptHistory.join('\n\n---\n\n')}

## Summary
After ${this.context.roundNumber} repair round(s), the issue was not automatically resolved.
Please review the diagnostic data above and consult the OpenClaw community for assistance.

## Resources
- OpenClaw Discord: https://discord.gg/openclaw
- Run manually: openclaw doctor
- View logs: openclaw logs --follow
`.trim();
  }
}
