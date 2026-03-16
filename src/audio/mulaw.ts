// µ-law (G.711) encode/decode
// Twilio Media Streams sends and expects 8kHz µ-law audio

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/**
 * Decode a µ-law encoded buffer to 16-bit PCM samples.
 * Twilio sends µ-law 8kHz audio in Media Stream messages.
 */
export function mulawDecode(buffer: Buffer): Int16Array {
  const samples = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    let ulaw = ~buffer[i] & 0xff;
    const sign = ulaw & 0x80;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0f;
    let sample = ((mantissa << 1) + 33) << exponent;
    sample -= MULAW_BIAS;
    samples[i] = sign !== 0 ? -sample : sample;
  }
  return samples;
}

/**
 * Encode 16-bit PCM samples to µ-law.
 * Twilio expects µ-law 8kHz audio for outbound Media Stream messages.
 */
export function mulawEncode(samples: Int16Array): Buffer {
  const buffer = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let sample = samples[i];
    const sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;
    if (sample > MULAW_CLIP) sample = MULAW_CLIP;
    sample += MULAW_BIAS;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    buffer[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return buffer;
}
