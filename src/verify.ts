import { observe, formatObservation, ObservationResult } from './observe';
import { verifyFix } from './diagnose';

export interface VerifyResult {
  fixed: boolean;
  explanation: string;
  newObservation: ObservationResult;
  newObservationText: string;
}

export async function verify(
  apiKey: string,
  originalObservationText: string,
  actionsPerformed: string[],
  onProgress?: (msg: string) => void
): Promise<VerifyResult> {
  const progress = (msg: string) => {
    if (onProgress) onProgress(msg);
  };

  progress('Re-checking system state...');
  const newObservation = await observe((msg) => progress(`  ${msg}`));
  const newObservationText = formatObservation(newObservation);

  progress('Asking AI to verify if issue is resolved...');
  const { fixed, explanation } = await verifyFix(
    apiKey,
    originalObservationText,
    actionsPerformed,
    newObservationText
  );

  return {
    fixed,
    explanation,
    newObservation,
    newObservationText,
  };
}

// Quick heuristic check without AI (for speed)
export function quickHealthCheck(gatewayStatus: string): boolean {
  const lower = gatewayStatus.toLowerCase();
  return lower.includes('runtime: running') || lower.includes('rpc probe: ok');
}
