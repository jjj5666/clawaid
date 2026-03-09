import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
  errors: string[];
}

async function runCommand(cmd: string, timeout = 10000): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout,
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
        const last200 = lines.slice(-200).join('\n');
        return { content: last200, logPath: p };
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
          const last200 = lines.slice(-200).join('\n');
          return { content: last200, logPath: latestLog };
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

  return {
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
    errors,
  };
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

function extractGatewayEssentials(statusJson: string): string {
  // Try to parse and extract only diagnostically relevant fields
  try {
    const parsed = JSON.parse(statusJson);
    const essentials: Record<string, unknown> = {};
    // Keep only diagnostic fields, skip session data
    for (const key of ['runtime', 'gateway', 'version', 'pid', 'uptime', 'mode', 'status', 'error', 'errors', 'channels', 'channelSummary', 'heartbeat']) {
      if (key in parsed) essentials[key] = parsed[key];
    }
    return JSON.stringify(essentials, null, 2);
  } catch {
    return truncate(statusJson, 3000);
  }
}

function extractConfigEssentials(configContent: string): string {
  // Try to parse and extract only diagnostically relevant fields (no sessions, no API keys in full)
  try {
    const parsed = JSON.parse(configContent);
    const essentials: Record<string, unknown> = {};
    // Keep structure but remove large/sensitive data
    for (const key of ['gateway', 'models', 'channels', 'tools', 'security', 'logging', 'agent']) {
      if (key in parsed) essentials[key] = parsed[key];
    }
    // Include provider names but redact keys
    if (parsed.providers) {
      const providers: Record<string, unknown> = {};
      for (const [name, val] of Object.entries(parsed.providers as Record<string, unknown>)) {
        if (val && typeof val === 'object') {
          const p = { ...(val as Record<string, unknown>) };
          if (p.apiKey && typeof p.apiKey === 'string') {
            p.apiKey = (p.apiKey as string).slice(0, 12) + '...[REDACTED]';
          }
          providers[name] = p;
        }
      }
      essentials.providers = providers;
    }
    return JSON.stringify(essentials, null, 2);
  } catch {
    return truncate(redactApiKeys(configContent), 4000);
  }
}

export function formatObservation(obs: ObservationResult): string {
  return `
=== CLAWAID OBSERVATION ===
Timestamp: ${obs.timestamp}
Home: ${obs.homeDir}

--- OFFICIAL openclaw doctor output (IMPORTANT - check this first) ---
${truncate(obs.officialDoctorOutput, 3000)}

--- Desktop App ---
Version: ${obs.desktopAppVersion}
Running (pgrep): ${obs.desktopAppRunning}

--- openclaw status (text, truncated) ---
${truncate(obs.openclawStatus, 2000)}

--- openclaw gateway status ---
${truncate(obs.gatewayStatus, 3000)}

--- openclaw gateway status (json, essentials) ---
${extractGatewayEssentials(obs.gatewayStatusJson)}

--- config essentials: ${obs.configPath} ---
${extractConfigEssentials(obs.configContent)}

--- port 18789 check ---
${truncate(obs.portCheck, 1000)}

--- openclaw processes ---
${truncate(obs.processCheck, 1000)}

--- launch agent plist: ${obs.plistPath} ---
${truncate(obs.plistContent, 2000)}

--- recent logs (last 50 lines): ${obs.logPath} ---
${truncate(obs.recentLogs.split('\n').slice(-50).join('\n'), 5000)}

--- runtime versions ---
node: ${obs.nodeVersion}
npm: ${obs.npmVersion}
openclaw: ${obs.openclawVersion}

--- system info ---
${obs.systemInfo}
`.trim();
}
