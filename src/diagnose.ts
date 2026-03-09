import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ClawAid backend API URL — set CLAWAID_API to override (e.g. for local dev)
const CLAWAID_API = process.env.CLAWAID_API || 'https://api.clawaid.app';

/**
 * Generate a stable machine fingerprint using hostname + platform + arch.
 * Falls back to a hash so we never expose raw machine names.
 */
export function getMachineFingerprint(): string {
  const raw = `${os.hostname()}::${os.platform()}::${os.arch()}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export class PaywallError extends Error {
  readonly price: string;
  readonly currency: string;
  readonly isChinese: boolean;
  readonly credits: number;

  constructor(opts: { price: string; currency: string; isChinese: boolean; credits: number }) {
    super('PaywallError');
    this.name = 'PaywallError';
    this.price = opts.price;
    this.currency = opts.currency;
    this.isChinese = opts.isChinese;
    this.credits = opts.credits;
  }
}

async function callClawAidAPI(observationData: string, previousAttempts?: string[], round?: number, token?: string): Promise<DiagnosisResult> {
  return new Promise((resolve, reject) => {
    const fingerprint = getMachineFingerprint();
    const body = JSON.stringify({ observationData, previousAttempts, round, fingerprint, ...(token ? { token } : {}) });
    // Worker path is /diagnose (no /api prefix)
    const url = new URL(`${CLAWAID_API}/diagnose`);
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const lib = isLocal ? http : https;

    const options = {
      hostname: url.hostname,
      port: parseInt(url.port) || (isLocal ? 3001 : 443),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // paywallOnFix = diagnosis visible, fix blocked — don't throw, just flag
          if (parsed.paywall && !parsed.paywallOnFix) {
            reject(new PaywallError({
              price: parsed.price || (parsed.isChinese ? '¥9.9' : '$1.99'),
              currency: parsed.currency || (parsed.isChinese ? 'CNY' : 'USD'),
              isChinese: Boolean(parsed.isChinese),
              credits: parsed.credits || 0,
            }));
            return;
          }
          if (parsed.error) reject(new Error(parsed.error));
          else resolve(parsed as DiagnosisResult);
        } catch {
          reject(new Error(`Failed to parse backend response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('Backend request timeout')); });
    req.write(body);
    req.end();
  });
}

export interface DiagnosticAction {
  description: string;
  command: string;
  type: 'cli' | 'system' | 'file_edit';
  risk: 'low' | 'medium' | 'high';
  backup: string | null;
}

export interface RepairOption {
  id: string;           // "A", "B", "C"
  title: string;        // "Restart gateway (recommended)"
  description: string;  // brief explanation
  recommended: boolean; // AI picks the best one
  risk: 'low' | 'medium' | 'high';
  autoExecute: boolean; // true = run without asking user
  steps: DiagnosticAction[];
}

export interface DiagnosisResult {
  healthy?: boolean;
  diagnosis: string;
  confidence: number;
  rootCause: string;
  reasoning: string[];
  warnings: string[];
  options: RepairOption[];
  alternativeHypotheses: string[];
  rawResponse?: string;
  paywallOnFix?: boolean;
  price?: unknown;
}

export interface DiagnoseOptions {
  apiKey: string;
  observationData: string;
  previousAttempts?: string[];
  round?: number;
  token?: string;
}

