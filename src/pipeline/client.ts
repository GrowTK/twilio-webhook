// Voice pipeline client — POSTs audio to external AI voice pipeline
// Returns base64-encoded audio of the AI response

import axios from 'axios';
import { config } from '../config';
import { mulawEncode } from '../audio/mulaw';

export interface PipelineResponse {
  audio: string;       // base64-encoded µ-law 8kHz audio
  contentType?: string;
}

/**
 * Send caller audio to the voice pipeline and receive AI response audio.
 *
 * @param audioSamples - 16-bit PCM samples at 8kHz
 * @param callSid - Twilio call SID for correlation
 */
export async function sendToPipeline(
  audioSamples: Int16Array,
  callSid: string
): Promise<PipelineResponse> {
  if (!config.pipeline.url) {
    throw new Error('VOICE_PIPELINE_URL is not configured');
  }

  const mulawBuffer = mulawEncode(audioSamples);
  const audioBase64 = mulawBuffer.toString('base64');

  const response = await axios.post<PipelineResponse>(
    config.pipeline.url,
    { audio: audioBase64 },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.pipeline.apiKey,
      },
      timeout: config.pipeline.timeoutMs,
    }
  );

  return response.data;
}
