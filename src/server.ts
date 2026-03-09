import express, { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { DoctorLoop, LoopEvent } from './loop';

const app = express();
app.use(express.json());

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

// Endpoint to provide user input (e.g., API key)
app.post('/api/input', (req: Request, res: Response) => {
  const { sessionId, field, value } = req.body as { sessionId: string; field: string; value: string };
  
  const session = activeSessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  
  session.loop.provideInput(field, value).catch((err: Error) => {
    console.error('Error providing input:', err);
  });
  
  res.json({ ok: true });
});

// Endpoint to trigger fix after user clicks "Fix" button
// Accepts optional optionId ("A", "B", "C") — defaults to recommended option
app.post('/api/fix', (req: Request, res: Response) => {
  const { sessionId, optionId } = req.body as { sessionId: string; optionId?: string };
  
  const session = activeSessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  
  session.loop.startFix(optionId).catch((err: Error) => {
    console.error('Error starting fix:', err);
  });
  
  res.json({ ok: true });
});

// Health check
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
