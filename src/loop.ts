import { observe, formatObservation, ObservationResult } from './observe';
import { diagnose, DiagnosisResult, extractApiKey } from './diagnose';
import { executeActions, formatExecuteResults } from './execute';
import { verify } from './verify';

export type LoopState =
  | 'idle'
  | 'observing'
  | 'diagnosing'
  | 'showing_plan'
  | 'executing'
  | 'verifying'
  | 'meta_thinking'
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
  metaThinkCount: number;
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
      metaThinkCount: 0,
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
          instructions: 'OpenClaw Doctor needs an OpenRouter API key to call Claude Opus for diagnosis. Your existing OpenClaw config does not have an OpenRouter key.',
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
    // Phase 1: Initial observation
    this.setState('observing');
    this.progress('🔍 Gathering system information...');
    
    const observation = await observe((msg) => this.progress(msg));
    this.context.originalObservation = observation;
    this.context.originalObservationText = formatObservation(observation);
    
    this.progress('✓ System scan complete');
    this.progress('📡 Sending data to AI for analysis...');

    // Three meta-think cycles, each with 3 repair rounds
    for (let metaCycle = 0; metaCycle < 3; metaCycle++) {
      if (this.stopped) break;
      
      if (metaCycle > 0) {
        // Meta-think between cycles
        this.context.metaThinkCount++;
        this.setState('meta_thinking');
        this.progress(`\n💭 Previous approach didn't work. Re-analyzing with new perspective...`);
        this.progress(`🔄 Meta-Think ${metaCycle}/3: Gathering fresh data and reconsidering from scratch...`);
      }

      // Do initial diagnosis (or meta-think diagnosis)
      this.setState('diagnosing');
      this.progress(metaCycle === 0 ? '🤔 AI is analyzing your system...' : '🔄 Finding a completely different approach...');
      
      try {
        const currentObs = await observe((msg) => this.progress(msg));
        const currentObsText = formatObservation(currentObs);
        
        const diagnosis = await diagnose({
          apiKey: this.context.apiKey,
          observationData: currentObsText,
          previousAttempts: this.context.attemptHistory,
          metaThinkRound: metaCycle > 0 ? metaCycle : undefined,
        });
        
        this.context.currentDiagnosis = diagnosis;

        // Check if system is healthy
        if (diagnosis.healthy && diagnosis.actions.length === 0) {
          this.progress('✅ ' + (diagnosis.diagnosis || 'OpenClaw is running normally. No issues detected.'));
          this.setState('healthy');
          this.emit({
            type: 'complete',
            data: {
              fixed: false,
              healthy: true,
              explanation: diagnosis.diagnosis || 'OpenClaw is running normally. No issues detected.',
            }
          });
          return;
        }
        
        // Show diagnosis to user
        this.setState('showing_plan');
        this.emit({
          type: 'diagnosis',
          data: {
            diagnosis: diagnosis.diagnosis,
            confidence: diagnosis.confidence,
            rootCause: diagnosis.rootCause,
            actions: diagnosis.actions,
            alternativeHypotheses: diagnosis.alternativeHypotheses,
            isMetaThink: metaCycle > 0,
          }
        });
        
        if (diagnosis.actions.length === 0) {
          this.progress('⚠️ AI returned no actions. The system may be healthy, or a different approach is needed. Continuing to next cycle...');
          // Don't give up — fall through to repair rounds which will re-diagnose
        }

        // Wait for user confirmation to proceed (the UI sends a 'fix' action)
        // For the first cycle we wait; for subsequent we proceed automatically
        if (metaCycle === 0 && this.context.roundNumber === 0) {
          // First diagnosis - wait for user to click "Fix" button
          this.setState('showing_plan');
          return; // Will resume when user clicks fix
        }
        
      } catch (err) {
        this.progress(`❌ AI analysis failed: ${(err as Error).message}`);
        this.setState('error');
        this.emit({ type: 'error', data: { message: (err as Error).message } });
        return;
      }

      // Three repair rounds per meta-cycle
      const fixed = await this.runRepairRounds(3);
      if (fixed) {
        this.setState('fixed');
        this.emit({
          type: 'complete',
          data: {
            fixed: true,
            explanation: 'OpenClaw has been successfully repaired!',
          }
        });
        return;
      }
    }

    // All 3 meta-cycles exhausted (9 rounds total)
    this.setState('not_fixed');
    this.progress('\n😔 After 9 repair attempts across 3 strategies, the issue persists.');
    this.emit({
      type: 'complete',
      data: {
        fixed: false,
        explanation: 'The issue could not be automatically resolved after 9 attempts.',
        diagnosticReport: this.buildDiagnosticReport(),
      }
    });
  }

  // Called when user clicks "Fix" button after first diagnosis
  async startFix() {
    if (!this.context.currentDiagnosis) {
      this.progress('No diagnosis available. Please restart.');
      return;
    }

    this.context.roundNumber = 0;

    // Execute the current plan
    const fixed = await this.executePlan(this.context.currentDiagnosis);
    
    if (fixed) {
      this.setState('fixed');
      this.emit({
        type: 'complete',
        data: {
          fixed: true,
          explanation: 'OpenClaw has been successfully repaired!',
        }
      });
      return;
    }

    // If not fixed, continue with remaining meta-cycles
    for (let metaCycle = 1; metaCycle < 3; metaCycle++) {
      if (this.stopped) break;
      
      this.context.metaThinkCount++;
      this.setState('meta_thinking');
      this.progress(`\n💭 Meta-Think ${metaCycle}/3: Reconsidering approach...`);
      
      try {
        const currentObs = await observe((msg) => this.progress(msg));
        const currentObsText = formatObservation(currentObs);
        
        const diagnosis = await diagnose({
          apiKey: this.context.apiKey,
          observationData: currentObsText,
          previousAttempts: this.context.attemptHistory,
          metaThinkRound: metaCycle,
        });
        
        this.context.currentDiagnosis = diagnosis;
        
        this.emit({
          type: 'diagnosis',
          data: {
            diagnosis: diagnosis.diagnosis,
            confidence: diagnosis.confidence,
            rootCause: diagnosis.rootCause,
            actions: diagnosis.actions,
            alternativeHypotheses: diagnosis.alternativeHypotheses,
            isMetaThink: true,
          }
        });

        const roundsFixed = await this.runRepairRounds(3);
        if (roundsFixed) {
          this.setState('fixed');
          this.emit({
            type: 'complete',
            data: {
              fixed: true,
              explanation: 'OpenClaw has been successfully repaired!',
            }
          });
          return;
        }
      } catch (err) {
        this.progress(`❌ Meta-think failed: ${(err as Error).message}`);
      }
    }

    this.setState('not_fixed');
    this.emit({
      type: 'complete',
      data: {
        fixed: false,
        explanation: 'The issue could not be automatically resolved after multiple attempts.',
        diagnosticReport: this.buildDiagnosticReport(),
      }
    });
  }

  private async runRepairRounds(maxRounds: number): Promise<boolean> {
    for (let round = 0; round < maxRounds; round++) {
      if (this.stopped) return false;
      
      this.context.roundNumber++;
      
      if (round > 0) {
        // Need new diagnosis for subsequent rounds
        this.setState('diagnosing');
        this.progress(`\n🔄 Round ${round + 1}/${maxRounds}: Re-analyzing...`);
        
        try {
          const currentObs = await observe((msg) => this.progress(msg));
          const currentObsText = formatObservation(currentObs);
          
          const newDiagnosis = await diagnose({
            apiKey: this.context.apiKey,
            observationData: currentObsText,
            previousAttempts: this.context.attemptHistory,
          });
          
          this.context.currentDiagnosis = newDiagnosis;
          
          this.emit({
            type: 'diagnosis',
            data: {
              diagnosis: newDiagnosis.diagnosis,
              confidence: newDiagnosis.confidence,
              rootCause: newDiagnosis.rootCause,
              actions: newDiagnosis.actions,
              alternativeHypotheses: newDiagnosis.alternativeHypotheses,
              isMetaThink: false,
            }
          });
        } catch (err) {
          this.progress(`Analysis error: ${(err as Error).message}`);
          continue;
        }
      }
      
      if (!this.context.currentDiagnosis) continue;

      // Skip execution if AI returned no actions; re-observe next round
      if (this.context.currentDiagnosis.actions.length === 0) {
        this.progress('⚠️ AI returned no actions this round. Will re-observe and try again...');
        this.context.attemptHistory.push(`### Attempt ${this.context.roundNumber}\nAI returned no actions. Skipping execution and re-observing.`);
        continue;
      }
      
      const fixed = await this.executePlan(this.context.currentDiagnosis);
      if (fixed) return true;
    }
    
    return false;
  }

  private async executePlan(diagnosis: DiagnosisResult): Promise<boolean> {
    if (diagnosis.actions.length === 0) {
      this.progress('⚠️ No actions to execute.');
      return false;
    }
    this.setState('executing');
    this.progress(`\n🔧 Executing repair plan (${diagnosis.actions.length} steps)...`);
    
    const executeResult = await executeActions(
      diagnosis.actions,
      (msg, result) => {
        this.progress(msg);
        if (result) {
          this.emit({ type: 'action_result', data: result });
        }
      }
    );
    
    // Record this attempt in history
    const attemptSummary = `
### Attempt ${this.context.roundNumber}
Diagnosis: ${diagnosis.diagnosis}
Root cause: ${diagnosis.rootCause}
Actions taken:
${formatExecuteResults(executeResult.results)}
Result: ${executeResult.summary}
`.trim();
    
    this.context.attemptHistory.push(attemptSummary);
    
    // Verify
    this.setState('verifying');
    this.progress('\n✅ Verifying repair...');
    
    try {
      const verifyResult = await verify(
        this.context.apiKey,
        this.context.originalObservationText || '',
        executeResult.results.map(r => `${r.action.command}: ${r.output}`),
        (msg) => this.progress(msg)
      );
      
      this.emit({
        type: 'verify_result',
        data: {
          fixed: verifyResult.fixed,
          explanation: verifyResult.explanation,
        }
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
# OpenClaw Doctor - Diagnostic Report
Generated: ${new Date().toISOString()}

## System State (Initial)
${this.context.originalObservationText || 'Not captured'}

## Repair Attempts (${this.context.attemptHistory.length} total)
${this.context.attemptHistory.join('\n\n---\n\n')}

## Summary
After ${this.context.roundNumber} repair rounds and ${this.context.metaThinkCount} meta-think cycles,
the issue was not automatically resolved. Please review the diagnostic data above and consult
the OpenClaw community for assistance.

## Resources
- OpenClaw Discord: https://discord.gg/openclaw
- Run manually: openclaw doctor
- View logs: openclaw logs --follow
`.trim();
  }
}
