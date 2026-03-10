import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuleFinding, runRules, formatRuleFindings } from './rules';

const execAsync = promisify(exec);

export interface ObservationResult {
  timestamp: string;
  openclawStatus: string;
  gatewayStatus: string;
  gatewayStatusJson: string;
  configContent: string;
  configPath: string;
  portCheck: string;
  processCheck: string;
  plistContent: string;
  plistPath: string;
  recentLogs: string;
  logPath: string;
  nodeVersion: string;
  npmVersion: string;
  openclawVersion: string;
  systemInfo: string;
  homeDir: string;
  officialDoctorOutput: string;
  desktopAppVersion: string;
  desktopAppRunning: string;
  // v3: new data sources
  devicesList: string;
  sessionIntegrity: string;
  versionGap: string;
  errors: string[];
  ruleFindings?: RuleFinding[];
}

async function runCommand(cmd: string, timeout = 10000): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout,
      shell: os.platform() === 'win32' ? 'cmd.exe' : '/bin/sh',
      env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || '') }
    });
    return (stdout + (stderr ? '\nSTDERR: ' + stderr : '')).trim();
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err && 'stderr' in err) {
      const e = err as { stdout: string; stderr: string; message: string };
      const out = (e.stdout || '').trim();
      const errOut = (e.stderr || '').trim();
      if (out || errOut) {
        return (out + (errOut ? '\nSTDERR: ' + errOut : '')).trim();
      }
    }
    return `[command failed: ${(err as Error).message}]`;
  }
}

async function findRecentLog(): Promise<{ content: string; logPath: string }> {
  const homeDir = os.homedir();
  
  // Check config for custom log path
  let logDir = '/tmp/openclaw';
  let customLogPath = '';
  
  try {
    const configPath = path.join(homeDir, '.openclaw', 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      // Simple JSON5 parsing - look for logging.file
      const logFileMatch = configContent.match(/"?file"?\s*:\s*"([^"]+)"/);
      if (logFileMatch) {
        customLogPath = logFileMatch[1].replace('~', homeDir);
      }
    }
  } catch {
    // ignore
  }

  // Try to find logs
  const possiblePaths = [
    customLogPath,
    '/tmp/openclaw',
    path.join(homeDir, '.openclaw', 'logs'),
    '/var/log/openclaw',
  ].filter(Boolean);

  for (const p of possiblePaths) {
    if (!p || !fs.existsSync(p)) continue;
    
    try {
      const stat = fs.statSync(p);
      if (stat.isFile()) {
        // Direct file path
        const content = fs.readFileSync(p, 'utf-8');
        const lines = content.split('\n');
        const last2000 = lines.slice(-2000).join('\n');
        return { content: last2000, logPath: p };
      } else if (stat.isDirectory()) {
        // Find most recent log file
        const files = fs.readdirSync(p)
          .filter(f => f.endsWith('.log'))
          .map(f => ({
            name: f,
            fullPath: path.join(p, f),
            mtime: fs.statSync(path.join(p, f)).mtime.getTime()
          }))
          .sort((a, b) => b.mtime - a.mtime);
        
        if (files.length > 0) {
          const latestLog = files[0].fullPath;
          const content = fs.readFileSync(latestLog, 'utf-8');
          const lines = content.split('\n');
          const last2000 = lines.slice(-2000).join('\n');
          return { content: last2000, logPath: latestLog };
        }
      }
    } catch {
      continue;
    }
  }

  return { content: '[no log files found]', logPath: '[none]' };
}

async function readPlist(): Promise<{ content: string; plistPath: string }> {
  const homeDir = os.homedir();
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', 'ai.openclaw.gateway.plist');
  
  try {
    if (fs.existsSync(plistPath)) {
      const content = fs.readFileSync(plistPath, 'utf-8');
      return { content, plistPath };
    }
  } catch {
    // ignore
  }
  
  return { content: '[plist not found]', plistPath };
}

async function readConfig(): Promise<{ content: string; configPath: string }> {
  const homeDir = os.homedir();
  const configPath = path.join(homeDir, '.openclaw', 'openclaw.json');
  
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      return { content, configPath };
    }
  } catch {
    // ignore
  }
  
  return { content: '[config file not found - OpenClaw may not be configured]', configPath };
}

export function loadMockObservation(scenario: string): ObservationResult {
  const scenarioPath = path.join(__dirname, '..', 'test-scenarios', scenario + '.json');
  const content = fs.readFileSync(scenarioPath, 'utf-8');
  const obs = JSON.parse(content) as ObservationResult;
  // Backfill v3 fields for older mock scenarios
  if (!obs.devicesList) obs.devicesList = '(not collected)';
  if (!obs.sessionIntegrity) obs.sessionIntegrity = '(not collected)';
  if (!obs.versionGap) obs.versionGap = '(not collected)';
  // Run rules on mock data too
  obs.ruleFindings = runRules(obs);
  return obs;
}

