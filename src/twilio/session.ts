// Per-call WebSocket session — manages the full call state machine
//
// State machine:
//   LISTENING  → PROCESSING → SPEAKING → LISTENING
//
//   LISTENING:  Buffer caller audio; VAD detects end-of-utterance (silenceMs) → PROCESSING
//   PROCESSING: POST audio to voice pipeline → SPEAKING
//   SPEAKING:   Stream TTS to Twilio; barge-in or natural end → LISTENING

import { WebSocket } from 'ws';
import { mulawDecode } from '../audio/mulaw';
import { BargeInDetector } from '../barge-in/detector';
import { SileroVAD } from '../vad/silero-vad';
import { RNNoiseProcessor } from '../noise/rnnoise';
import { sendToPipeline } from '../pipeline/client';
import { TTSStreamer } from '../tts/streamer';
import { config } from '../config';

type SessionState = 'LISTENING' | 'PROCESSING' | 'SPEAKING';

// Number of consecutive speech-end events required to trigger end-of-utterance
const SILENCE_FRAMES_REQUIRED = Math.ceil(config.vad.silenceMs / config.vad.frameMs);

export class CallSession {
  private ws: WebSocket;
  private callSid = '';
  private streamSid = '';
  private state: SessionState = 'LISTENING';

  private vad: SileroVAD;
  private rnnoise: RNNoiseProcessor;
  private bargeInDetector: BargeInDetector;

  // Audio accumulation for utterance detection
  private utteranceBuffer: Int16Array[] = [];
  private silenceFrameCount = 0;
  private hasSpeech = false;

  private streamer: TTSStreamer | null = null;
  // Set to true if barge-in fires during PROCESSING so we discard the response
  private processingAborted = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.vad = new SileroVAD();
    this.rnnoise = new RNNoiseProcessor();
    this.bargeInDetector = new BargeInDetector(this.vad, this.rnnoise);

    this.bargeInDetector.on('barge-in', () => this.handleBargeIn());
    this.bargeInDetector.on('speech-start', () => {
      console.log(`[Session ${this.callSid}] Speech detected`);
      this.hasSpeech = true;
      this.silenceFrameCount = 0;
    });
    this.bargeInDetector.on('speech-end', () => this.handleSpeechEnd());
  }

  async initialize(): Promise<void> {
    await this.vad.initialize();
    await this.rnnoise.initialize();
    console.log(`[Session] Initialized (VAD threshold: ${config.vad.confidenceThreshold})`);
  }

  /**
   * Handle an incoming Twilio Media Streams WebSocket message.
   */
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
    console.log(`[Session ${this.callSid}] Stream started`);
  }

  private async handleMedia(msg: Record<string, unknown>): Promise<void> {
    const media = msg.media as Record<string, string> | undefined;
    if (!media?.payload) return;

    const buffer = Buffer.from(media.payload, 'base64');
    const samples = mulawDecode(buffer);

    if (this.state === 'LISTENING') {
      this.utteranceBuffer.push(samples);
      await this.bargeInDetector.feed(samples);
    } else if (this.state === 'SPEAKING') {
      // Monitor for barge-in during TTS playback
      await this.bargeInDetector.feed(samples);
    }
    // PROCESSING state: discard inbound audio
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
      // Mark so processUtterance discards the response when it arrives
      console.log(`[Session ${this.callSid}] Barge-in during PROCESSING — will discard response`);
      this.processingAborted = true;
    }
  }

  private handleStop(): void {
    console.log(`[Session ${this.callSid}] Stream stopped`);
    this.destroy();
  }

  private endUtterance(): void {
    if (this.state !== 'LISTENING') return;

    const totalSamples = this.utteranceBuffer.reduce(
      (sum, buf) => sum + buf.length, 0
    );
    if (totalSamples === 0) return;

    console.log(`[Session ${this.callSid}] Utterance ended (${totalSamples} samples)`);

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
      // Reset barge-in detector so it starts fresh for barge-in monitoring
      this.bargeInDetector.reset();
    }
  }

  destroy(): void {
    this.streamer?.stopImmediate();
    this.streamer = null;
    this.bargeInDetector.destroy();
    console.log(`[Session ${this.callSid}] Destroyed`);
  }
}
