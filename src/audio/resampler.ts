// Linear interpolation resamplers — no external dependencies

/**
 * Resample 8kHz PCM to 16kHz PCM (2x upsample).
 * Used to prepare audio for Silero VAD which expects 16kHz.
 */
export function resample8to16(samples: Int16Array): Int16Array {
  const out = new Int16Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    out[i * 2] = samples[i];
    if (i < samples.length - 1) {
      out[i * 2 + 1] = Math.round((samples[i] + samples[i + 1]) / 2);
    } else {
      out[i * 2 + 1] = samples[i];
    }
  }
  return out;
}

/**
 * Resample 8kHz PCM to 48kHz PCM (6x upsample).
 * Used to prepare audio for RNNoise which expects 48kHz.
 */
export function resample8to48(samples: Int16Array): Int16Array {
  const factor = 6;
  const out = new Int16Array(samples.length * factor);
  for (let i = 0; i < samples.length; i++) {
    const curr = samples[i];
    const next = i < samples.length - 1 ? samples[i + 1] : curr;
    for (let j = 0; j < factor; j++) {
      out[i * factor + j] = Math.round(curr + (next - curr) * (j / factor));
    }
  }
  return out;
}

/**
 * Resample 48kHz Float32 PCM to 16kHz Float32 PCM (3x downsample).
 * Used after RNNoise to feed Silero VAD.
 */
export function resample48to16(samples: Float32Array): Float32Array {
  const factor = 3;
  const outLen = Math.floor(samples.length / factor);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    // Average three consecutive samples for a simple low-pass + downsample
    const base = i * factor;
    out[i] = (samples[base] + samples[base + 1] + samples[base + 2]) / 3;
  }
  return out;
}

/**
 * Convert Int16Array PCM to Float32Array normalized to [-1, 1].
 */
export function int16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] / 32768.0;
  }
  return out;
}

/**
 * Convert Float32Array normalized PCM to Int16Array.
 */
export function float32ToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}
