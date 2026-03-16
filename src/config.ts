import 'dotenv/config';

export const config = {
  vad: {
    confidenceThreshold: parseFloat(process.env.VAD_CONFIDENCE_THRESHOLD ?? '0.5'),
    holdOffMs: parseInt(process.env.VAD_HOLD_OFF_MS ?? '350'),   // 300-500ms sustained speech
    silenceMs: parseInt(process.env.VAD_SILENCE_MS ?? '600'),    // ms silence = end of utterance
    frameMs: 32,                                                   // Silero frame = 512 samples @ 16kHz
  },
  rnnoise: {
    enabled: process.env.RNNOISE_ENABLED !== 'false',
    vadThreshold: parseFloat(process.env.RNNOISE_VAD_THRESHOLD ?? '0.1'),
  },
  bargeIn: {
    cooldownMs: parseInt(process.env.BARGE_IN_COOLDOWN_MS ?? '500'),
    wordBoundarySilenceMs: 40,
  },
  pipeline: {
    url: process.env.VOICE_PIPELINE_URL ?? '',
    // Strip "x-api-key: " prefix if present in the env value
    apiKey: (process.env.VOICE_PIPELINE_API_KEY ?? '').replace(/^x-api-key:\s*/i, ''),
    timeoutMs: 10000,
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    phoneNumber: process.env.TWILIO_PHONE_NUMBER ?? '',
  },
  server: {
    port: parseInt(process.env.PORT ?? '3000'),
    publicUrl: process.env.PUBLIC_URL ?? '',
  },
};
