import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { config } from './config';
import { CallSession } from './twilio/session';
import { handleIncomingSms } from './sms/handler';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    vadThreshold: config.vad.confidenceThreshold,
    holdOffMs: config.vad.holdOffMs,
    silenceMs: config.vad.silenceMs,
    rnnoiseEnabled: config.rnnoise.enabled,
  });
});

// SMS webhook — Twilio sends POST when SMS is received
app.post('/sms', (req, res) => {
  const from = req.body?.From ?? '';
  const to = req.body?.To ?? '';
  const body = req.body?.Body ?? '';

  // Respond with empty TwiML immediately so Twilio doesn't retry
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  // Handle SMS asynchronously
  handleIncomingSms(from, to, body).catch((err) => {
    console.error('[Server] SMS handler error:', err);
  });
});

// Store caller info keyed by callSid so the WebSocket session can look it up
const callerMap = new Map<string, string>();

// Twilio webhook — returns TwiML to connect the call to our Media Stream
app.post('/voice', (req, res) => {
  const host = config.server.publicUrl || `${req.protocol}://${req.get('host')}`;
  const wsUrl = host.replace(/^https?/, 'wss') + '/stream';

  const callerNumber = req.body?.From ?? req.body?.Caller ?? '';
  const callSid = req.body?.CallSid ?? '';
  if (callSid && callerNumber) {
    callerMap.set(callSid, callerNumber);
    // Clean up after 5 minutes
    setTimeout(() => callerMap.delete(callSid), 5 * 60 * 1000);
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Hello, how can I help you today?</Say>
  <Connect>
    <Stream url="${wsUrl}"/>
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
  console.log(`[Server] TwiML served for call ${callSid} from ${callerNumber}, stream URL: ${wsUrl}`);
});

// Create HTTP server and attach WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws: WebSocket) => {
  console.log('[Server] New WebSocket connection');
  const session = new CallSession(ws);

  session.initialize().catch((err) => {
    console.error('[Server] Failed to initialize session:', err);
    ws.close();
  });

  ws.on('message', (data) => {
    const raw = data.toString();
    // Intercept start event to look up caller number
    try {
      const msg = JSON.parse(raw);
      if (msg.event === 'start' && msg.start?.callSid) {
        const caller = callerMap.get(msg.start.callSid);
        if (caller) session.setCallerNumber(caller);
      }
    } catch { /* handled in session */ }

    session.handleMessage(raw).catch((err) => {
      console.error('[Server] Error handling message:', err);
    });
  });

  ws.on('close', () => {
    console.log('[Server] WebSocket closed');
    session.destroy();
  });

  ws.on('error', (err) => {
    console.error('[Server] WebSocket error:', err);
    session.destroy();
  });
});

server.listen(config.server.port, () => {
  console.log(`[Server] Tavis voice server running on port ${config.server.port}`);
  console.log(`[Server] Health: http://localhost:${config.server.port}/health`);
  if (config.server.publicUrl) {
    console.log(`[Server] Public URL: ${config.server.publicUrl}`);
    console.log(`[Server] Twilio webhook: ${config.server.publicUrl}/voice`);
  }
});

export { app, server };
