import express, { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { DoctorLoop, LoopEvent } from './loop';

const app = express();
app.use(express.json());

// In-memory token store (per server process)
let verifiedToken: string | undefined;

// ClawAid backend base URL
const CLAWAID_API = process.env.CLAWAID_API || 'https://api.clawaid.app';

// Serve the web UI
app.get('/', (_req: Request, res: Response) => {
  const htmlPath = path.join(__dirname, '..', 'web', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(404).send('Web UI not found. Please ensure web/index.html exists.');
  }
});

// SSE endpoint - main diagnostic stream
const activeSessions = new Map<string, { res: Response; loop: DoctorLoop }>();

app.get('/api/diagnose', (req: Request, res: Response) => {
  const sessionId = Date.now().toString();
  
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const sendEvent = (type: string, data: unknown) => {
    const json = JSON.stringify({ type, data, sessionId });
    res.write(`data: ${json}\n\n`);
  };

  const loop = new DoctorLoop((event: LoopEvent) => {
    sendEvent(event.type, event.data);
  });

  // Restore verified token if available
  if (verifiedToken) {
    loop.setToken(verifiedToken);
  }

  activeSessions.set(sessionId, { res, loop });

  // Send session ID to client
  sendEvent('session_start', { sessionId });

  // Start diagnosis
  loop.start().catch((err: Error) => {
    sendEvent('error', { message: err.message });
  });

  // Handle client disconnect
  req.on('close', () => {
    loop.stop();
    activeSessions.delete(sessionId);
  });
});

// Endpoint to provide user input (e.g., API key, user description)
app.post('/api/input', (req: Request, res: Response) => {
  const { sessionId, field, value, screenshot } = req.body as { sessionId: string; field: string; value: string; screenshot?: string };
  
  const session = activeSessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  
  session.loop.provideInput(field, value, screenshot ? { screenshot } : undefined).catch((err: Error) => {
    console.error('Error providing input:', err);
  });
  
  res.json({ ok: true });
});

// Endpoint to confirm or skip a medium/high-risk step
app.post('/api/confirm', (req: Request, res: Response) => {
  const { sessionId, confirmed } = req.body as { sessionId: string; confirmed: boolean };
  const session = activeSessions.get(sessionId);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  session.loop.confirmStep(confirmed).catch((err: Error) => { console.error('Error confirming step:', err); });
  res.json({ ok: true });
});

// Legacy /api/fix endpoint — no-op in new design (loop runs automatically)
app.post('/api/fix', (req: Request, res: Response) => {
  res.json({ ok: true });
});

// Redeem token — calls backend /redeem and caches validated token
app.post('/api/redeem', (req: Request, res: Response) => {
  const { token } = req.body as { token: string };
  if (!token || typeof token !== 'string' || !token.trim()) {
    res.status(400).json({ valid: false, error: 'token required' });
    return;
  }

  const body = JSON.stringify({ token: token.trim() });
  const url = new URL(`${CLAWAID_API}/redeem`);
  const options = {
    hostname: url.hostname,
    port: url.port ? parseInt(url.port) : 443,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const request = https.request(options, (backendRes) => {
    let data = '';
    backendRes.on('data', (chunk) => { data += chunk; });
    backendRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.valid) {
          // Cache the token for this server process
          verifiedToken = token.trim();
          // Also propagate to any active sessions
          activeSessions.forEach(({ loop }) => {
            loop.setToken(token.trim());
          });
        }
        res.json({ valid: Boolean(parsed.valid), credits: parsed.credits || 0 });
      } catch {
        res.status(500).json({ valid: false, error: 'Failed to parse backend response' });
      }
    });
  });

  request.on('error', (err) => {
    res.status(500).json({ valid: false, error: err.message });
  });
  request.setTimeout(15000, () => {
    request.destroy();
    res.status(504).json({ valid: false, error: 'Redeem request timed out' });
  });
  request.write(body);
  request.end();
});

// Health check
app.post('/api/feedback', (req: Request, res: Response) => {
  const { feedback, sessionId: sid } = req.body || {};
  // Forward feedback to ClawAid backend
  const https = require('https');
  const body = JSON.stringify({ feedback, sessionId: sid, fingerprint: require('./diagnose').getMachineFingerprint() });
  const fReq = https.request({
    hostname: 'api.clawaid.app',
    path: '/feedback',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, () => {});
  fReq.on('error', () => {});
  fReq.write(body);
  fReq.end();
  res.json({ ok: true });
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, version: '1.0.0', name: 'ClawAid', sessions: activeSessions.size });
});

export function createServer(port: number): Promise<void> {
  return new Promise((resolve) => {
    app.listen(port, '127.0.0.1', () => {
      console.log(`🩺 ClawAid running at http://127.0.0.1:${port}`);
      resolve();
    });
  });
}

export default app;
