#!/usr/bin/env node

import * as http from 'http';
import { createServer } from './server';

// Find a free port
async function findFreePort(start = 7357): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(start, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      resolve(findFreePort(start + 1));
    });
  });
}

async function openBrowser(url: string): Promise<void> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  const platform = process.platform;
  let cmd: string;

  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  try {
    await execAsync(cmd);
  } catch {
    console.log(`Please open your browser to: ${url}`);
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  
  console.log('\n🩺 ClawAid\n');
  if (dryRun) console.log('⚠️  DRY-RUN mode: fixes will NOT be executed\n');
  console.log('Finding available port...');
  
  // Export dry-run flag so server can access it
  (global as Record<string, unknown>).__clawaid_dry_run = dryRun;
  
  const port = await findFreePort(7357);
  const url = `http://127.0.0.1:${port}`;
  
  console.log('Starting diagnostic server...');
  await createServer(port);
  
  console.log(`\n✓ Server running at ${url}`);
  console.log('Opening browser...\n');
  
  // Small delay to ensure server is ready
  await new Promise(resolve => setTimeout(resolve, 300));
  await openBrowser(url);
  
  console.log('ClawAid is running. Press Ctrl+C to stop.\n');
  
  // Keep process alive
  process.on('SIGINT', () => {
    console.log('\nShutting down ClawAid...');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start ClawAid:', err);
  process.exit(1);
});