const SYSTEM_PROMPT = `You are a top-tier OpenClaw diagnostics engineer. OpenClaw is a local AI gateway/assistant platform that runs on macOS. Your tool is called ClawAid 🩺.

IMPORTANT: The observation data starts with "AUTOMATED RULE CHECKS" — these are deterministic findings verified by code, NOT guesses. If any CRITICAL rules are flagged:
1. They MUST be your primary diagnosis (highest priority)
2. Use the suggested fix command in your repair options
3. Do NOT downgrade them to warnings or secondary issues
4. The rule check is authoritative — trust it over other signals

Key facts about OpenClaw:
- Default gateway port: 18789
- Config: ~/.openclaw/openclaw.json (JSON5 format)
- Log files: /tmp/openclaw/openclaw-YYYY-MM-DD.log
- LaunchAgent plist: ~/Library/LaunchAgents/ai.openclaw.gateway.plist
- Service commands: openclaw gateway start/stop/restart/install
- gateway.mode must be "local" in config for local operation
- Doctor command: openclaw doctor / openclaw doctor --yes / openclaw doctor --repair

IMPORTANT - Solution priority (always prefer higher in the list):
1. \`openclaw doctor --yes\` or \`openclaw doctor --repair\` — if the official doctor already identified the issue, use its built-in fix first
2. \`openclaw gateway restart\` — restart the gateway service
3. \`openclaw gateway install --force\` — reinstall the launch agent
4. System commands: kill, launchctl (only if CLI commands above fail)
5. File edits — absolute LAST resort only

ALWAYS check the official \`openclaw doctor\` output first. It already identifies many common issues like:
- WhatsApp groupPolicy warnings
- Missing or misconfigured gateway
- LaunchAgent issues
If the official doctor already identified an issue AND has a CLI fix, use that fix first.

You think like a scientist: observe, hypothesize, test, refine.

Given the system data:
1. What anomalies do you see? (List facts only — check the official doctor output FIRST)
2. What root cause do these point to?
3. What is the minimal fix using the priority order above?
4. What are the risks?

IMPORTANT RULES:
- If the core system is healthy (gateway running, RPC probe ok, no errors), return "healthy": true.
- BUT still report non-critical issues in the "warnings" array (e.g., channel config warnings, version mismatches, orphan files). Users should know about these even if they don't need immediate fixing.
- Focus options ONLY on things that prevent OpenClaw from functioning. Non-critical warnings don't need fix options.
- Return 1-3 options, ALWAYS mark exactly one as recommended. If healthy with no critical issues, options can be empty.
- Options with risk "low" SHOULD have autoExecute: true (they run automatically without asking the user).
- Options with risk "medium" or "high" MUST have autoExecute: false.

Output ONLY valid JSON (no markdown, no code fences):
{
  "healthy": false,
  "diagnosis": "plain language description of what's wrong (2-3 sentences max). If healthy, describe the overall status briefly.",
  "confidence": 0.0-1.0,
  "rootCause": "technical root cause (one sentence). If healthy, say 'No critical issues found'",
  "reasoning": [
    "Checked gateway status → running normally on port 18789",
    "Read LaunchAgent plist → found proxy configuration pointing to localhost:9999",
    "This proxy will cause failures on next gateway restart — treat as critical"
  ],
  "warnings": [
    "Non-critical: WhatsApp groupPolicy set to allowlist but allowFrom is empty — messages in groups would be dropped if WhatsApp were enabled. Safe to ignore for now.",
    "Non-critical: Desktop app version (2026.2.22) is older than gateway (2026.3.2). Consider updating."
  ],
  "options": [
    {
      "id": "A",
      "title": "Restart gateway",
      "description": "brief explanation of what this option does and why it should work",
      "recommended": true,
      "risk": "low",
      "autoExecute": true,
      "steps": [
        {
          "description": "what this step does in plain language",
          "command": "the actual command to run",
          "type": "cli",
          "risk": "low",
          "backup": null
        }
      ]
    }
  ],
  "alternativeHypotheses": ["other possible causes if this doesn't work"]
}
reasoning: 3-6 plain language sentences summarizing your diagnostic thinking, written for non-technical users.`;

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
        'HTTP-Referer': 'https://github.com/openclaw-clawaid',
        'X-Title': 'ClawAid',
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
  
  // Normalize options array
  const rawOptions = Array.isArray(parsed.options) ? parsed.options : [];
  const options: RepairOption[] = rawOptions.map((o: Partial<RepairOption> & { steps?: Partial<DiagnosticAction>[] }) => ({
    id: o.id || 'A',
    title: o.title || 'Fix',
    description: o.description || '',
    recommended: Boolean(o.recommended),
    risk: o.risk || 'low',
    autoExecute: Boolean(o.autoExecute),
    steps: Array.isArray(o.steps) ? o.steps.map((s) => ({
      description: s.description || 'Unknown action',
      command: s.command || '',
      type: s.type || 'cli',
      risk: s.risk || 'low',
      backup: s.backup || null,
    })) : [],
  }));

  // Validate and normalize
  return {
    healthy: Boolean(parsed.healthy),
    diagnosis: parsed.diagnosis || 'Unable to determine diagnosis',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    rootCause: parsed.rootCause || 'Unknown root cause',
    reasoning: Array.isArray(parsed.reasoning) ? parsed.reasoning : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    options,
    alternativeHypotheses: Array.isArray(parsed.alternativeHypotheses) ? parsed.alternativeHypotheses : [],
    rawResponse: response,
  };
}

function loadContextDocs(): string {
  const contextDir = path.join(__dirname, '..', 'context');
  let docs = '';
  try {
    if (!fs.existsSync(contextDir)) return '';
    const files = fs.readdirSync(contextDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(contextDir, file), 'utf-8');
      // Truncate each file to 2000 chars to avoid bloating the prompt
      const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n...[truncated]' : content;
      docs += `\n--- ${file} ---\n${truncated}\n`;
    }
  } catch { /* ignore */ }
  return docs;
}

export async function diagnose(options: DiagnoseOptions): Promise<DiagnosisResult> {
  const { apiKey, observationData, previousAttempts, round, token } = options;
  
  let userMessage: string;
  
  const contextDocs = loadContextDocs();

  if (previousAttempts && previousAttempts.length > 0) {
    userMessage = `
## Reference Documentation
${contextDocs}

## System Observation Data

${observationData}

## Previous Repair Attempts (Round ${round || previousAttempts.length} — these did NOT fully fix the issue)
${previousAttempts.join('\n\n---\n\n')}

Based on the failure of previous attempts, please provide a revised diagnosis and a new approach.

IMPORTANT: You MUST respond with valid JSON only. No prose, no markdown, no explanation outside the JSON object. Start your response with { and end with }.
`.trim();
  } else {
    userMessage = `
## Reference Documentation
${contextDocs}

## System Observation Data

${observationData}

Please diagnose any OpenClaw issues and provide a repair plan.

IMPORTANT: You MUST respond with valid JSON only. No prose, no markdown, no explanation outside the JSON object. Start your response with { and end with }.
`.trim();
  }

  try {
    return await callClawAidAPI(observationData, previousAttempts, round, token);
  } catch (err) {
    // Re-throw PaywallError — don't fall back for paywalled responses
    if (err instanceof PaywallError) throw err;
    const msg = (err as Error).message || String(err);
    // Fallback: try with user's own key if available
    if (apiKey) {
      try {
        const response = await callOpenRouter(apiKey, SYSTEM_PROMPT, userMessage);
        return parseJsonResponse(response);
      } catch {
        // ignore fallback error, throw original
      }
    }
    throw new Error(`Diagnosis failed: ${msg}`);
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
    const looksFixed = response.toLowerCase().includes('"fixed": true') || 
                       response.toLowerCase().includes('"fixed":true');
    return {
      fixed: looksFixed,
      explanation: response.slice(0, 300),
    };
  }
}

export { extractApiKey };
