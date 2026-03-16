// Barge-in detector: RNNoise → Silero VAD pipeline with hold-off and hysteresis
// Processes 32ms frames (512 samples @ 16kHz = 480 samples @ 48kHz via RNNoise)

import { EventEmitter } from 'events';
import { config } from '../config';
import { SileroVAD, SILERO_FRAME_SIZE } from '../vad/silero-vad';
import { RNNoiseProcessor, RNNOISE_FRAME_SIZE } from '../noise/rnnoise';
import {
  resample8to48,
  resample48to16,
  resample8to16,
  int16ToFloat32,
} from '../audio/resampler';

// How many 32ms Silero frames equal holdOffMs
// holdOffMs / 32ms = required consecutive voice frames
const SILERO_FRAME_MS = 32;

export interface BargeInDetectorEvents {
  'barge-in': () => void;
  'speech-start': () => void;
  'speech-end': () => void;
}

export class BargeInDetector extends EventEmitter {
  private vad: SileroVAD;
  private rnnoise: RNNoiseProcessor;

  private consecutiveVadFrames = 0;
  private cooldownActive = false;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;

  // Buffer for accumulating sub-frame audio (8kHz samples)
  private audioBuffer: Int16Array = new Int16Array(0);
  // Silero frame at 8kHz: 512 samples @ 16kHz → 256 samples @ 8kHz
  private readonly frameSize8k = SILERO_FRAME_SIZE / 2; // 256 samples

  constructor(vad: SileroVAD, rnnoise: RNNoiseProcessor) {
    super();
    this.vad = vad;
    this.rnnoise = rnnoise;
  }

  /**
   * Feed raw 8kHz µ-law-decoded PCM samples from Twilio.
   * Internally accumulates until a full Silero frame is available.
   */
  async feed(samples8k: Int16Array): Promise<void> {
    // Append to buffer
    const combined = new Int16Array(this.audioBuffer.length + samples8k.length);
    combined.set(this.audioBuffer);
    combined.set(samples8k, this.audioBuffer.length);
    this.audioBuffer = combined;

    // Process all available complete frames
    while (this.audioBuffer.length >= this.frameSize8k) {
      const frame8k = this.audioBuffer.slice(0, this.frameSize8k);
      this.audioBuffer = this.audioBuffer.slice(this.frameSize8k);
      await this.processFrame(frame8k);
    }
  }

  private async processFrame(frame8k: Int16Array): Promise<void> {
    let vadInput16k: Float32Array;

    if (config.rnnoise.enabled) {
      // 1. Upsample 8kHz → 48kHz for RNNoise
      const frame48k_int16 = resample8to48(frame8k);
      const frame48k_float = int16ToFloat32(frame48k_int16);

      // 2. RNNoise processes 480-sample frames — pad/trim as needed
      const rnnoiseFrames = this.splitIntoRNNoiseFrames(frame48k_float);
      let denoisedFrames: Float32Array[] = [];
      let rnnoiseVadProb = 0;

      for (const rnFrame of rnnoiseFrames) {
        const result = this.rnnoise.processFrame(rnFrame);
        denoisedFrames.push(result.denoised);
        // Take max VAD probability across sub-frames
        rnnoiseVadProb = Math.max(rnnoiseVadProb, result.vadProbability);
      }

      // 3. First-stage gate: if RNNoise says no voice, skip Silero
      if (rnnoiseVadProb < config.rnnoise.vadThreshold) {
        this.consecutiveVadFrames = 0;
        return;
      }

      // 4. Merge RNNoise frames and downsample 48kHz → 16kHz for Silero
      const merged48k = mergeFloat32Arrays(denoisedFrames);
      vadInput16k = resample48to16(merged48k);
    } else {
      // No RNNoise — just upsample 8kHz → 16kHz
      const frame16k_int16 = resample8to16(frame8k);
      vadInput16k = int16ToFloat32(frame16k_int16);
    }

    // 5. Pad or trim to exact Silero frame size (512 samples)
    const sileroFrame = padOrTrim(vadInput16k, SILERO_FRAME_SIZE);

    // Debug: log max amplitude to verify audio is present
    let maxAmp = 0;
    for (let i = 0; i < sileroFrame.length; i++) {
      if (Math.abs(sileroFrame[i]) > maxAmp) maxAmp = Math.abs(sileroFrame[i]);
    }

    // 6. Run Silero VAD
    const { probability } = await this.vad.processFrame(sileroFrame);
    console.log(`[VAD] probability=${probability.toFixed(3)} maxAmp=${maxAmp.toFixed(4)} threshold=${config.vad.confidenceThreshold}`);

    // 7. Apply hold-off hysteresis
    if (probability >= config.vad.confidenceThreshold) {
      this.consecutiveVadFrames++;
      const requiredFrames = Math.ceil(config.vad.holdOffMs / SILERO_FRAME_MS);

      if (this.consecutiveVadFrames === 1) {
        this.emit('speech-start');
      }

      if (this.consecutiveVadFrames >= requiredFrames && !this.cooldownActive) {
        this.triggerBargeIn();
      }
    } else {
      if (this.consecutiveVadFrames > 0) {
        this.emit('speech-end');
      }
      this.consecutiveVadFrames = 0;
    }
  }

  private triggerBargeIn(): void {
    this.emit('barge-in');
    this.cooldownActive = true;

    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => {
      this.cooldownActive = false;
      this.cooldownTimer = null;
    }, config.bargeIn.cooldownMs);
  }

  /**
   * Split a Float32Array into 480-sample RNNoise frames.
   * Last incomplete frame is zero-padded.
   */
  private splitIntoRNNoiseFrames(samples: Float32Array): Float32Array[] {
    const frames: Float32Array[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const end = Math.min(offset + RNNOISE_FRAME_SIZE, samples.length);
      if (end - offset === RNNOISE_FRAME_SIZE) {
        frames.push(samples.slice(offset, end));
      } else {
        // Pad the last incomplete frame
        const padded = new Float32Array(RNNOISE_FRAME_SIZE);
        padded.set(samples.slice(offset, end));
        frames.push(padded);
      }
      offset += RNNOISE_FRAME_SIZE;
    }
    return frames;
  }

  reset(): void {
    this.consecutiveVadFrames = 0;
    this.cooldownActive = false;
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.audioBuffer = new Int16Array(0);
    this.vad.resetState();
  }

  destroy(): void {
    this.reset();
    this.rnnoise.destroy();
    this.removeAllListeners();
  }
}

function mergeFloat32Arrays(arrays: Float32Array[]): Float32Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function padOrTrim(samples: Float32Array, targetLength: number): Float32Array {
  if (samples.length === targetLength) return samples;
  if (samples.length > targetLength) return samples.slice(0, targetLength);
  const padded = new Float32Array(targetLength);
  padded.set(samples);
  return padded;
}
