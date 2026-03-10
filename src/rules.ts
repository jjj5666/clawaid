import { ObservationResult } from './observe';

export interface RuleFinding {
  id: string;
  severity: 'critical' | 'high' | 'warning' | 'info';
  title: string;
  description: string;
  fix?: string;
}

type Rule = (obs: ObservationResult) => RuleFinding[];

// ─── Critical Rules ──────────────────────────────────────────────────────────

const toolsProfileMessaging: Rule = (obs) => {
  const config = obs.configContent || '';
  // Match "profile": "messaging" or profile: "messaging" within a tools section context
  // Also handle JSON5 unquoted keys
  if (/["']?profile["']?\s*:\s*["']messaging["']/i.test(config)) {
    // Verify it's plausibly in a tools section (look for "tools" nearby)
    const toolsIdx = config.search(/["']?tools["']?\s*:/i);
    const profileIdx = config.search(/["']?profile["']?\s*:\s*["']messaging["']/i);
    // If there's a tools section and the profile is anywhere in config, flag it.
    // Even without a tools section wrapper, "profile": "messaging" is the issue.
    if (toolsIdx !== -1 || profileIdx !== -1) {
      return [{
        id: 'tools-profile-messaging',
        severity: 'critical',
        title: 'Tools restricted to messaging-only mode',
        description:
          'Your agent can chat but cannot execute commands, read files, or use any tools. ' +
          'This is the #1 issue after upgrading to OpenClaw v3.7 — the default changed from \'coding\' to \'messaging\'.',
        fix: 'openclaw config set tools.profile full && openclaw gateway restart',
      }];
    }
  }
  return [];
};

const proxyInPlist: Rule = (obs) => {
  const plist = obs.plistContent || '';
  const hasProxy = /HTTP_PROXY|HTTPS_PROXY/i.test(plist);
  if (hasProxy) {
    return [{
      id: 'proxy-in-plist',
      severity: 'critical',
      title: 'Proxy configuration in LaunchAgent will cause outage',
      description:
        'The LaunchAgent plist contains HTTP_PROXY or HTTPS_PROXY environment variables. ' +
        'This is a ticking time bomb: the gateway will fail to connect to AI providers on the next restart ' +
        'because traffic will be routed through a proxy that likely doesn\'t exist or blocks API calls. ' +
        'Remove these entries immediately.',
      fix:
        '/usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:HTTP_PROXY" ~/Library/LaunchAgents/ai.openclaw.gateway.plist 2>/dev/null; ' +
        '/usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:HTTPS_PROXY" ~/Library/LaunchAgents/ai.openclaw.gateway.plist 2>/dev/null; ' +
        'openclaw gateway restart',
    }];
  }
  return [];
};

const configParseError: Rule = (obs) => {
  const config = obs.configContent || '';
  const logs = obs.recentLogs || '';

  // Config is empty/missing
  if (!config || config === '[config file not found - OpenClaw may not be configured]') {
    return [{
      id: 'config-parse-error',
      severity: 'critical',
      title: 'Config file missing or empty',
      description:
        'The OpenClaw config file (~/.openclaw/openclaw.json) is missing or could not be read. ' +
        'The gateway cannot start without a valid config.',
      fix: 'openclaw doctor --yes',
    }];
  }

  // JSON5 syntax error in logs
  if (/SyntaxError/i.test(logs) && /JSON5/i.test(logs)) {
    return [{
      id: 'config-parse-error',
      severity: 'critical',
      title: 'Config file corrupted or has syntax error',
      description:
        'The gateway logs show a JSON5 SyntaxError when parsing the config file. ' +
        'The config has invalid syntax and the gateway cannot load it.',
      fix: 'cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.broken && openclaw doctor --yes',
    }];
  }

  return [];
};

const gatewayNotRunning: Rule = (obs) => {
  const status = obs.gatewayStatus || '';
  const lower = status.toLowerCase();

  if (lower.includes('not running') && !lower.includes('config')) {
    return [{
      id: 'gateway-not-running',
      severity: 'critical',
      title: 'Gateway is not running',
      description:
        'The OpenClaw gateway service is stopped. No AI interactions will work until it is started.',
      fix: 'openclaw gateway start',
    }];
  }
  return [];
};

const portConflict: Rule = (obs) => {
  const status = obs.gatewayStatus || '';
  const logs = obs.recentLogs || '';
  const combined = status + '\n' + logs;

  if (/EADDRINUSE/i.test(combined)) {
    // Try to extract PID from portCheck
    let pidInfo = '';
    const portCheck = obs.portCheck || '';
    // lsof output: lines after header, PID is second column
    const lines = portCheck.split('\n').filter(l => l.trim() && !l.startsWith('COMMAND'));
    if (lines.length > 0) {
      const parts = lines[0].trim().split(/\s+/);
      if (parts.length >= 2) {
        pidInfo = ` (conflicting process: ${parts[0]} PID ${parts[1]})`;
      }
    }

    return [{
      id: 'port-conflict',
      severity: 'critical',
      title: 'Port 18789 is already in use',
      description:
        `Another process is occupying port 18789${pidInfo}. ` +
        'The gateway cannot bind to its default port and will fail to start.',
      fix: pidInfo
        ? `kill ${lines[0]?.trim().split(/\s+/)[1] || ''} 2>/dev/null; sleep 1; openclaw gateway restart`
        : 'lsof -ti :18789 | xargs kill 2>/dev/null; sleep 1; openclaw gateway restart',
    }];
  }
  return [];
};

// v3: Only 6 rules — high-confidence, deterministic checks.
// Everything uncertain goes to AI with full data. Rules are accelerators, not gatekeepers.

const nodeTooOld: Rule = (obs) => {
  const nodeVer = obs.nodeVersion || '';
  const match = nodeVer.match(/v?(\d+)\./);
  if (match) {
    const major = parseInt(match[1], 10);
    if (major < 18) {
      return [{
        id: 'node-too-old',
        severity: 'critical',
        title: `Node.js ${nodeVer.trim()} is too old — CLI will not work`,
        description:
          `OpenClaw requires Node.js 18 or newer. Your current version (${nodeVer.trim()}) ` +
          'is not supported. The CLI will fail with syntax errors or missing APIs.',
        fix: 'curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts && fnm use lts-latest',
      }];
    }
  }
  return [];
};

const tokenMismatch: Rule = (obs) => {
  const logs = obs.recentLogs || '';
  if (/token_mismatch/i.test(logs)) {
    return [{
      id: 'token-mismatch',
      severity: 'high',
      title: 'WebUI token mismatch detected',
      description:
        'Logs show token_mismatch errors — the WebUI is using a stale token. ' +
        'This often happens after a force restart.',
      fix: 'openclaw gateway restart',
    }];
  }
  return [];
};

// ─── Rule Engine ─────────────────────────────────────────────────────────────

const ALL_RULES: Rule[] = [
  // 6 deterministic rules — 100% confidence, no guessing
  gatewayNotRunning,     // process not running → start it
  portConflict,          // EADDRINUSE → kill conflicting process
  configParseError,      // JSON parse error → fix config
  nodeTooOld,            // Node < 18 → upgrade
  proxyInPlist,          // proxy in plist → remove it (may be intentional, but flag it)
  tokenMismatch,         // token_mismatch in logs → restart gateway
  // Removed: toolsProfileMessaging, zombieGateway, badModel, gatewayAuthConflict,
  // recentAuthFailure, providerMissingKey, recentTimeoutLoop, fallbackNotAvailable,
  // versionMismatch, whatsappAllowlistEmpty
  // → AI has full data and can detect these better than regex pattern matching
];

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  warning: 2,
  info: 3,
};

export function runRules(obs: ObservationResult): RuleFinding[] {
  const findings: RuleFinding[] = [];

  for (const rule of ALL_RULES) {
    try {
      const results = rule(obs);
      findings.push(...results);
    } catch {
      // Individual rule failure should not break the engine
    }
  }

  // Sort by severity: critical first, then high, warning, info
  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99));

  return findings;
}

export function formatRuleFindings(findings: RuleFinding[]): string {
  if (findings.length === 0) {
    return `=== PRE-SCAN HINTS ===
[No obvious issues detected by pattern matching]
Note: These are hints only. Use your own judgment — check timestamps, recent successes, and live status before concluding.
=== END HINTS ===`;
  }

  const severityLabel: Record<string, string> = {
    critical: 'Likely issue',
    high: 'Possible issue',
    warning: 'Note',
    info: 'FYI',
  };

  const lines: string[] = [
    '=== PRE-SCAN HINTS (pattern-matched, may be stale — verify before acting) ===',
    '',
  ];

  for (const f of findings) {
    lines.push(`${severityLabel[f.severity] || 'Note'}: ${f.title}`);
    lines.push(`   ${f.description}`);
    if (f.fix) {
      lines.push(`   Possible fix (verify first): ${f.fix}`);
    }
    lines.push('');
  }

  lines.push('IMPORTANT: These hints are based on pattern matching of logs and config.');
  lines.push('They may flag issues that have already been fixed. Always verify with live checks');
  lines.push('(e.g., openclaw gateway status, openclaw models status) before proposing a fix.');
  lines.push('=== END HINTS ===');

  return lines.join('\n');
}
