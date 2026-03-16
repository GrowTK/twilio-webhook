// RNNoise noise suppression — stubbed out.
// @shiguredo/rnnoise-wasm is ESM-only and incompatible with this CommonJS build.
// Silero VAD handles barge-in detection independently without needing RNNoise.

export interface RNNoiseResult {
  denoised: Float32Array;
  vadProbability: number;
}

export const RNNOISE_FRAME_SIZE = 480;

export class RNNoiseProcessor {
  async initialize(): Promise<void> {
    // no-op — RNNoise disabled
  }

  processFrame(input: Float32Array): RNNoiseResult {
    return { denoised: input, vadProbability: 1.0 };
  }

  destroy(): void {
    // no-op
  }
}
