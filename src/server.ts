import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { config } from './config';
import { CallSession } from './twilio/session';

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

// Twilio webhook — returns TwiML to connect the call to our Media Stream
app.post('/voice', (req, res) => {
  const host = config.server.publicUrl || `${req.protocol}://${req.get('host')}`;
  const wsUrl = host.replace(/^https?/, 'wss') + '/stream';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}"/>
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
  console.log(`[Server] TwiML served for call, stream URL: ${wsUrl}`);
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
    session.handleMessage(data.toString()).catch((err) => {
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
