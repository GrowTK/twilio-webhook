// Per-call WebSocket session — manages the full call state machine
//
// State machine:
//   LISTENING  → PROCESSING → SPEAKING → LISTENING

import { WebSocket } from 'ws';
import { mulawDecode } from '../audio/mulaw';
import { BargeInDetector } from '../barge-in/detector';
import { sendToPipeline } from '../pipeline/client';
import { TTSStreamer } from '../tts/streamer';
import { config } from '../config';

type SessionState = 'LISTENING' | 'PROCESSING' | 'SPEAKING';

const SILENCE_FRAMES_REQUIRED = Math.ceil(config.vad.silenceMs / config.vad.frameMs);

// Fallback: if VAD never detects speech, send accumulated audio after this many ms
const FALLBACK_SEND_MS = 5000;

export class CallSession {
  private ws: WebSocket;
  private callSid = '';
  private streamSid = '';
  private state: SessionState = 'LISTENING';

  private bargeInDetector: BargeInDetector;

  private utteranceBuffer: Int16Array[] = [];
  private silenceFrameCount = 0;
  private hasSpeech = false;
  private mediaCount = 0;

  private streamer: TTSStreamer | null = null;
  private processingAborted = false;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.bargeInDetector = new BargeInDetector(null, null);

    this.bargeInDetector.on('barge-in', () => this.handleBargeIn());
    this.bargeInDetector.on('speech-start', () => {
      console.log(`[Session ${this.callSid}] Speech detected`);
      this.hasSpeech = true;
      this.silenceFrameCount = 0;
    });
    this.bargeInDetector.on('speech-end', () => this.handleSpeechEnd());
  }

  async initialize(): Promise<void> {
    console.log(`[Session] Initialized (energy-based VAD)`);
  }

  async handleMessage(data: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.event) {
      case 'start':
        this.handleStart(msg);
        break;
      case 'media':
        await this.handleMedia(msg);
        break;
      case 'stop':
        this.handleStop();
        break;
    }
  }

  private handleStart(msg: Record<string, unknown>): void {
    const start = msg.start as Record<string, string> | undefined;
    if (start) {
      this.callSid = start.callSid ?? '';
      this.streamSid = start.streamSid ?? '';
    }
    console.log(`[Session ${this.callSid}] Stream started (streamSid: ${this.streamSid})`);

    // Start fallback timer: if VAD never triggers, send whatever we have after 5s
    this.fallbackTimer = setTimeout(() => {
      if (this.state === 'LISTENING' && this.utteranceBuffer.length > 0) {
        console.log(`[Session ${this.callSid}] Fallback timer fired — sending ${this.mediaCount} accumulated frames to pipeline`);
        this.endUtterance();
      }
    }, FALLBACK_SEND_MS);
  }

  private async handleMedia(msg: Record<string, unknown>): Promise<void> {
    const media = msg.media as Record<string, string> | undefined;
    if (!media?.payload) return;

    // Only process inbound (caller) audio — ignore outbound track
    if (media.track && media.track !== 'inbound') return;

    this.mediaCount++;

    const buffer = Buffer.from(media.payload, 'base64');

    // Debug: log raw payload info for first few frames
    if (this.mediaCount <= 3) {
      const firstBytes = Array.from(buffer.slice(0, 8)).map((b: number) => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`[Session ${this.callSid}] Media #${this.mediaCount}: track=${media.track ?? 'none'} payloadLen=${buffer.length} firstBytes=[${firstBytes}]`);
    }

    const samples = mulawDecode(buffer);

    if (this.state === 'LISTENING') {
      this.utteranceBuffer.push(samples);
      await this.bargeInDetector.feed(samples);
    } else if (this.state === 'SPEAKING') {
      await this.bargeInDetector.feed(samples);
    }
  }

  private handleSpeechEnd(): void {
    if (this.state !== 'LISTENING') return;

    this.silenceFrameCount++;
    if (this.hasSpeech && this.silenceFrameCount >= SILENCE_FRAMES_REQUIRED) {
      this.endUtterance();
    }
  }

  private handleBargeIn(): void {
    if (this.state === 'SPEAKING') {
      console.log(`[Session ${this.callSid}] Barge-in detected — stopping TTS`);
      this.streamer?.stopGracefully();
    } else if (this.state === 'PROCESSING') {
      console.log(`[Session ${this.callSid}] Barge-in during PROCESSING — will discard response`);
      this.processingAborted = true;
    }
  }

  private handleStop(): void {
    console.log(`[Session ${this.callSid}] Stream stopped (received ${this.mediaCount} media frames)`);
    this.destroy();
  }

  private endUtterance(): void {
    if (this.state !== 'LISTENING') return;
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }

    const totalSamples = this.utteranceBuffer.reduce(
      (sum, buf) => sum + buf.length, 0
    );
    if (totalSamples === 0) return;

    console.log(`[Session ${this.callSid}] Utterance ended (${totalSamples} samples, ${this.mediaCount} frames)`);

    const merged = new Int16Array(totalSamples);
    let offset = 0;
    for (const buf of this.utteranceBuffer) {
      merged.set(buf, offset);
      offset += buf.length;
    }

    this.bargeInDetector.reset();
    this.setState('PROCESSING');

    this.processUtterance(merged).catch((err) => {
      console.error(`[Session ${this.callSid}] Pipeline error:`, err);
      this.setState('LISTENING');
    });
  }

  private async processUtterance(samples: Int16Array): Promise<void> {
    this.processingAborted = false;

    let response;
    try {
      response = await sendToPipeline(samples, this.callSid);
    } catch (err) {
      console.error(`[Session ${this.callSid}] Pipeline request failed:`, err);
      this.setState('LISTENING');
      return;
    }

    if (this.processingAborted) {
      console.log(`[Session ${this.callSid}] Discarding pipeline response (barge-in)`);
      this.setState('LISTENING');
      return;
    }

    if (!response.audio) {
      console.warn(`[Session ${this.callSid}] Pipeline returned no audio`);
      this.setState('LISTENING');
      return;
    }

    console.log(`[Session ${this.callSid}] Pipeline returned audio (${response.audio.length} chars base64)`);
    this.setState('SPEAKING');
    this.streamResponse(response.audio);
  }

  private streamResponse(audioBase64: string): void {
    this.streamer = new TTSStreamer(this.ws, this.streamSid);
    this.streamer.load(audioBase64);

    this.streamer.on('done', (reason: string) => {
      console.log(`[Session ${this.callSid}] TTS done (${reason})`);
      this.streamer = null;
      this.setState('LISTENING');
    });

    this.streamer.start();
  }

  private setState(state: SessionState): void {
    console.log(`[Session ${this.callSid}] ${this.state} → ${state}`);
    this.state = state;

    if (state === 'LISTENING') {
      this.utteranceBuffer = [];
      this.silenceFrameCount = 0;
      this.hasSpeech = false;
      this.bargeInDetector.reset();
    }

    if (state === 'SPEAKING') {
      this.bargeInDetector.reset();
    }
  }

  destroy(): void {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    this.streamer?.stopImmediate();
    this.streamer = null;
    this.bargeInDetector.destroy();
    console.log(`[Session ${this.callSid}] Destroyed`);
  }
}
