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

// ─── High Rules ──────────────────────────────────────────────────────────────

const zombieGateway: Rule = (obs) => {
  const status = obs.gatewayStatus || '';
  const lower = status.toLowerCase();

  const isRunning = lower.includes('running') && !lower.includes('not running');
  const probeFailed = lower.includes('rpc probe: failed') || lower.includes('timeout');

  if (isRunning && probeFailed) {
    return [{
      id: 'zombie-gateway',
      severity: 'high',
      title: 'Gateway process is alive but unresponsive (zombie)',
      description:
        'The gateway process is listed as running, but the RPC health probe failed or timed out. ' +
        'The gateway is in a zombie state and needs to be restarted.',
      fix: 'openclaw gateway restart',
    }];
  }
  return [];
};

const badModel: Rule = (obs) => {
  const logs = obs.recentLogs || '';

  // Count occurrences of 400 Bad Request or model not found
  const badRequestMatches = logs.match(/400\s*(Bad Request)?/gi) || [];
  const modelNotFoundMatches = logs.match(/model[\s_-]?not[\s_-]?found/gi) || [];
  const totalErrors = badRequestMatches.length + modelNotFoundMatches.length;

  if (totalErrors >= 2) {
    // Try to extract model name
    let modelName = '';
    const modelMatch = logs.match(/model[:\s]+["']?([a-zA-Z0-9\/_.-]+)["']?\s*(not found|is not available|does not exist)/i);
    if (modelMatch) {
      modelName = modelMatch[1];
    }

    return [{
      id: 'bad-model',
      severity: 'high',
      title: 'AI model errors detected' + (modelName ? ` (${modelName})` : ''),
      description:
        `Found ${totalErrors} "400 Bad Request" or "model not found" errors in recent logs. ` +
        (modelName
          ? `The model "${modelName}" may be unavailable, deprecated, or misspelled.`
          : 'The configured default model may be unavailable, deprecated, or misspelled.'),
      fix: modelName
        ? `openclaw models set default anthropic/claude-sonnet-4-6`
        : `openclaw models set default anthropic/claude-sonnet-4-6`,
    }];
  }
  return [];
};

const gatewayAuthConflict: Rule = (obs) => {
  const config = obs.configContent || '';

  // Check if config has gateway.auth section with both token and password but no mode
  // Look for the auth section pattern
  const authSectionMatch = config.match(/["']?auth["']?\s*:\s*\{([^}]*)\}/s);
  if (authSectionMatch) {
    const authSection = authSectionMatch[1];
    const hasToken = /["']?token["']?\s*:/i.test(authSection);
    const hasPassword = /["']?password["']?\s*:/i.test(authSection);
    const hasMode = /["']?mode["']?\s*:/i.test(authSection);

    if (hasToken && hasPassword && !hasMode) {
      return [{
        id: 'gateway-auth-conflict',
        severity: 'high',
        title: 'Gateway auth conflict: both token and password configured',
        description:
          'The gateway auth section has both "token" and "password" but no explicit "mode". ' +
          'In OpenClaw v3.7, this is a breaking change — the gateway won\'t know which auth method to use ' +
          'and may reject all connections.',
        fix: 'openclaw config set gateway.auth.mode token',
      }];
    }
  }
  return [];
};

// ─── Warning Rules ───────────────────────────────────────────────────────────

const versionMismatch: Rule = (obs) => {
  const desktopVer = obs.desktopAppVersion || '';
  const cliVer = obs.openclawVersion || '';

  // Extract version numbers (e.g., "3.7.1" or "2026.2.22")
  const desktopMatch = desktopVer.match(/(\d+)\.(\d+)\.?(\d*)/);
  const cliMatch = cliVer.match(/(\d+)\.(\d+)\.?(\d*)/);

  if (desktopMatch && cliMatch) {
    const dMajor = parseInt(desktopMatch[1], 10);
    const dMinor = parseInt(desktopMatch[2], 10);
    const cMajor = parseInt(cliMatch[1], 10);
    const cMinor = parseInt(cliMatch[2], 10);

    // Flag if major versions differ, or minor versions differ by 2+
    const majorDiff = Math.abs(dMajor - cMajor);
    const minorDiff = Math.abs(dMinor - cMinor);

    if (majorDiff > 0 || minorDiff >= 2) {
      return [{
        id: 'version-mismatch',
        severity: 'warning',
        title: 'Desktop app and CLI version mismatch',
        description:
          `Desktop app version (${desktopVer.trim()}) and CLI version (${cliVer.trim()}) differ significantly. ` +
          'This can cause compatibility issues. Consider updating the older one.',
      }];
    }
  }
  return [];
};

const whatsappAllowlistEmpty: Rule = (obs) => {
  const config = obs.configContent || '';

  // Check for groupPolicy: "allowlist" 
  const hasAllowlist = /["']?groupPolicy["']?\s*:\s*["']allowlist["']/i.test(config);
  if (hasAllowlist) {
    // Check if groupAllowFrom is empty/missing
    const allowFromMatch = config.match(/["']?groupAllowFrom["']?\s*:\s*\[([^\]]*)\]/);
    if (!allowFromMatch || allowFromMatch[1].trim() === '') {
      return [{
        id: 'whatsapp-allowlist-empty',
        severity: 'warning',
        title: 'WhatsApp groupPolicy is "allowlist" but no groups are allowed',
        description:
          'The WhatsApp channel has groupPolicy set to "allowlist", but groupAllowFrom is empty or missing. ' +
          'This means the bot will ignore ALL group messages. If you want to receive group messages, ' +
          'add group IDs to groupAllowFrom, or change groupPolicy to "all".',
      }];
    }
  }
  return [];
};

// ─── Rule Engine ─────────────────────────────────────────────────────────────

const ALL_RULES: Rule[] = [
  // Critical
  toolsProfileMessaging,
  proxyInPlist,
  configParseError,
  gatewayNotRunning,
  portConflict,
  // High
  zombieGateway,
  badModel,
  gatewayAuthConflict,
  // Warning
  versionMismatch,
  whatsappAllowlistEmpty,
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
    return `=== AUTOMATED RULE CHECKS (deterministic, pre-AI) ===
[No known issues detected by rule engine]
=== END RULE CHECKS ===`;
  }

  const severityEmoji: Record<string, string> = {
    critical: '🔴 CRITICAL',
    high: '🟠 HIGH',
    warning: '⚠️ WARNING',
    info: 'ℹ️ INFO',
  };

  const lines: string[] = [
    '=== AUTOMATED RULE CHECKS (deterministic, pre-AI) ===',
    '[These findings are 100% certain — verified by code, not AI inference]',
    '',
  ];

  for (const f of findings) {
    lines.push(`${severityEmoji[f.severity] || f.severity.toUpperCase()}: ${f.title}`);
    lines.push(`   ${f.description}`);
    if (f.fix) {
      lines.push(`   Fix: ${f.fix}`);
    }
    lines.push('');
  }

  lines.push('=== END RULE CHECKS ===');

  return lines.join('\n');
}
