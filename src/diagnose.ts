import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface DiagnosticAction {
  description: string;
  command: string;
  type: 'cli' | 'system' | 'file_edit';
  risk: 'low' | 'medium' | 'high';
  backup: string | null;
}

export interface DiagnosisResult {
  healthy?: boolean;
  diagnosis: string;
  confidence: number;
  rootCause: string;
  actions: DiagnosticAction[];
  alternativeHypotheses: string[];
  rawResponse?: string;
}

export interface DiagnoseOptions {
  apiKey: string;
  observationData: string;
  previousAttempts?: string[];
  metaThinkRound?: number;
}

const SYSTEM_PROMPT = `You are a top-tier OpenClaw diagnostics engineer. OpenClaw is a local AI gateway/assistant platform that runs on macOS.

Key facts about OpenClaw:
- Default gateway port: 18789
- Config: ~/.openclaw/openclaw.json (JSON5 format)
- Log files: /tmp/openclaw/openclaw-YYYY-MM-DD.log
- LaunchAgent plist: ~/Library/LaunchAgents/ai.openclaw.gateway.plist
- Service commands: openclaw gateway start/stop/restart/install
- gateway.mode must be "local" in config for local operation
- Doctor command: openclaw doctor / openclaw doctor --yes / openclaw doctor --repair

You think like a scientist: observe, hypothesize, test, refine.

Given the system data, follow this chain of thought:
1. What anomalies do you see? (List facts only)
2. What root cause do these point to? (Not symptoms - the actual root cause)
3. Could you be wrong? What other possibilities exist?
4. What is the minimal fix?
5. What are the risks of this fix? Could it break anything else?
6. Can it be done with official CLI commands? Or must files be edited?

IMPORTANT RULES:
- If the system is healthy (gateway running, RPC probe ok, no errors in logs), return "healthy": true and empty actions. Do NOT invent problems.
- Prefer official OpenClaw CLI commands (openclaw gateway restart, openclaw doctor --yes, openclaw gateway install --force) over system commands (kill, launchctl). Only resort to system commands or file edits as last resort.
- Focus ONLY on things that prevent OpenClaw from functioning. Ignore cosmetic issues, warnings about unused channels, or non-critical configuration details.

Output ONLY valid JSON (no markdown, no code fences, no explanation outside JSON):
{
  "healthy": false,
  "diagnosis": "plain language description of what's wrong (2-3 sentences max). If healthy, say 'OpenClaw is running normally. No issues detected.'",
  "confidence": 0.0-1.0,
  "rootCause": "technical root cause (one sentence). If healthy, say 'No issues found'",
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
}`;

const META_THINK_PROMPT = `You are a top-tier OpenClaw diagnostics engineer doing a meta-analysis.

Your previous repair attempts did NOT fix the problem. You have seen ${3} rounds of observe → diagnose → fix → verify, and the issue persists.

Now think differently:
1. What did all my failed attempts have in common? (common assumption I kept making)
2. What does the failure data tell me about what the real problem ISN'T?
3. What root cause would explain BOTH the original symptoms AND the failure of my fixes?
4. What completely different approach should I try?

Be brutally honest. If you're uncertain, say so. If the problem is beyond automated repair, say so.

Output ONLY valid JSON:
{
  "diagnosis": "updated understanding of the problem after failed attempts",
  "confidence": 0.0-1.0,
  "rootCause": "revised root cause hypothesis",
  "actions": [
    {
      "description": "what this new approach does",
      "command": "the actual command to run",
      "type": "cli|system|file_edit",
      "risk": "low|medium|high",
      "backup": "backup command if type is file_edit, null otherwise"
    }
  ],
  "alternativeHypotheses": ["other possibilities we haven't tried"]
}`;

function extractApiKey(): string | null {
  const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  
  try {
    if (!fs.existsSync(configPath)) return null;
    
    const content = fs.readFileSync(configPath, 'utf-8');
    
    // Look for openrouter API key
    const patterns = [
      /"openrouter"\s*:\s*\{[^}]*"apiKey"\s*:\s*"([^"]+)"/s,
      /"apiKey"\s*:\s*"(sk-or-[^"]+)"/,
      /"apiKey"\s*:\s*"(sk-or-v1-[^"]+)"/,
    ];
    
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) return match[1];
    }
    
    return null;
  } catch {
    return null;
  }
}

