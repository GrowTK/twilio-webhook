// Simple energy-based VAD for phone audio
// Detects speech when RMS amplitude exceeds threshold
// Much more reliable than Silero for 8kHz mulaw phone audio

import { config } from '../config';

export interface VADResult {
  probability: number;
  isSpeech: boolean;
}

// RMS threshold for speech detection on phone audio (normalized float [-1, 1])
const SPEECH_RMS_THRESHOLD = 0.008;

export class EnergyVAD {
  async initialize(): Promise<void> {
    console.log('[EnergyVAD] Initialized');
  }

  processFrame(samples: Float32Array): VADResult {
    // Calculate RMS energy
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSquares += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSquares / samples.length);

    // Map RMS to 0-1 probability (rough mapping)
    const probability = Math.min(1.0, rms / 0.05);
    const isSpeech = rms > SPEECH_RMS_THRESHOLD;

    return { probability, isSpeech };
  }

  resetState(): void {
    // no state to reset
  }
}
