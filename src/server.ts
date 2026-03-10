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
  const lang = (req.query.lang as string) || 'en';
  
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

  // SSE keepalive — send a comment every 15s to prevent browsers/proxies from closing idle connections
  const heartbeatTimer = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch {}
  }, 15000);

  const loop = new DoctorLoop((event: LoopEvent) => {
    sendEvent(event.type, event.data);
  });

  // Set language and restore verified token if available
  loop.setLang(lang);
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
    clearInterval(heartbeatTimer);
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
          // Use the real CA-XXXX token returned by Worker (not the user's input which might be an email)
          const realToken = parsed.token || token.trim();
          // Cache the token for this server process
          verifiedToken = realToken;
          // Also propagate to any active sessions
          activeSessions.forEach(({ loop }) => {
            loop.setToken(realToken);
          });
        }
        res.json({ valid: Boolean(parsed.valid), credits: parsed.credits || 0, token: parsed.token || undefined });
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

// Feedback — forward to backend with fingerprint
app.post('/api/feedback', (req: Request, res: Response) => {
  const { feedback, sessionId: sid, sbSessionId } = req.body || {};
  const https = require('https');
  const body = JSON.stringify({
    feedback,
    sessionId: sid,
    sbSessionId,
    fingerprint: require('./diagnose').getMachineFingerprint(),
  });
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

// Forward analytics event to Worker (fire-and-forget)
app.post('/api/event', (req: Request, res: Response) => {
  const { event, data, ts, sessionId: sid } = req.body || {};
  const fingerprint = require('./diagnose').getMachineFingerprint();
  const body = JSON.stringify({
    fingerprint,
    sessionId: sid || undefined,
    event,
    data: data || {},
    clientTs: ts ? new Date(ts).toISOString() : new Date().toISOString(),
  });
  const url = new URL(`${CLAWAID_API}/event`);
  const lib = url.protocol === 'http:' ? require('http') : require('https');
  const options = {
    hostname: url.hostname,
    port: url.port ? parseInt(url.port) : (url.protocol === 'http:' ? 80 : 443),
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  const fReq = lib.request(options, () => {});
  fReq.on('error', () => {});
  fReq.write(body);
  fReq.end();
  res.json({ ok: true });
});

// Waitlist proxy
app.post('/api/waitlist', (req: Request, res: Response) => {
  const { email } = req.body || {};
  const fingerprint = require('./diagnose').getMachineFingerprint();
  const body = JSON.stringify({ email, fingerprint });
  const url = new URL(`${CLAWAID_API}/waitlist`);
  const lib = url.protocol === 'http:' ? require('http') : require('https');
  const fReq = lib.request({
    hostname: url.hostname,
    port: url.port ? parseInt(url.port) : (url.protocol === 'http:' ? 80 : 443),
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (fRes: any) => {
    let d = '';
    fRes.on('data', (c: string) => { d += c; });
    fRes.on('end', () => { try { res.json(JSON.parse(d)); } catch { res.json({ ok: true }); } });
  });
  fReq.on('error', () => res.json({ ok: true }));
  fReq.write(body);
  fReq.end();
});

// Poll endpoint — frontend checks if a token was created for this machine's fingerprint
// Used after Stripe payment: frontend polls until a token is found, then auto-activates
app.get('/api/poll-token', (_req: Request, res: Response) => {
  const fingerprint = require('./diagnose').getMachineFingerprint();
  const url = new URL(`${CLAWAID_API}/poll/${fingerprint}`);
  const lib = url.protocol === 'http:' ? require('http') : require('https');
  const options = {
    hostname: url.hostname,
    port: url.port ? parseInt(url.port) : (url.protocol === 'http:' ? 80 : 443),
    path: url.pathname,
    method: 'GET',
  };
  const request = lib.request(options, (backendRes: any) => {
    let data = '';
    backendRes.on('data', (chunk: string) => { data += chunk; });
    backendRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.found && parsed.token) {
          // Auto-activate: cache the token and propagate to active sessions
          verifiedToken = parsed.token;
          activeSessions.forEach(({ loop }) => { loop.setToken(parsed.token); });
        }
        res.json(parsed);
      } catch {
        res.json({ found: false });
      }
    });
  });
  request.on('error', () => { res.json({ found: false }); });
  request.setTimeout(10000, () => { request.destroy(); res.json({ found: false }); });
  request.end();
});

// Lookup endpoint — proxy to Worker /lookup to find token by email
app.post('/api/lookup', (req: Request, res: Response) => {
  const { email } = req.body as { email: string };
  if (!email) { res.status(400).json({ found: false }); return; }
  const body = JSON.stringify({ email });
  const url = new URL(`${CLAWAID_API}/lookup`);
  const lib = url.protocol === 'http:' ? require('http') : require('https');
  const options = {
    hostname: url.hostname,
    port: url.port ? parseInt(url.port) : (url.protocol === 'http:' ? 80 : 443),
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  const request = lib.request(options, (backendRes: any) => {
    let data = '';
    backendRes.on('data', (chunk: string) => { data += chunk; });
    backendRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.found && parsed.token) {
          // Auto-activate the token
          verifiedToken = parsed.token;
          activeSessions.forEach(({ loop }) => { loop.setToken(parsed.token); });
        }
        res.json(parsed);
      } catch {
        res.json({ found: false });
      }
    });
  });
  request.on('error', () => { res.json({ found: false }); });
  request.setTimeout(10000, () => { request.destroy(); res.json({ found: false }); });
  request.write(body);
  request.end();
});

// (duplicate /api/event route removed — handled above)

// Return machine fingerprint so frontend can include it in Stripe payment link
app.get('/api/fingerprint', (_req: Request, res: Response) => {
  res.json({ fingerprint: require('./diagnose').getMachineFingerprint() });
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, version: '1.1.28', name: 'ClawAid', sessions: activeSessions.size });
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