export async function observe(onProgress?: (msg: string) => void): Promise<ObservationResult> {
  const errors: string[] = [];
  const homeDir = os.homedir();

  const progress = (msg: string) => {
    if (onProgress) onProgress(msg);
  };

  progress('Checking OpenClaw status...');
  const openclawStatusRaw = await runCommand('openclaw status 2>&1');
  const openclawStatus = truncate(openclawStatusRaw, 2000);

  progress('Checking gateway status...');
  const gatewayStatus = await runCommand('openclaw gateway status 2>&1');
  const gatewayStatusJson = await runCommand('openclaw gateway status --json 2>&1');

  progress('Running official openclaw doctor...');
  const officialDoctorRaw = await runCommand('openclaw doctor 2>&1', 30000);
  const officialDoctorOutput = truncate(officialDoctorRaw, 3000);

  progress('Reading config file...');
  const { content: configContent, configPath } = await readConfig();

  progress('Checking port 18789...');
  const portCheck = await runCommand('lsof -i :18789 2>&1 || echo "[lsof not available or port not in use]"');

  progress('Checking OpenClaw processes...');
  const processCheck = await runCommand('ps aux | grep -i "[o]penclaw"');

  progress('Reading launch agent plist...');
  const { content: plistContent, plistPath } = await readPlist();

  progress('Finding and reading logs...');
  const { content: recentLogs, logPath } = await findRecentLog();

  progress('Checking Node.js version...');
  const nodeVersion = await runCommand('node -v 2>&1');
  const npmVersion = await runCommand('npm -v 2>&1');

  progress('Checking OpenClaw version...');
  const openclawVersion = await runCommand('openclaw --version 2>&1');

  progress('Checking OpenClaw desktop app...');
  const desktopAppVersion = await runCommand('defaults read /Applications/OpenClaw.app/Contents/Info.plist CFBundleShortVersionString 2>&1');
  const desktopAppRunning = await runCommand('pgrep -f "OpenClaw.app" 2>&1');

  progress('Gathering system info...');
  const systemInfo = await runCommand('sw_vers 2>/dev/null || uname -a');

  // v3: new data sources
  progress('Checking device pairing...');
  const devicesList = await runCommand('openclaw devices list 2>&1');

  progress('Checking session integrity...');
  const sessionDir = path.join(homeDir, '.openclaw', 'sessions');
  let sessionIntegrity = 'no sessions directory';
  try {
    if (fs.existsSync(sessionDir)) {
      const sessionFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith('.json')).slice(-5);
      if (sessionFiles.length === 0) {
        sessionIntegrity = 'sessions directory exists but no .json files';
      } else {
        const checks: string[] = [];
        for (const sf of sessionFiles) {
          try {
            const content = fs.readFileSync(path.join(sessionDir, sf), 'utf-8');
            // Quick integrity check: valid JSON + no orphaned messages
            JSON.parse(content);
            const hasOrphaned = /orphaned/i.test(content);
            checks.push(`${sf}: ${hasOrphaned ? 'ORPHANED MESSAGES DETECTED' : 'ok'}`);
          } catch {
            checks.push(`${sf}: PARSE ERROR`);
          }
        }
        sessionIntegrity = checks.join('\n');
      }
    }
  } catch {
    sessionIntegrity = 'error checking sessions';
  }

  progress('Checking version gap...');
  const latestVersion = await runCommand('npm view openclaw version 2>&1');
  const versionGap = `current: ${openclawVersion} | latest: ${latestVersion}`;

  const obs: ObservationResult = {
    timestamp: new Date().toISOString(),
    openclawStatus,
    gatewayStatus,
    gatewayStatusJson,
    configContent,
    configPath,
    portCheck,
    processCheck,
    plistContent,
    plistPath,
    recentLogs,
    logPath,
    nodeVersion,
    npmVersion,
    openclawVersion,
    systemInfo,
    homeDir,
    officialDoctorOutput,
    desktopAppVersion,
    desktopAppRunning,
    devicesList,
    sessionIntegrity,
    versionGap,
    errors,
  };

  // Run deterministic rule checks
  progress('Running rule checks...');
  obs.ruleFindings = runRules(obs);

  return obs;
}

