// TTS audio streamer — streams AI response audio to Twilio WebSocket
// Supports graceful word-boundary stopping for barge-in

import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { config } from '../config';
import { mulawDecode, mulawEncode } from '../audio/mulaw';

// 20ms chunks at 8kHz = 160 samples per chunk
const CHUNK_SAMPLES = 160;
// Silence threshold for word-boundary detection (amplitude)
const SILENCE_AMPLITUDE_THRESHOLD = 300;
// Silence duration required to count as a word boundary (in samples at 8kHz)
const WORD_BOUNDARY_SAMPLES = Math.floor(
  (config.bargeIn.wordBoundarySilenceMs / 1000) * 8000
);
// Max look-ahead in samples before forcing a stop (200ms)
const MAX_LOOKAHEAD_SAMPLES = Math.floor(0.2 * 8000);

export class TTSStreamer extends EventEmitter {
  private ws: WebSocket;
  private streamSid: string;
  private chunks: Int16Array[] = [];
  private stopPending = false;
  private playing = false;
  private sendTimer: ReturnType<typeof setInterval> | null = null;
  private chunkIndex = 0;

  constructor(ws: WebSocket, streamSid: string) {
    super();
    this.ws = ws;
    this.streamSid = streamSid;
  }

  /**
   * Load base64-encoded µ-law audio and prepare for streaming.
   */
  load(audioBase64: string): void {
    const buffer = Buffer.from(audioBase64, 'base64');
    const samples = mulawDecode(buffer);

    // Split into 20ms chunks
    this.chunks = [];
    for (let i = 0; i < samples.length; i += CHUNK_SAMPLES) {
      this.chunks.push(samples.slice(i, i + CHUNK_SAMPLES));
    }
    this.chunkIndex = 0;
    this.stopPending = false;
  }

  /**
   * Start streaming audio to Twilio at 20ms intervals.
   */
  start(): void {
    if (this.playing) return;
    this.playing = true;

    // Send chunks at 20ms intervals (real-time rate for 8kHz audio)
    this.sendTimer = setInterval(() => this.sendNextChunk(), 20);
  }

  private sendNextChunk(): void {
    if (this.chunkIndex >= this.chunks.length) {
      this.stop('natural');
      return;
    }

    if (this.stopPending) {
      // Look ahead for a word boundary within MAX_LOOKAHEAD_SAMPLES
      const stopAt = this.findWordBoundary();
      if (this.chunkIndex >= stopAt) {
        this.stop('graceful');
        return;
      }
    }

    const chunk = this.chunks[this.chunkIndex++];
    this.sendChunk(chunk);
  }

  /**
   * Find the index of the next chunk that starts a silence gap (word boundary).
   * Searches up to MAX_LOOKAHEAD_SAMPLES ahead of current position.
   */
  private findWordBoundary(): number {
    const lookaheadChunks = Math.ceil(MAX_LOOKAHEAD_SAMPLES / CHUNK_SAMPLES);
    const endSearch = Math.min(
      this.chunkIndex + lookaheadChunks,
      this.chunks.length
    );

    let silentSamples = 0;

    for (let i = this.chunkIndex; i < endSearch; i++) {
      const chunk = this.chunks[i];
      const isSilent = isSilentChunk(chunk, SILENCE_AMPLITUDE_THRESHOLD);

      if (isSilent) {
        silentSamples += chunk.length;
        if (silentSamples >= WORD_BOUNDARY_SAMPLES) {
          return i; // Stop at start of this silent chunk
        }
      } else {
        silentSamples = 0;
      }
    }

    // No boundary found within look-ahead — stop at look-ahead limit
    return endSearch;
  }

  private sendChunk(chunk: Int16Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.stop('natural');
      return;
    }

    const mulawChunk = mulawEncode(chunk);
    const payload = {
      event: 'media',
      streamSid: this.streamSid,
      media: {
        payload: mulawChunk.toString('base64'),
      },
    };

    this.ws.send(JSON.stringify(payload));
  }

  /**
   * Signal the streamer to stop at the next word boundary.
   * Will continue sending until a silence gap is found (up to 200ms look-ahead).
   */
  stopGracefully(): void {
    if (!this.playing) return;
    this.stopPending = true;
  }

  private stop(reason: 'natural' | 'graceful'): void {
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
    this.playing = false;
    this.stopPending = false;
    this.chunks = [];
    this.chunkIndex = 0;
    this.emit('done', reason);
  }

  /**
   * Immediately halt all streaming without word-boundary search.
   */
  stopImmediate(): void {
    this.stop('graceful');
  }

  isPlaying(): boolean {
    return this.playing;
  }
}

function isSilentChunk(chunk: Int16Array, threshold: number): boolean {
  for (let i = 0; i < chunk.length; i++) {
    if (Math.abs(chunk[i]) > threshold) return false;
  }
  return true;
}
