import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DiagnosticAction } from './diagnose';

const execAsync = promisify(exec);

export interface ActionResult {
  action: DiagnosticAction;
  success: boolean;
  output: string;
  error?: string;
  backupPath?: string;
}

export interface ExecuteResult {
  results: ActionResult[];
  allSucceeded: boolean;
  summary: string;
}

async function runCommand(cmd: string, timeout = 30000): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout,
      env: { 
        ...process.env, 
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || ''),
        HOME: os.homedir(),
      }
    });
    const output = (stdout + (stderr ? '\n' + stderr : '')).trim();
    return { success: true, output: output || '[command completed with no output]' };
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err && 'stderr' in err) {
      const e = err as { stdout: string; stderr: string; message: string; code?: number };
      const out = (e.stdout || '').trim();
      const errOut = (e.stderr || '').trim();
      const combined = [out, errOut].filter(Boolean).join('\n');
      // Some commands return non-zero but still succeed (e.g., kill when process doesn't exist)
      return { success: false, output: combined || e.message, error: e.message };
    }
    return { success: false, output: '', error: (err as Error).message };
  }
}

async function backupFile(filePath: string): Promise<string> {
  const expandedPath = filePath.replace('~', os.homedir());
  const backupPath = expandedPath + '.bak.' + Date.now();
  
  if (fs.existsSync(expandedPath)) {
    fs.copyFileSync(expandedPath, backupPath);
    return backupPath;
  }
  
  return '';
}

export async function executeActions(
  actions: DiagnosticAction[],
  onProgress?: (msg: string, result?: ActionResult) => void
): Promise<ExecuteResult> {
  const results: ActionResult[] = [];
  
  const progress = (msg: string, result?: ActionResult) => {
    if (onProgress) onProgress(msg, result);
  };

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    progress(`Step ${i + 1}/${actions.length}: ${action.description}`);
    
    let backupPath: string | undefined;
    
    // Backup file if needed
    if (action.type === 'file_edit' && action.backup) {
      try {
        progress(`  → Creating backup...`);
        const backupCmd = action.backup.replace('~', os.homedir());
        
        // Extract file path from backup command or action command
        const fileMatch = action.command.match(/['"]?([~\/][^'"]+)['"]?/);
        if (fileMatch) {
          backupPath = await backupFile(fileMatch[1]);
          if (backupPath) {
            progress(`  → Backed up to: ${backupPath}`);
          }
        }
      } catch (e) {
        progress(`  → Backup warning: ${(e as Error).message}`);
      }
    }
    
    // Execute the command
    progress(`  → Running: ${action.command}`);
    const { success, output, error } = await runCommand(action.command);
    
    const result: ActionResult = {
      action,
      success,
      output,
      error,
      backupPath,
    };
    
    results.push(result);
    progress(`  → ${success ? '✓ Success' : '✗ Failed'}: ${output.slice(0, 200)}`, result);
    
    // If a high-risk action fails, stop
    if (!success && action.risk === 'high') {
      progress(`High-risk action failed, stopping execution for safety.`);
      break;
    }
    
    // Small delay between actions
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  const allSucceeded = results.length > 0 && results.every(r => r.success);
  const successCount = results.filter(r => r.success).length;
  const summary = `Executed ${results.length} actions: ${successCount} succeeded, ${results.length - successCount} failed`;
  
  return { results, allSucceeded, summary };
}

export function formatExecuteResults(results: ActionResult[]): string {
  return results.map((r, i) => {
    const status = r.success ? '✓' : '✗';
    return `${status} Step ${i + 1}: ${r.action.description}
  Command: ${r.action.command}
  Output: ${r.output.slice(0, 300)}${r.error ? `\n  Error: ${r.error}` : ''}${r.backupPath ? `\n  Backup: ${r.backupPath}` : ''}`;
  }).join('\n\n');
}