function extractLogEssentials(logs: string): string {
  if (!logs) return '(no logs)';
  const lines = logs.split('\n');

  // Part 1: Last 50 lines — unfiltered, full context
  const tail = lines.slice(-50);

  // Part 2: Older lines — extract warn/error signals, deduplicated
  const olderLines = lines.slice(0, Math.max(0, lines.length - 50));
  const signalPattern = /error|warn|fail|400|401|403|404|timeout|refused|crash|panic|EADDRINUSE|uncaught|unhandled|FATAL|died|exit code|mismatch|pairing|orphaned|blocked|ENOENT|EACCES|EPERM|deprecat|disconnect|reconnect/i;

  const seen = new Set<string>();
  const uniqueSignals: string[] = [];

  for (const line of olderLines) {
    if (!signalPattern.test(line)) continue;
    // Deduplicate: strip timestamp, compare the rest
    const normalized = line.replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?\s*/, '').trim();
    if (normalized.length < 5) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    uniqueSignals.push(line);
  }

  const parts: string[] = [];

  if (uniqueSignals.length > 0) {
    // Keep up to 30 unique signals (most recent ones)
    const topSignals = uniqueSignals.slice(-30);
    parts.push(`### Unique warn/error signals from older logs (${topSignals.length} unique of ${uniqueSignals.length} total)`);
    parts.push(topSignals.join('\n'));
  }

  parts.push(`### Last 50 lines (unfiltered)`);
  parts.push(tail.join('\n'));

  const result = parts.join('\n\n');
  // Hard cap at 20KB (50 lines ≈ 5KB + 30 signals ≈ 3KB, normally ~8KB)
  return result.length > 20000 ? result.slice(0, 20000) + '\n...[truncated]' : result;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... [truncated, ${text.length - maxChars} chars omitted]`;
}

function redactApiKeys(text: string): string {
  // Redact API keys but keep first 8 chars for identification
  return text.replace(/(sk-or-v1-[a-f0-9]{8})[a-f0-9]+/g, '$1...[REDACTED]')
             .replace(/(sk-[a-zA-Z0-9]{8})[a-zA-Z0-9]+/g, '$1...[REDACTED]');
}

// extractGatewayEssentials and extractConfigEssentials removed in v3.
// AI gets raw data now (only API keys redacted). Don't filter for AI.

export function formatObservation(obs: ObservationResult): string {
  // Give AI ALL the data upfront. This is their evidence to work with.
  // No truncation — Sonnet 4.6 has 200K context, our data is <30K tokens.

  const ruleSection = obs.ruleFindings && obs.ruleFindings.length > 0
    ? formatRuleFindings(obs.ruleFindings)
    : '✅ All rule checks passed — no issues detected by pattern matching.';

  // Detect Windows platform from system info or paths
  const isWindows = os.platform() === 'win32'
    || /windows|win32|win64|\\Users\\/i.test(obs.systemInfo + obs.homeDir + obs.configPath)
    || /Scheduled Task/i.test(obs.gatewayStatus + obs.officialDoctorOutput)
    || /ENOENT.*zsh|spawnSync.*zsh/i.test(obs.gatewayStatus + obs.officialDoctorOutput);

  const platformWarning = isWindows ? `
## ⚠️ PLATFORM: WINDOWS
This is a Windows system. OpenClaw CLI commands like \`openclaw gateway restart\` often fail on Windows with \`spawnSync /bin/zsh ENOENT\`. Use Windows-native equivalents instead — **ClawAid's executor runs commands via cmd.exe so they WILL work**:

| Instead of (fails on Windows) | Use this (works) |
|-------------------------------|------------------|
| \`openclaw gateway restart\` | \`schtasks /run /tn "OpenClaw Gateway"\` or \`node "path\\to\\openclaw\\dist\\index.js" gateway start\` |
| \`openclaw gateway install --force\` | Create Scheduled Task manually or use \`schtasks\` |
| \`openclaw doctor --repair\` | Fix config/directories manually via \`mkdir\`, file edits |
| \`ps aux | grep openclaw\` | \`tasklist /FI "IMAGENAME eq node.exe"\` |
| \`mkdir -p\` | \`mkdir "path"\` (Windows mkdir creates parents by default) |

**You CAN and SHOULD execute fix commands** — they run through cmd.exe, not /bin/zsh. Do NOT just tell the user to run commands manually. Try the fix yourself first.
Config file edits also work on all platforms.
` : '';

  return `
${platformWarning}
## Automated rule checks (deterministic, code-verified)
${ruleSection}

## System info
Timestamp: ${obs.timestamp}
OpenClaw version: ${obs.openclawVersion}
Node: ${obs.nodeVersion} | npm: ${obs.npmVersion}
Desktop app version: ${obs.desktopAppVersion}
Desktop app running: ${obs.desktopAppRunning}
System: ${obs.systemInfo}

## Gateway status
${obs.gatewayStatus}

## Gateway status (JSON)
${redactApiKeys(obs.gatewayStatusJson)}

## Official openclaw doctor output
${obs.officialDoctorOutput}

## Config file (${obs.configPath})
${redactApiKeys(obs.configContent)}

## LaunchAgent plist (${obs.plistPath})
${obs.plistContent}

## Device pairing
${obs.devicesList}

## Session integrity
${obs.sessionIntegrity}

## Version gap
${obs.versionGap}

## Port 18789 check
${obs.portCheck}

## OpenClaw processes
${obs.processCheck}

## Recent logs (${obs.logPath})
${extractLogEssentials(obs.recentLogs)}
`.trim();
}
