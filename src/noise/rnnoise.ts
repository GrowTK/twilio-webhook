// RNNoise WASM wrapper for noise suppression
// Uses @shiguredo/rnnoise-wasm — clean Node.js-compatible WASM build
//
// Input: Float32Array scaled as 16-bit PCM values ([-32768, 32767])
// Output: denoised Float32Array + VAD probability
//
// RNNoise processes exactly 480 samples (10ms @ 48kHz) per frame.

import { config } from '../config';

export interface RNNoiseResult {
  denoised: Float32Array;
  vadProbability: number;
}

// RNNoise processes 480 samples (10ms @ 48kHz)
export const RNNOISE_FRAME_SIZE = 480;

// Lazy-loaded module and per-session state types (avoid top-level async)
type RnnoiseModule = import('@shiguredo/rnnoise-wasm').Rnnoise;
type DenoiseState = import('@shiguredo/rnnoise-wasm').DenoiseState;

let rnnoiseModule: RnnoiseModule | null = null;
let loadPromise: Promise<void> | null = null;

async function loadRNNoise(): Promise<void> {
  if (rnnoiseModule) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
    rnnoiseModule = await Rnnoise.load();
  })();

  return loadPromise;
}

export class RNNoiseProcessor {
  private state: DenoiseState | null = null;
  private ready = false;

  async initialize(): Promise<void> {
    if (!config.rnnoise.enabled) return;
    await loadRNNoise();
    if (rnnoiseModule) {
      this.state = rnnoiseModule.createDenoiseState();
      this.ready = true;
    }
  }

  /**
   * Process a 480-sample (10ms @ 48kHz) frame through RNNoise.
   *
   * @param input Float32Array of 480 samples, scaled as 16-bit PCM ([-32768, 32767])
   * @returns denoised Float32Array (same scale) and VAD probability [0..1]
   */
  processFrame(input: Float32Array): RNNoiseResult {
    if (!this.ready || !this.state) {
      return { denoised: input, vadProbability: 1.0 };
    }

    if (input.length !== RNNOISE_FRAME_SIZE) {
      throw new Error(
        `RNNoise expects exactly ${RNNOISE_FRAME_SIZE} samples, got ${input.length}`
      );
    }

    // @shiguredo/rnnoise-wasm expects 16-bit PCM scale ([-32768, 32767])
    // Scale normalized [-1, 1] input up, then normalize output back down
    const frame = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      frame[i] = input[i] * 32768.0;
    }

    const vadProbability = this.state.processFrame(frame);

    // Normalize denoised output back to [-1, 1]
    const denoised = new Float32Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      denoised[i] = frame[i] / 32768.0;
    }

    return { denoised, vadProbability };
  }

  destroy(): void {
    if (this.state) {
      this.state.destroy();
      this.state = null;
      this.ready = false;
    }
  }
}