async function callOpenRouter(apiKey: string, systemPrompt: string, userMessage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'anthropic/claude-sonnet-4-6',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 2000,
      temperature: 0,
    });

    const options = {
      hostname: 'openrouter.ai',
      port: 443,
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/openclaw-doctor',
        'X-Title': 'OpenClaw Doctor',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`OpenRouter API error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
            return;
          }
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) {
            reject(new Error(`No content in response: ${data}`));
            return;
          }
          resolve(content);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`OpenRouter connection error: ${err.message}`));
    });
    req.setTimeout(90000, () => {
      req.destroy();
      reject(new Error('OpenRouter request timed out after 90s. Check your internet connection.'));
    });
    req.write(body);
    req.end();
  });
}

function parseJsonResponse(response: string): DiagnosisResult {
  // Try to extract JSON from the response (in case model added markdown)
  let jsonStr = response.trim();
  
  // Remove markdown code blocks if present
  const jsonMatch = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1];
  } else if (!jsonStr.startsWith('{')) {
    // Try to find the first { and last }
    const start = jsonStr.indexOf('{');
    const end = jsonStr.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      jsonStr = jsonStr.slice(start, end + 1);
    }
  }
  
  const parsed = JSON.parse(jsonStr);
  
  // Validate and normalize
  return {
    healthy: Boolean(parsed.healthy),
    diagnosis: parsed.diagnosis || 'Unable to determine diagnosis',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    rootCause: parsed.rootCause || 'Unknown root cause',
    actions: Array.isArray(parsed.actions) ? parsed.actions.map((a: Partial<DiagnosticAction>) => ({
      description: a.description || 'Unknown action',
      command: a.command || '',
      type: a.type || 'cli',
      risk: a.risk || 'low',
      backup: a.backup || null,
    })) : [],
    alternativeHypotheses: Array.isArray(parsed.alternativeHypotheses) ? parsed.alternativeHypotheses : [],
    rawResponse: response,
  };
}

export async function diagnose(options: DiagnoseOptions): Promise<DiagnosisResult> {
  const { apiKey, observationData, previousAttempts, metaThinkRound } = options;
  
  const isMetaThink = metaThinkRound !== undefined && metaThinkRound > 0;
  
  let userMessage: string;
  
  if (isMetaThink && previousAttempts && previousAttempts.length > 0) {
    userMessage = `
## Meta-Think Round ${metaThinkRound}

Your previous repair attempts have failed. Here is the complete history:

${previousAttempts.join('\n\n---\n\n')}

## Current System State (after ${previousAttempts.length} failed attempts):
${observationData}

Given that your previous approaches did not work, what is your revised diagnosis and completely different repair strategy?
`.trim();
  } else {
    userMessage = `
## System Observation Data

${observationData}

${previousAttempts && previousAttempts.length > 0 ? `
## Previous Repair Attempts (these did NOT work)
${previousAttempts.join('\n\n---\n\n')}

Based on the failure of these previous attempts, please provide a new diagnosis and approach.
` : ''}

Please diagnose the OpenClaw issues and provide a repair plan.
`.trim();
  }

  const systemPrompt = isMetaThink ? META_THINK_PROMPT : SYSTEM_PROMPT;

  let response: string;
  try {
    response = await callOpenRouter(apiKey, systemPrompt, userMessage);
  } catch (err) {
    // Re-throw with a clear, user-visible message
    const msg = (err as Error).message || String(err);
    throw new Error(`AI API call failed: ${msg}`);
  }
  
  try {
    return parseJsonResponse(response);
  } catch (e) {
    // If JSON parsing fails, return a structured error with the raw response visible
    return {
      diagnosis: `AI analysis completed but response format was unexpected. The AI may have returned a non-JSON response. Raw response: ${response.slice(0, 500)}`,
      confidence: 0.1,
      rootCause: 'Unable to parse AI response as JSON',
      actions: [],
      alternativeHypotheses: ['Manual inspection required', 'Try again — the AI may return valid JSON on the next attempt'],
      rawResponse: response,
    };
  }
}

export async function verifyFix(
  apiKey: string,
  originalObservation: string,
  actionsPerformed: string[],
  newObservation: string
): Promise<{ fixed: boolean; explanation: string }> {
  const userMessage = `
## Original System State (before repair)
${originalObservation}

## Actions Performed
${actionsPerformed.join('\n')}

## Current System State (after repair)
${newObservation}

Is the OpenClaw issue fixed? Respond with ONLY valid JSON:
{
  "fixed": true|false,
  "explanation": "brief explanation of what you see"
}
`.trim();

  const systemPrompt = `You are an OpenClaw diagnostics engineer verifying if a repair was successful.
Compare the before and after states and determine if the issue is resolved.
Key success indicators:
- "Runtime: running" in gateway status
- "RPC probe: ok" in gateway status
- No error messages in logs
- Gateway responding on port 18789
Output ONLY valid JSON with "fixed" (boolean) and "explanation" (string).`;

  const response = await callOpenRouter(apiKey, systemPrompt, userMessage);
  
  try {
    let jsonStr = response.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (jsonMatch) jsonStr = jsonMatch[1];
    const parsed = JSON.parse(jsonStr);
    return {
      fixed: Boolean(parsed.fixed),
      explanation: parsed.explanation || 'Verification complete',
    };
  } catch {
    // Fallback: check if "fixed: true" or similar appears
    const looksFixed = response.toLowerCase().includes('"fixed": true') || 
                       response.toLowerCase().includes('"fixed":true');
    return {
      fixed: looksFixed,
      explanation: response.slice(0, 300),
    };
  }
}

export { extractApiKey };
